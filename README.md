# LedgerFlow

An event-driven payments platform with a double-entry ledger, built around the
problem that makes real payment systems hard: **money has to leave one place
before it arrives at another, and anything can fail in between.**

Two services, a Kafka topic between them, and a wallet UI that shows the
architecture instead of hiding it.

```
   Wallet UI (:8080)
        │  writes            reads + live updates
        ▼                              ▲
  Payment service  ──── Kafka ────►  Ledger query service
     (:4000)          payment-events        (:4001)
  Postgres + Redis                     Redis read model
```

The two sides never call each other. The only thing between them is the topic.

## Run it

```bash
docker compose up --build
./scripts/seed.sh
open http://localhost:8080
```

| Page | What it shows |
| --- | --- |
| `/` | The wallet — send money, history, live balances |
| `/pipeline` | Measured pipeline latency, stage by stage |
| `/kafka` | Kafka: partitions, offsets, consumer lag, replay controls |

## The core idea: a payment is a saga, not a transfer

The obvious implementation debits the sender and credits the receiver in one
database transaction. That's safe — and it makes a whole class of real problems
impossible to demonstrate. Real payments cross a boundary, so a payment here is
**two transactions with a real gap between them**:

```
POST /payments   leg 1   sender   → CLEARING    status PROCESSING
                         (returns here — not finished)
settle worker    leg 2   CLEARING → receiver    status COMPLETED
                         or, if it fails:       status AWAITING_REFUND
compensate       leg 3   CLEARING → sender      status REFUNDED
```

Between the legs the money belongs to a **clearing account** — a real account
row, the same way a suspense account works in accounting. That's what makes it
safe rather than reckless: the money is never in limbo, it's somewhere
specific, and the ledger balances at every instant even mid-payment.

The invariant is checkable, and it's checked:

```
clearing balance == sum of all PROCESSING and AWAITING_REFUND payments
```

**Settlement retries before it compensates.** Most things that break between
services break briefly, so unwinding a good payment on the first hiccup is
wrong — but so is stranding money forever. Leg 2 retries with exponential
backoff and jitter, then gives the money back automatically.

**A refund is the compensating action, not an undo button.** It's only allowed
from `AWAITING_REFUND`. If the money arrived, there's nothing to recover — that
would be a new payment in the other direction.

## It cannot charge you twice

Three layers, because each one alone is insufficient:

1. **The client mints a key** per payment attempt, and rotates it when the
   payer, payee or amount changes. Stable across retries of one payment,
   different for a different payment.
2. **The server derives one** if the client sends none, by hashing the request
   content. An absent key used to mean no protection at all; a random one would
   differ on every retry and protect nobody.
3. **A `UNIQUE` constraint in Postgres** catches two identical requests racing
   past the cache at the same instant.

Reusing one key for a *different* payment returns `409`, rather than confidently
handing back an unrelated payment.

## The outbox, and exactly-once effects

"Save the payment, then publish the event" is a **dual write** — two systems, no
shared transaction. Crash in between and you get a payment nobody hears about,
or an event for a payment that rolled back.

So the event is written to an `outbox` table **inside the same transaction as
the business data**. A background poller publishes it separately with
`FOR UPDATE SKIP LOCKED`. Kill the broker and payments keep working; bring it
back and the outbox drains.

Delivery is at-least-once, so every event carries an id generated when it's
*enqueued* — a re-publish carries the same id, and the projection claims it
before touching a balance. Exactly-once *delivery* is impossible; exactly-once
*effect* is not, and the effect is the part that holds money.

## The read side

No Postgres. Balances, transaction history and statistics are all projected
from Kafka into Redis, pushed to browsers over Server-Sent Events, and can be
deleted and rebuilt from the log at any time — there's a button for it.

Every balance mutation is a **commutative delta**, which is what makes three
partitions safe: events for an account and events for a payment hash to
different partitions and have no ordering guarantee between them.

For a moment after a payment the two sides disagree. The UI says so out loud
rather than pretending CQRS is synchronous.

## Reconciliation

An account's balance column is a cache; the ledger is the truth. Nothing stops
them drifting apart, and a payments system that can't *detect* that will
eventually be quietly wrong.

Every 15 seconds an independent pass recomputes every balance from the ledger.
It catches a balance edited without a ledger entry, a journal that isn't a
balanced pair, clearing holding the wrong amount, and the read model
disagreeing with nothing in flight to explain it.

It's only possible because opening a wallet is itself a ledger entry —
`DEBIT funding / CREDIT wallet` — so every cent has a provenance and the system
is a closed set of books:

```sql
SELECT sum(balance_cents) FROM accounts;   -- must always be 0
```

## Stack

Java 21 · Spring Boot 3.5 · JdbcTemplate · Spring Kafka · Postgres 16 · Redis 7 ·
Kafka (KRaft) · Docker Compose. Frontend is React 18 + Vite, built to static
assets and served by nginx.

No JPA. Every statement in the write side was written for a reason — `SELECT
FOR UPDATE` in id order, `FOR UPDATE SKIP LOCKED`, `FILTER` aggregates cast to
`bigint` — and an ORM would either hide those or have to be argued with.

## API

**Payment service (`:4000`)** — commands, owns Postgres

```
POST /accounts                  GET /payments/:id      (incl. ledger legs)
GET  /accounts[/:id]            POST /payments/:id/refund
POST /payments                  GET  /reconciliation
GET  /payments                  POST /reconciliation/run
```

**Ledger query service (`:4001`)** — queries, Redis only

```
GET  /accounts/:id/balance      GET  /events/stream      (SSE)
GET  /accounts/:id/transactions GET  /kafka/overview
GET  /accounts/:id/stats        POST /kafka/consumer/{pause,resume,rebuild}
GET  /activity                  GET  /dlq
GET  /pipeline                  POST /dlq/:id/replay
```

`requests.http` covers the whole flow for the VS Code REST Client.

## Tests

```bash
cd services/payment-service      && ./mvnw test
cd services/ledger-query-service && ./mvnw test
```

127 unit tests, no infrastructure required — the money maths, the state machine,
the spending controls, the risk screen, the projection and the reconciliation
rules are pure functions in a `domain` package that imports no Spring, no JDBC,
no Redis and no Kafka. The projection is tested against an in-memory stand-in
for Redis, injected through the same interface the real client satisfies.

The Maven wrapper downloads Maven on first use, so a JDK 21+ is the only
prerequisite.

Beyond those, the system has been exercised against the live stack: every
validation boundary, concurrent racing payments and refunds, killing the
payment service mid-saga, killing Kafka mid-flight, killing Redis,
re-publishing events, feeding garbage to the topic, and rebuilding the read
model from scratch — asserting the books still balance after all of it.

## Deliberately left out

Authentication, a schema registry, an observability stack, and Kubernetes.
Each would add moving parts without demonstrating anything the core doesn't
already cover. Sign-in is a user picker; events are plain JSON so they stay
readable with `kafka-console-consumer`.

The known ceiling: every payment locks the single clearing account row, so
throughput is bounded by one row. Sharding the clearing account is the fix, and
it's marked in the code.
