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
for _ in $(seq 1 60); do
  if $COMPOSE exec -T payment-service wget -qO- http://localhost:4000/health >/dev/null 2>&1 &&
     $COMPOSE exec -T ledger-query-service wget -qO- http://localhost:4001/health >/dev/null 2>&1; then
    echo "    both services are up"
    break
  fi
  sleep 3
done

# Only seed an empty system, so re-deploying never wipes or duplicates data.
ACCOUNTS=$($COMPOSE exec -T payment-service \
  wget -qO- http://localhost:4000/accounts 2>/dev/null | grep -c '"id"' || echo 0)
if [ "$ACCOUNTS" -eq 0 ]; then
  echo "==> No accounts yet, seeding the demo wallets"
  PAYMENTS_URL="https://$DOMAIN/api/write" ./scripts/seed.sh || \
    echo "    seeding failed - the certificate may still be issuing. Re-run ./deploy/seed-remote.sh in a minute."
else
  echo "==> $ACCOUNTS accounts already exist, leaving the data alone"
fi

echo
echo "Deployed:  https://$DOMAIN"
echo "Logs:      $COMPOSE logs -f"
