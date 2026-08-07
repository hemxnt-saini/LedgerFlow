#!/usr/bin/env bash
# Creates the demo wallets against a running payment service.
set -euo pipefail

PAYMENTS="${PAYMENTS_URL:-http://localhost:4000}"

echo "Waiting for $PAYMENTS/health ..."
for _ in $(seq 1 30); do
  if curl -fsS "$PAYMENTS/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "$PAYMENTS/health" >/dev/null || {
  echo "payment service is not up - run 'docker compose up --build' first" >&2
  exit 1
}

create() {
  curl -fsS -X POST "$PAYMENTS/accounts" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$1\",\"initialBalanceCents\":$2}" |
    sed -E 's/.*"name":"([^"]*)".*"balanceCents":([0-9]*).*/  \1 - \2 cents/'
}

echo "Creating wallets:"
create "Alice"  100000   # $1,000.00
create "Bob"     50000   # $500.00
create "Carol"     500   # $5.00  - handy for the insufficient-funds case
create "Dev"     25000   # $250.00
create "Priya"   75000   # $750.00

echo
echo "Open http://localhost:8080 and pick one to sign in as."
echo "The event monitor is at http://localhost:8080/dev.html"
