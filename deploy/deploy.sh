#!/usr/bin/env bash
# Build and start the production stack. Safe to re-run - this is also how you
# deploy an update.
#
#   ./deploy/deploy.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ -f .env ] || {
  echo "No .env found. Copy the template and fill it in:" >&2
  echo "  cp deploy/.env.example .env && \$EDITOR .env" >&2
  exit 1
}
set -a; . ./.env; set +a

: "${DOMAIN:?DOMAIN is not set in .env}"
: "${EMAIL:?EMAIL is not set in .env - Caddy will not start without it}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set in .env}"
[ "$POSTGRES_PASSWORD" = "change-me" ] && {
  echo "POSTGRES_PASSWORD is still the placeholder. Generate one:" >&2
  echo "  openssl rand -base64 24" >&2
  exit 1
}

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

echo "==> Building for $DOMAIN"
$COMPOSE build

echo "==> Starting"
$COMPOSE up -d --remove-orphans

echo "==> Waiting for the services to report healthy"
READY=false
for _ in $(seq 1 60); do
  if $COMPOSE exec -T payment-service wget -qO- http://localhost:4000/health >/dev/null 2>&1 &&
     $COMPOSE exec -T ledger-query-service wget -qO- http://localhost:4001/health >/dev/null 2>&1; then
    echo "    both services are up"
    READY=true
    break
  fi
  sleep 3
done

if [ "$READY" != true ]; then
  echo "    services did not come up" >&2
  # Postgres only applies POSTGRES_PASSWORD when it initialises an empty data
  # directory. Change it after the first deploy and the existing volume keeps
  # the old one, so every connection is rejected and the services crash-loop
  # with an error that never mentions .env.
  if $COMPOSE logs payment-service 2>&1 | grep -qi 'password authentication failed'; then
    cat >&2 <<'MSG'

    Postgres is rejecting the password.

    POSTGRES_PASSWORD in .env does not match the one the database was created
    with. Postgres only reads that variable when it first initialises, so
    editing it later has no effect on an existing volume.

    Either put the original password back in .env, or - if the data is
    disposable - delete the volume and start over:

      docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v
      ./deploy/deploy.sh
MSG
  else
    echo "    check the logs:  $COMPOSE logs payment-service" >&2
  fi
  exit 1
fi

# Only seed an empty system, so re-deploying never wipes or duplicates data.
# grep -o, not grep -c: the response is a single line of JSON, so counting
# lines would report 1 no matter how many accounts came back. The `|| ACCOUNTS=0`
# is load-bearing: grep exits 1 when it finds no accounts (the normal state on a
# fresh deploy), and under set -eo pipefail that would kill the whole script
# before the check below ever runs - silently, with no error printed.
ACCOUNTS=$($COMPOSE exec -T payment-service \
  wget -qO- http://localhost:4000/accounts 2>/dev/null | grep -o '"id"' | wc -l | tr -d ' ') || ACCOUNTS=0
if [ "${ACCOUNTS:-0}" -eq 0 ]; then
  echo "==> No accounts yet, seeding the demo wallets"
  PAYMENTS_URL="https://$DOMAIN/api/write" ./scripts/seed.sh || \
    echo "    seeding failed - the certificate may still be issuing. Re-run ./deploy/seed-remote.sh in a minute."
else
  echo "==> $ACCOUNTS accounts already exist, leaving the data alone"
fi

echo
echo "Deployed:  https://$DOMAIN"
echo "Logs:      $COMPOSE logs -f"
