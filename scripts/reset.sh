#!/usr/bin/env bash
# Wipes the write side (Postgres) and the read side (Redis) for a clean re-test.
set -euo pipefail

COMPOSE="${COMPOSE:-docker compose}"

echo "Clearing Postgres ..."
# The clearing account is plumbing, not data: every payment holds funds in it,
# so deleting it breaks the saga until the service restarts. Keep it, zero it.
$COMPOSE exec -T postgres psql -U payments -d payments -c \
  "TRUNCATE outbox, ledger_entries, payments CASCADE;
   DELETE FROM accounts WHERE NOT is_system;
   UPDATE accounts SET balance_cents = 0 WHERE is_system;"

echo "Flushing Redis (idempotency cache + read model) ..."
$COMPOSE exec -T redis redis-cli FLUSHALL

echo
echo "Postgres and Redis are clean; the clearing account is kept and zeroed."
echo
echo "NOTE: Kafka still holds every event ever published. The ledger query"
echo "service keeps its committed offsets, so it will not replay them - but a"
echo "new consumer group would rebuild state from that old history."
echo "For a genuinely empty topic:"
echo
echo "  $COMPOSE exec kafka /opt/bitnami/kafka/bin/kafka-topics.sh \\"
echo "    --bootstrap-server localhost:9092 --delete --topic payment-events"
echo "  $COMPOSE restart ledger-query-service"
echo
echo "Or nuke everything including volumes:  $COMPOSE down -v"
