#!/usr/bin/env bash
# Seed the demo wallets through the public URL, for when the certificate was
# not ready during the first deploy.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -a; . ./.env; set +a
PAYMENTS_URL="https://${DOMAIN:?}/api/write" ./scripts/seed.sh
