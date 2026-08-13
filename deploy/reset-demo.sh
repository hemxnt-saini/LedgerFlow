#!/usr/bin/env bash
# Put the demo back to a clean, seeded state.
#
# Worth running on a timer, because the break-the-books and poison-message
# controls are deliberately left open to the public: anyone can corrupt a
# balance, park messages or drain an account. All of it is recoverable from
# the UI, but a nightly reset means the demo is always presentable without
# anyone having to notice.
#
#   0 4 * * *  cd /opt/ledgerflow && ./deploy/reset-demo.sh >> /var/log/ledgerflow-reset.log 2>&1
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -a; . ./.env; set +a

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

echo "==> $(date -u +%FT%TZ) resetting"

# Repair first. If someone left the books broken, resetting alone would hide
# it rather than fix it, and the next reconciliation pass would still be red.
$COMPOSE exec -T payment-service \
  wget -qO- --post-data='' http://localhost:4000/reconciliation/repair >/dev/null 2>&1 || true

# Make sure the consumer is not left paused from a demo.
$COMPOSE exec -T ledger-query-service \
  wget -qO- --post-data='' http://localhost:4001/kafka/consumer/resume >/dev/null 2>&1 || true

COMPOSE="$COMPOSE" ./scripts/reset.sh
PAYMENTS_URL="https://${DOMAIN:?}/api/write" ./scripts/seed.sh

echo "==> done"
