#!/usr/bin/env bash
# The failure drills: what happens when the broker dies, when the payment
# service is killed mid-saga, and whether the documented seed and reset flows
# still work.
#
#   ./scripts/verify-failures.sh
#
# DESTRUCTIVE: it stops and starts containers, and finishes by running
# scripts/reset.sh, which empties Postgres and Redis. Do not point it at
# anything you care about.
# The failure behaviour the README claims, checked against the Java stack.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WRITE=http://localhost:4000
READ=http://localhost:4001
PASS=0; FAIL=0; FAILED=""
green(){ printf '\033[32m%s\033[0m' "$1"; }; red(){ printf '\033[31m%s\033[0m' "$1"; }
pass(){ printf '  %s   %s\n' "$(green ok)" "$1"; PASS=$((PASS+1)); }
fail(){ printf '  %s %s\n' "$(red FAIL)" "$1"; FAIL=$((FAIL+1)); FAILED="${FAILED}
  - $1"; }
eq(){ if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 :: expected [$1] got [$2]"; fi; }
phase(){ printf '\n\033[1m%s\033[0m\n' "$1"; }
psql_q(){ docker compose exec -T postgres psql -U payments -d payments -tAc "$1" 2>/dev/null | tr -d ' \r'; }

acct(){ curl -s -X POST "$WRITE/accounts" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$1\",\"initialBalanceCents\":$2}" | jq -r .id; }

phase "A. the documented run flow: ./scripts/seed.sh"
OUT=$(./scripts/seed.sh 2>&1)
echo "$OUT" | grep -q "Alice" && pass "seed.sh creates the demo wallets against the Java service" || fail "seed.sh output: $OUT"
COUNT=$(curl -s "$WRITE/accounts" | jq 'length')
[ "$COUNT" -ge 5 ] && pass "the wallets are there ($COUNT accounts)" || fail "only $COUNT accounts"

phase "B. kill the broker: payments keep working, the outbox drains after"
A=$(acct "R-Sender" 500000); B=$(acct "R-Receiver" 1000)
sleep 1
docker compose stop kafka >/dev/null 2>&1
sleep 2
BODY=$(curl -s -X POST "$WRITE/payments" -H 'Content-Type: application/json' \
  -d "{\"fromAccountId\":\"$A\",\"toAccountId\":\"$B\",\"amountCents\":1234}")
PID=$(echo "$BODY" | jq -r .id)
eq "PROCESSING" "$(echo "$BODY" | jq -r .status)" "a payment is still accepted with the broker down"
DONE=no
for i in $(seq 1 30); do
  S=$(curl -s "$WRITE/payments/$PID" | jq -r .status)
  [ "$S" = "COMPLETED" ] && { DONE=yes; break; }
  sleep 1
done
eq "yes" "$DONE" "and it settles: the saga does not need Kafka"
UNPUB=$(psql_q "SELECT count(*) FROM outbox WHERE published_at IS NULL;")
[ "$UNPUB" -ge 2 ] && pass "the events are waiting in the outbox ($UNPUB unpublished)" || fail "unpublished=$UNPUB, expected a backlog"
BALANCED=$(curl -s "$WRITE/ledger/trial-balance" | jq -r .balanced)
eq "true" "$BALANCED" "the books balance even with no broker"

docker compose start kafka >/dev/null 2>&1
DRAINED=no
for i in $(seq 1 90); do
  [ "$(psql_q "SELECT count(*) FROM outbox WHERE published_at IS NULL;")" = "0" ] && { DRAINED=yes; break; }
  sleep 2
done
eq "yes" "$DRAINED" "bring the broker back and the outbox drains by itself"
CAUGHT=no
for i in $(seq 1 60); do
  RB=$(curl -s "$WRITE/accounts/$B" | jq -r .balanceCents)
  PB=$(curl -s "$READ/accounts/$B/balance" | jq -r .balanceCents 2>/dev/null)
  [ "$RB" = "$PB" ] && { CAUGHT=yes; break; }
  sleep 2
done
eq "yes" "$CAUGHT" "and the read model catches up to the write side"

phase "C. kill the payment service mid-saga"
BODY=$(curl -s -X POST "$WRITE/payments" -H 'Content-Type: application/json' \
  -d "{\"fromAccountId\":\"$A\",\"toAccountId\":\"$B\",\"amountCents\":4321,\"simulate\":\"PERMANENT\"}")
PID2=$(echo "$BODY" | jq -r .id)
eq "PROCESSING" "$(echo "$BODY" | jq -r .status)" "a payment is in flight"
docker compose kill payment-service >/dev/null 2>&1
pass "the payment service is killed while the money is in clearing"
MID=$(psql_q "SELECT status FROM payments WHERE id = '$PID2';")
case "$MID" in PROCESSING|AWAITING_REFUND) pass "the row survives the crash as $MID" ;; *) fail "unexpected mid-crash status [$MID]" ;; esac
CLEARING=$(psql_q "SELECT balance_cents FROM accounts WHERE id = '00000000-0000-4000-8000-000000000001';")
[ "$CLEARING" -gt 0 ] && pass "the money is somewhere specific: clearing holds $CLEARING" || fail "clearing holds nothing mid-saga"
docker compose start payment-service >/dev/null 2>&1
for i in $(seq 1 40); do curl -s -o /dev/null "$WRITE/health" && break; sleep 2; done
RECOVERED=no
for i in $(seq 1 60); do
  S=$(curl -s "$WRITE/payments/$PID2" | jq -r .status 2>/dev/null)
  [ "$S" = "REFUNDED" ] && { RECOVERED=yes; break; }
  sleep 2
done
eq "yes" "$RECOVERED" "on restart the workers finish what was in flight, unprompted"
OK=no
for i in $(seq 1 40); do
  R=$(curl -s -X POST "$WRITE/reconciliation/run" | jq -r .status)
  [ "$R" = "OK" ] && { OK=yes; break; }
  sleep 2
done
eq "yes" "$OK" "and the books balance after the crash"

phase "D. the frontend's own request set"
call(){ curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$1"; }
ACC=$(curl -s "$WRITE/accounts" | jq -r '.[0].id')
IDS=$(curl -s "$WRITE/accounts" | jq -r '[.[].id] | join(",")')
eq 200 "$(call "$WRITE/health")" "wallet: write health ping"
eq 200 "$(call "$READ/health")" "wallet: read health ping"
eq 200 "$(call "$WRITE/accounts")" "wallet: friends list"
eq 200 "$(call "$WRITE/accounts?includeSystem=true")" "overview: accounts with system"
eq 200 "$(call "$WRITE/accounts/$ACC/limits")" "wallet: limits card"
eq 200 "$(call "$WRITE/payments/reviews?limit=200")" "overview: review queue"
eq 200 "$(call "$WRITE/payments?accountId=$ACC&limit=50")" "wallet: payments for one account"
eq 200 "$(call "$WRITE/ledger/trial-balance")" "ledger: trial balance"
eq 200 "$(call "$WRITE/ledger/journal?limit=50")" "ledger: journal"
eq 200 "$(call "$WRITE/ledger/accounts/$ACC?limit=100")" "ledger: statement"
eq 200 "$(call "$WRITE/reconciliation?limit=20")" "controls: reconciliation history"
eq 200 "$(call "$READ/balances?ids=$IDS")" "wallet: every balance in one call"
eq 200 "$(call "$READ/accounts/$ACC/transactions?limit=100")" "wallet: transaction list"
eq 200 "$(call "$READ/accounts/$ACC/stats")" "wallet: stats panel"
eq 200 "$(call "$READ/activity?limit=40")" "wallet: activity feed"
eq 200 "$(call "$READ/pipeline?limit=200")" "pipeline: measured traces"
eq 200 "$(call "$READ/kafka/overview")" "kafka: overview"
eq 200 "$(call "$READ/dlq?limit=10")" "kafka: dead letters"
eq 200 "$(call "http://localhost:8080/")" "the wallet UI is served"
eq 200 "$(call "http://localhost:8080/favicon.svg")" "and its assets"
BUNDLE=$(curl -s http://localhost:8080/ | grep -oE '/assets/[^"]+\.js' | head -1)
eq 200 "$(call "http://localhost:8080$BUNDLE")" "and its bundle"

phase "E. the documented reset flow"
OUT=$(COMPOSE="docker compose" ./scripts/reset.sh 2>&1)
echo "$OUT" | grep -q "clean" && pass "reset.sh empties both stores" || fail "reset.sh said: $(echo "$OUT" | tail -3)"
LEFT=$(curl -s "$WRITE/accounts" | jq 'length')
eq 0 "$LEFT" "no wallets are left"
SUM=$(psql_q "SELECT coalesce(sum(balance_cents),0) FROM accounts;")
eq 0 "$SUM" "and the books still sum to zero"
OK=no
for i in $(seq 1 20); do
  R=$(curl -s -X POST "$WRITE/reconciliation/run" | jq -r .status)
  [ "$R" = "OK" ] && { OK=yes; break; }
  sleep 2
done
eq "yes" "$OK" "the control is green on an empty system"

printf '\n\033[1m%s\033[0m\n' "summary"
printf '  passed: %s\n' "$(green "$PASS")"
if [ "$FAIL" -gt 0 ]; then printf '  failed: %s%s\n' "$(red "$FAIL")" "$FAILED"; exit 1; fi
printf '  failed: 0\n  %s\n' "$(green 'everything green')"
