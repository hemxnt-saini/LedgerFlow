# Deploying LedgerFlow

A public HTTPS URL with the whole stack intact — Kafka, the background workers
and the live event stream all behave exactly as they do locally.

---

## Why this needs a VM

Most portfolio projects are a frontend plus a stateless API, which is what the
free tiers are built for. This one is deliberately not that shape:

| It needs | Why the free PaaS tiers cannot |
| --- | --- |
| **Kafka** | No permanently-free managed Kafka exists. Upstash sunset theirs; Confluent and Aiven are trials. |
| **Always-on workers** | Three pollers — outbox 400 ms, saga 300 ms, reconciliation 15 s. Render and Koyeb free services sleep after 15 minutes idle, which stops all three. |
| **Long-lived SSE** | Serverless functions cap request duration, which kills the live feed. |
| **Six containers** | Free tiers typically allow one service. |

Concretely: **Heroku removed its free tier in 2022** (and managed Kafka there
starts around $100/month), **Vercel and Netlify** run static sites and short
functions, and **Render** sleeps, deletes free Postgres after 30 days, and
charges for background workers.

So: one small always-on VM. The two sensible choices:

| | Cost | Notes |
| --- | --- | --- |
| **Oracle Cloud Always Free** | £0 forever | **2 ARM cores, 12 GB RAM** (see the warning below). Card required at signup; ARM capacity is often unavailable in busy regions, so it can take a few attempts. |
| **Hetzner CX22 / DigitalOcean** | ~€4–6/month | x86, no capacity lottery, provisions in minutes. |

Anything with **2 GB RAM and 2 vCPUs** is comfortable. The container memory
limits in `docker-compose.prod.yml` total roughly 2.8 GB, and the stack idles
well under that.

> ### Oracle halved the free ARM allowance in 2026
>
> The Always Free Ampere allowance dropped from **4 OCPU / 24 GB** to
> **2 OCPU / 12 GB**, effective 15 June 2026, with enforcement from
> 18 August 2026. Oracle made no announcement — they edited the docs.
>
> **The console may still offer you 4 OCPU / 24 GB.** Taking it is the trap:
> the instance creates successfully and is then stopped for exceeding the
> allowance. Set the sliders to **2 OCPU and 12 GB** when you create it.
>
> This stack fits in 2/12 with room to spare, so the reduction costs you
> nothing here. The 200 GB block storage and 10 TB/month egress are unchanged.

---

## What you need before starting

1. A VM running **Ubuntu 22.04 or 24.04** with a public IP.
2. A **domain or subdomain**, with an **A record pointing at that IP**.
   A free option: [DuckDNS](https://www.duckdns.org) gives you
   `something.duckdns.org` in about a minute. A `.dev` or `.com` from
   Cloudflare or Namecheap is a few pounds a year and looks better on a CV.
3. Ports **80 and 443** open to the world. Nothing else needs to be.

> **Check DNS before you deploy.** Certificate issuance fails if the domain
> does not already resolve to the server.
> ```bash
> dig +short your-domain.com     # must print your server's IP
> ```

---

## Deploy

### The short version

Once the VM exists and DNS points at it, the whole server side is one command:

```bash
ssh ubuntu@YOUR_SERVER_IP
curl -fsSL https://raw.githubusercontent.com/hemxnt-saini/LedgerFlow/develop/deploy/bootstrap.sh -o bootstrap.sh
sudo bash bootstrap.sh ledgerflow.yourdomain.com you@example.com
```

It checks DNS before anything else, installs Docker, opens the host firewall
and persists the rules, clones the repo, writes `.env` with a generated
database password, deploys, schedules the nightly reset, and verifies the
result. Every step checks before acting, so re-running it is safe.

**It cannot open Oracle's VCN Security List** — that is a web console action,
covered in step 2b below. Do that first or the script's final check will fail
even though the stack is running correctly.

> **This one-liner needs the repository to be public.** `raw.githubusercontent`
> returns 404 for a private repo, and an unauthenticated `git clone` of one
> fails with an error indistinguishable from "no such repository".
>
> For a portfolio project, public is usually the point — an interviewer
> following the live URL will want the code. If you would rather keep it
> private, the script supports both alternatives:
>
> ```bash
> # a) read-only deploy key (Settings -> Deploy keys on the repo)
> ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519 && cat /root/.ssh/id_ed25519.pub
> REPO=git@github.com:hemxnt-saini/LedgerFlow.git sudo -E ./bootstrap.sh DOMAIN EMAIL
>
> # b) copy the tree up instead of cloning
> rsync -az --exclude node_modules --exclude .git ./ SERVER:/opt/ledgerflow/
> # then run bootstrap.sh on the server; it uses what is already there
> ```

The rest of this section is the same thing done by hand.

### 1. Install Docker on the server

```bash
ssh ubuntu@YOUR_SERVER_IP

curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # log out and back in for this to take effect
docker --version
```

### 2. Open the firewall

There are **two** firewalls on Oracle, and both have to be open. Missing
either one produces the same symptom — the site simply never responds — which
is why this step catches almost everyone out.

**a. The cloud firewall.** In the Oracle console: *Networking → Virtual Cloud
Networks → your VCN → Subnets → your subnet → Security List → Add Ingress
Rules*. Add two, both with source CIDR `0.0.0.0/0`, IP protocol TCP,
destination port `80` and `443`. Oracle blocks these at the network layer no
matter what the server says.

**b. The host firewall.** Oracle's Ubuntu images ship a pre-loaded iptables
ruleset that rejects everything except SSH, and `ufw` does not manage it —
enabling `ufw` on top leaves the original REJECT rule in place. Insert the
rules ahead of it instead:

```bash
iptables -I INPUT -p tcp --dport 80  -j ACCEPT
iptables -I INPUT -p tcp --dport 443 -j ACCEPT
apt-get install -y iptables-persistent   # prompts to save; answer yes
netfilter-persistent save
```

Confirm 80 and 443 appear *above* any REJECT line:

```bash
iptables -L INPUT -n --line-numbers
```

On Hetzner, DigitalOcean and most other images there is no preloaded ruleset,
and plain `ufw` is enough:

```bash
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

### 3. Get the code

```bash
git clone https://github.com/hemxnt-saini/LedgerFlow.git /opt/ledgerflow
cd /opt/ledgerflow
git checkout develop
```

### 4. Configure

```bash
cp deploy/.env.example .env
nano .env
```

Fill in all four values:

```bash
DOMAIN=ledgerflow.yourdomain.com     # must already resolve to this server
EMAIL=you@example.com                # required; Caddy will not start without it
POSTGRES_PASSWORD=                   # generate one: openssl rand -hex 24
DEMO_ENDPOINTS=true                  # see "Demo controls" below
```

> **Use `-hex`, not `-base64`.** The password is interpolated into
> `postgres://payments:PASSWORD@postgres:5432/payments`, and base64's `/`
> terminates the authority section of a URL. At 32 base64 characters that
> happens about two times in five, and the services then fail to start with an
> `Invalid URL` that says nothing about the password. Hex has no such
> characters.
>
> Whatever you choose, **it is fixed at first deploy**. Postgres only reads
> `POSTGRES_PASSWORD` when it initialises an empty data directory, so editing
> it later locks the services out of their own database.

### 5. Deploy

```bash
./deploy/deploy.sh
```

It builds every image, starts the stack, waits for both services to report
healthy, and seeds the five demo wallets **only if the system is empty** — so
re-running it to deploy an update never wipes or duplicates your data.

First run takes 3–5 minutes, mostly building the two Node images.

### 6. Open it

```
https://ledgerflow.yourdomain.com
```

Caddy obtains a Let's Encrypt certificate on the first request. There is no
certbot step and no renewal cron — it renews itself.

If the certificate was not ready in time for seeding, the demo wallets will be
missing. Run:

```bash
./deploy/seed-remote.sh
```

---

## What is actually exposed

Only Caddy publishes ports. Everything else talks over the private compose
network and is unreachable from the internet.

```
                      internet
                          │
                    :80 / :443
                          │
                      ┌───▼───┐
                      │ Caddy │  automatic HTTPS
                      └───┬───┘
          ┌───────────────┼────────────────┐
          │               │                │
    /api/write/*     /api/read/*      everything else
          │               │                │
   payment-service  query-service      frontend
          │               │                │
   ┌──────┴──────┐        └────┬───────────┘
   │  Postgres   │          Redis
   └─────────────┘             │
          └────────► Kafka ◄───┘
```

`handle_path` strips the prefix, so `/api/write/accounts` reaches the payment
service as `/accounts`.

**Why routing everything through one domain matters.** The frontend is built
with `VITE_WRITE_URL=/api/write`, so every call is same-origin. Without this
the browser would refuse the requests outright: a page served over HTTPS is
not allowed to call `http://your-server:4000`, and those ports are not
published anyway. It also means CORS stops applying at all.

---

## Demo controls on a public URL

`DEMO_ENDPOINTS=true` leaves the **Break the books** and **Park a poison
message** controls reachable by anyone who finds the URL. That is the
recommended setting: they are the most convincing part of a live demo, and an
interviewer can press them without you handing over a password.

Anyone can therefore:

- corrupt a balance (fixable with **Repair from journal**)
- park poison messages (harmless; the projection keeps running)
- pause the consumer (fixable with **Resume consumer**)
- rebuild the read model (it comes back identical)
- send payments between the demo wallets

All of it is recoverable from the UI, and none of it can lose real money —
there isn't any. Set `DEMO_ENDPOINTS=false` and redeploy to close the two
destructive ones.

### Keep it presentable with a nightly reset

Because the controls are open, a timer keeps the demo clean without you having
to notice:

```bash
crontab -e
```

```cron
0 4 * * * cd /opt/ledgerflow && ./deploy/reset-demo.sh >> /var/log/ledgerflow-reset.log 2>&1
```

The script repairs the books first (so a reset does not simply hide damage),
resumes the consumer if a demo left it paused, then resets and reseeds.

---

## Everyday operations

```bash
cd /opt/ledgerflow
alias dc='docker compose -f docker-compose.yml -f docker-compose.prod.yml'

dc ps                          # what is running
dc logs -f payment-service     # follow one service
dc logs -f                     # follow everything
dc restart ledger-query-service
docker stats --no-stream       # memory use per container

./deploy/deploy.sh             # deploy an update (git pull first)
./deploy/reset-demo.sh         # back to a clean, seeded demo
```

**Updating:**

```bash
cd /opt/ledgerflow && git pull && ./deploy/deploy.sh
```

**Backing up Postgres:**

```bash
dc exec -T postgres pg_dump -U payments payments | gzip > backup-$(date +%F).sql.gz
```

---

## Costs to expect

| Item | Oracle Always Free | Hetzner CX22 |
| --- | --- | --- |
| Compute | £0 | ~€3.79/mo |
| Domain | £0 with DuckDNS | £0 with DuckDNS |
| TLS certificate | £0 (Let's Encrypt) | £0 |
| Bandwidth | 10 TB/mo free | 20 TB/mo included |
| **Total** | **£0** | **~€4/mo** |

---

## A note on ARM

Oracle's free tier is ARM (Ampere), so every image has to publish an arm64
manifest. All six do — checked, not assumed:

| Image | Architectures |
| --- | --- |
| `bitnamilegacy/kafka:3.7` | amd64, **arm64** |
| `postgres:16-alpine` | 386, amd64, arm, **arm64**, ppc64le, riscv64, s390x |
| `redis:7-alpine` | 386, amd64, arm, **arm64**, ppc64le, riscv64, s390x |
| `caddy:2-alpine` | amd64, arm, **arm64**, ppc64le, riscv64, s390x |
| `nginx:alpine` | 386, amd64, arm, **arm64**, ppc64le, riscv64, s390x |
| `node:20-alpine` | amd64, arm, **arm64**, ppc64le, s390x |

Reproduce with:

```bash
docker manifest inspect bitnamilegacy/kafka:3.7 | grep architecture
```

Nothing needs swapping. The one optional change worth knowing about is
**Redpanda** — Kafka-API compatible, a single Go binary, no JVM, and it runs in
roughly a quarter of the memory. Only worth it on a box under 2 GB RAM; on
Oracle's 24 GB there is no reason to bother. If you do want it, replace the
`kafka` service in `docker-compose.yml` with:

```yaml
kafka:
  image: redpandadata/redpanda:latest
  command:
    - redpanda start
    - --smp 1
    - --overprovisioned
    - --node-id 0
    - --kafka-addr PLAINTEXT://0.0.0.0:9092
    - --advertise-kafka-addr PLAINTEXT://kafka:9092
  healthcheck:
    test: ['CMD-SHELL', 'rpk cluster info || exit 1']
    interval: 10s
    timeout: 10s
    retries: 15
    start_period: 20s
```

Then create the topic with three partitions on first boot:

```bash
dc exec kafka rpk topic create payment-events -p 3
```

The application code does not change — kafkajs speaks the same protocol, and
the Kafka control room reads the same admin API. **Test the control room
specifically** after switching: the partition, offset and consumer-group views
lean on admin calls that are worth confirming rather than assuming. Since the
stock image works on ARM, this is a memory optimisation, not a fix.

---

## Troubleshooting

**Certificate will not issue.**
`dc logs caddy` will say why. Almost always one of: DNS not pointing at the
server yet, port 80 blocked (check Oracle's Security List as well as `ufw`),
or the domain in `.env` not matching the A record.

**Caddy exits immediately.**
`EMAIL` is empty in `.env`. Caddy fails to parse an empty `email` directive.

**The services crash-loop with "password authentication failed".**
`POSTGRES_PASSWORD` no longer matches what the database was created with.
Postgres only applies that variable when it initialises an empty data
directory, so changing it after the first deploy has no effect on the existing
volume. Put the original back, or destroy the data and start clean:

```bash
dc down -v && ./deploy/deploy.sh
```

`deploy.sh` detects this case and says so rather than timing out silently.

**The services crash-loop with "Invalid URL".**
A `/` in `POSTGRES_PASSWORD` — almost always from `openssl rand -base64`. Use
`openssl rand -hex 24` and recreate the volume as above.

**The site loads but every number is blank.**
The services are not reachable through the proxy. Check
`curl https://your-domain/api/write/health` — if that fails but
`dc exec payment-service wget -qO- localhost:4000/health` works, the problem
is in the Caddyfile rather than the service.

**Balances are frozen and the live dot says "reconnecting".**
Either the consumer is paused from an earlier demo — press **Resume consumer**
on the Kafka page — or SSE is being buffered. The `flush_interval -1` in the
Caddyfile prevents the latter; if you replaced Caddy with nginx you need
`proxy_buffering off` instead.

**Kafka will not start on first boot.**
It needs about 20 seconds. If it keeps restarting, check memory:
`docker stats --no-stream`. Below 2 GB total RAM, lower `KAFKA_HEAP_OPTS` in
`docker-compose.prod.yml` or switch to Redpanda.

**Out of disk.**
`docker system prune -af` clears old build layers. Kafka retention is capped
at 7 days in the production overlay.

---

## Verified locally before writing this

The production overlay was run end to end on a local machine with
`DOMAIN=localhost`, using Caddy's internal CA:

| Check | Result |
| --- | --- |
| Only Caddy publishes ports | `80, 443` — every other service publishes none |
| `GET /` | 200, the SPA |
| `GET /favicon.svg` | 200 `image/svg+xml` |
| `GET /api/write/health` | `{"status":"ok","service":"payment-service"}` |
| `GET /api/read/health` | `{"status":"ok","service":"ledger-query-service",…}` |
| `GET /kafka` deep link | 200 |
| `http://` → `https://` | 308 redirect |
| Bundle contains `localhost:4000` | No — only `/api/write` and `/api/read` |
| SSE through the proxy | `hello` frame within 3 s, then both payment frames — streaming, not buffered |
| A payment end to end | `PROCESSING` → `COMPLETED`, read model updated |
| The app in a real browser | Signed in, live dot connected, 8 status tiles, 3 Kafka partitions, books balanced, **no console errors** |

The bootstrap script's individual stages were exercised in an Ubuntu 24.04
container rather than assumed:

| Check | Result |
| --- | --- |
| DNS preflight, domain does not resolve | Refuses, names the fix |
| DNS preflight, domain points elsewhere | Refuses, prints both addresses |
| DNS preflight, `SKIP_DNS_CHECK=true` | Proceeds |
| Firewall against Oracle's stock ruleset | `ACCEPT :80/:443` inserted **above** the `REJECT`, so traffic arrives |
| Firewall re-run | No duplicate rules |
| `.env` generation | All four keys present, mode `600`, hex password |
| `.env` re-run | Untouched — the password is never regenerated under a live database |
| Deploy with a mismatched password | Fails in seconds with the cause, instead of timing out |
| Account count before seeding | Reports the real number (`grep -c` counted lines, so it always said 1) |
| Full round trip on a generated password | Account created, payment `COMPLETED`, balances `97500` / `7500`, reconciliation `OK` with zero drift |
