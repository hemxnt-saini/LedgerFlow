#!/usr/bin/env bash
# Behaviour parity check: every endpoint, every refusal, every invariant, run
# against a live stack.
#
#   docker compose up --build -d
#   ./scripts/verify.sh
#
# Written for the Java migration, and worth keeping: it is the difference
# between "it compiles" and "it still does what it did". It creates a handful of
# V-* wallets and leaves them behind; nothing here is destructive.
#
# Override the targets when running against a deployment:
#   WRITE=https://host/api/write READ=https://host/api/read ./scripts/verify.sh
# End-to-end verification of the Java stack against the running compose stack.
# Every assertion here is a behaviour the TypeScript implementation had.
set -uo pipefail

WRITE="${WRITE:-http://localhost:4000}"
READ="${READ:-http://localhost:4001}"
TMP="$(mktemp -d)"
PASS=0; FAIL=0; FAILED=""

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }

pass() { printf '  %s   %s\n' "$(green ok)" "$1"; PASS=$((PASS+1)); }
fail() { printf '  %s %s\n' "$(red FAIL)" "$1"; FAIL=$((FAIL+1)); FAILED="${FAILED}
  - $1"; }
eq()   { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 :: expected [$1] got [$2]"; fi; }
truthy() { if [ "$1" = "true" ]; then pass "$2"; else fail "$2 :: expected true, got [$1]"; fi; }
phase() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# call METHOD URL BODY [HEADER...]  -> sets STATUS, BODY, HEAD
call() {
  local method="$1" url="$2" body="$3"; shift 3
  local args=(-s -o "$TMP/body" -D "$TMP/head" -w '%{http_code}' -X "$method" "$url")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data "$body")
  local h; for h in "$@"; do args+=(-H "$h"); done
  STATUS=$(curl "${args[@]}")
  BODY=$(cat "$TMP/body")
  HEAD=$(cat "$TMP/head")
}
j() { echo "$BODY" | jq -r "$1" 2>/dev/null; }
hdr() { echo "$HEAD" | tr -d '\r' | awk -v k="$(echo "$1" | tr 'A-Z' 'a-z')" 'BEGIN{IGNORECASE=1} tolower($1)==k":" {sub($1 FS,""); print}' | head -1; }

mkacct() { # name balance -> id
  call POST "$WRITE/accounts" "{\"name\":\"$1\",\"initialBalanceCents\":$2}"
  echo "$BODY" | jq -r .id
}

pay() { # from to cents [simulate] [key] -> sets STATUS/BODY
  local extra=""
  [ -n "${4:-}" ] && extra=",\"simulate\":\"$4\""
  if [ -n "${5:-}" ]; then
    call POST "$WRITE/payments" "{\"fromAccountId\":\"$1\",\"toAccountId\":\"$2\",\"amountCents\":$3$extra}" "Idempotency-Key: $5"
  else
    call POST "$WRITE/payments" "{\"fromAccountId\":\"$1\",\"toAccountId\":\"$2\",\"amountCents\":$3$extra}"
  fi
}

# poll_status paymentId expectedStatus timeoutSeconds
poll_status() {
  local id="$1" want="$2" timeout="${3:-15}" i=0
  while [ $i -lt $((timeout*4)) ]; do
    call GET "$WRITE/payments/$id" ""
    [ "$(j .status)" = "$want" ] && return 0
    i=$((i+1)); sleep 0.25
  done
  return 1
}

phase "1. health"
call GET "$WRITE/health" ""
eq 200 "$STATUS" "GET /health (write) is 200"
eq "payment-service" "$(j .service)" "write side names itself"
eq "ok" "$(j .status)" "write side reports ok"
call GET "$READ/health" ""
eq 200 "$STATUS" "GET /health (read) is 200"
eq "ledger-query-service" "$(j .service)" "read side names itself"
eq "false" "$(j .consumerPaused)" "consumer is running"
[ "$(j '.counters | has("applied") and has("duplicatesSkipped") and has("deadLettered")')" = "true" ] \
  && pass "read side exposes projection counters" || fail "read side counters missing"

phase "2. wallets and the ledger's opening entries"
call POST "$WRITE/accounts" '{"name":"V-Alice","initialBalanceCents":100000}'
eq 201 "$STATUS" "POST /accounts is 201"
ALICE=$(j .id)
BOB=$(mkacct "V-Bob" 50000)
CAROL=$(mkacct "V-Carol" 500)
DAVE=$(mkacct "V-Dave" 100000)
ERIN=$(mkacct "V-Erin" 100000)
FRANK=$(mkacct "V-Frank" 300000)
GRACE=$(mkacct "V-Grace" 100000)
HEIDI=$(mkacct "V-Heidi" 1000)
call GET "$WRITE/accounts/$ALICE" ""
eq 200 "$STATUS" "GET /accounts/:id is 200"
eq 100000 "$(j .balanceCents)" "opening balance is credited"
eq "false" "$(j .isSystem)" "a wallet is not a system account"
[ -n "$(j .createdAt)" ] && [ "$(j .createdAt)" != "null" ] && pass "createdAt is serialised" || fail "createdAt missing"
echo "$(j .createdAt)" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}\.[0-9]{3}Z$' \
  && pass "timestamps are ISO with milliseconds and Z" || fail "timestamp shape is [$(j .createdAt)]"

call GET "$WRITE/accounts" ""
NONSYS=$(echo "$BODY" | jq '[.[] | select(.isSystem)] | length')
eq 0 "$NONSYS" "GET /accounts hides system accounts"
call GET "$WRITE/accounts?includeSystem=true" ""
SYS=$(echo "$BODY" | jq '[.[] | select(.isSystem)] | length')
eq 2 "$SYS" "includeSystem=true shows clearing and funding"

call GET "$WRITE/ledger/trial-balance" ""
eq 200 "$STATUS" "GET /ledger/trial-balance is 200"
truthy "$(j .balanced)" "the books balance after opening wallets"
truthy "$(j .zeroSum)" "every balance together sums to zero"
eq 0 "$(j .mismatchedAccounts)" "no account disagrees with its journal"

phase "3. the happy path"
pay "$ALICE" "$BOB" 2500 "" "verify-happy-1"
eq 201 "$STATUS" "POST /payments is 201"
P1=$(j .id)
eq "PROCESSING" "$(j .status)" "leg 1 returns PROCESSING, not COMPLETED"
eq 3 "$(j .maxAttempts)" "the retry policy is advertised"
eq "NONE" "$(j .simulateMode)" "no simulated fault"
eq "[]" "$(echo "$BODY" | jq -c .holdReasons)" "nothing held it"
call GET "$WRITE/accounts?includeSystem=true" ""
CLEARING_ID="00000000-0000-4000-8000-000000000001"
poll_status "$P1" COMPLETED 15 && pass "the settle worker completes it" || fail "payment never reached COMPLETED"
call GET "$WRITE/payments/$P1" ""
eq 4 "$(echo "$BODY" | jq '.ledger | length')" "four ledger lines: AUTHORISE then SETTLE"
eq "AUTHORISE" "$(echo "$BODY" | jq -r '.ledger[0].leg')" "first leg is AUTHORISE"
eq "SETTLE" "$(echo "$BODY" | jq -r '.ledger[3].leg')" "last leg is SETTLE"
eq "DEBIT" "$(echo "$BODY" | jq -r '.ledger[0].direction')" "the debit comes first"
[ -n "$(echo "$BODY" | jq -r '.ledger[0].accountName')" ] && pass "ledger lines carry account names" || fail "no account name on a ledger line"
eq "null" "$(j .failureReason)" "a completed payment carries no failure"
call GET "$WRITE/accounts/$CLEARING_ID" ""
eq 0 "$(j .balanceCents)" "clearing is empty once settled"
call GET "$WRITE/accounts/$ALICE" ""
eq 97500 "$(j .balanceCents)" "the sender was debited exactly once"
call GET "$WRITE/accounts/$BOB" ""
eq 52500 "$(j .balanceCents)" "the receiver was credited"

phase "4. it cannot charge you twice"
pay "$ALICE" "$BOB" 2500 "" "verify-happy-1"
eq 200 "$STATUS" "a replayed request is 200, not 201"
eq "$P1" "$(j .id)" "the replay returns the original payment"
eq "true" "$(hdr Idempotent-Replay)" "the replay says so in a header"
eq "verify-happy-1" "$(hdr Idempotency-Key)" "the key is echoed back"
pay "$ALICE" "$BOB" 9999 "" "verify-happy-1"
eq 409 "$STATUS" "one key, a different payment is 409"
eq "IDEMPOTENCY_KEY_REUSED" "$(j .error)" "and says why"
pay "$ALICE" "$CAROL" 1500 "" ""
eq 201 "$STATUS" "a payment with no key still works"
DERIVED=$(hdr Idempotency-Key)
echo "$DERIVED" | grep -q '^auto:' && pass "the server derives a key and echoes it" || fail "derived key looks like [$DERIVED]"
P2=$(j .id)
pay "$ALICE" "$CAROL" 1500 "" ""
eq 200 "$STATUS" "the same request again is a replay, not a second charge"
eq "$P2" "$(j .id)" "and returns the first payment"

phase "5. a payment that gets stuck, and repays itself"
pay "$DAVE" "$BOB" 3000 "PERMANENT" ""
eq 201 "$STATUS" "a payment with a permanent fault is still accepted"
P3=$(j .id)
eq "PERMANENT" "$(j .simulateMode)" "the fault is recorded on the row"
poll_status "$P3" AWAITING_REFUND 20 && pass "settlement gives up and strands the money" || fail "never reached AWAITING_REFUND"
call GET "$WRITE/payments/$P3" ""
eq "SETTLEMENT_FAILED_SIMULATED" "$(j .failureReason)" "the reason is recorded"
eq 3 "$(j .attempts)" "it tried three times before giving up"
call GET "$WRITE/accounts/$CLEARING_ID" ""
eq 3000 "$(j .balanceCents)" "the stranded money is in clearing, not lost"
call POST "$WRITE/payments/$P3/refund" ""
eq 200 "$STATUS" "refunding stranded money is allowed"
eq "REFUNDED" "$(j .status)" "and it is refunded"
call POST "$WRITE/payments/$P3/refund" ""
eq 409 "$STATUS" "refunding twice is refused"
eq "NOT_REFUNDABLE_FROM_REFUNDED" "$(j .error)" "with the state in the code"
call POST "$WRITE/payments/$P1/refund" ""
eq 409 "$STATUS" "refunding a completed payment is refused"
eq "NOT_REFUNDABLE_FROM_COMPLETED" "$(j .error)" "because the money arrived"
call GET "$WRITE/payments/$P3" ""
eq 4 "$(echo "$BODY" | jq '.ledger | length')" "the refund posted a COMPENSATE pair"
eq "COMPENSATE" "$(echo "$BODY" | jq -r '.ledger[3].leg')" "and never a SETTLE"
call GET "$WRITE/accounts/$DAVE" ""
eq 100000 "$(j .balanceCents)" "the sender is exactly where they started"

phase "6. a transient fault heals"
pay "$DAVE" "$BOB" 1200 "TRANSIENT" ""
P4=$(j .id)
poll_status "$P4" COMPLETED 25 && pass "a transient fault completes without a refund" || fail "transient payment did not complete"
call GET "$WRITE/payments/$P4" ""
[ "$(j .attempts)" -gt 1 ] && pass "it took more than one attempt ($(j .attempts))" || fail "attempts=$(j .attempts), expected a retry"
eq "null" "$(j .failureReason)" "the earlier failure is cleared on success"

phase "7. declines are recorded, not thrown away"
call GET "$WRITE/accounts/$CAROL" ""
CAROL_BEFORE=$(j .balanceCents)
pay "$CAROL" "$BOB" 100000 "" ""
eq 201 "$STATUS" "an unaffordable payment is recorded"
eq "FAILED" "$(j .status)" "as FAILED"
eq "INSUFFICIENT_FUNDS" "$(j .failureReason)" "with the reason"
call GET "$WRITE/accounts/$CAROL" ""
eq "$CAROL_BEFORE" "$(j .balanceCents)" "and no money moved"

phase "8. the trust boundary"
call POST "$WRITE/payments" "{\"fromAccountId\":\"$ALICE\",\"toAccountId\":\"$ALICE\",\"amountCents\":100}"
eq 400 "$STATUS" "a self-transfer is refused"
eq "SAME_ACCOUNT" "$(j .error)" "with SAME_ACCOUNT"
call POST "$WRITE/payments" "{\"fromAccountId\":\"$ALICE\",\"toAccountId\":\"$BOB\",\"amountCents\":10.5}"
eq 400 "$STATUS" "fractional cents are refused"
eq "INVALID_AMOUNT" "$(j .error)" "with INVALID_AMOUNT"
call POST "$WRITE/payments" "{\"fromAccountId\":\"$ALICE\",\"toAccountId\":\"$BOB\",\"amountCents\":\"2500\"}"
eq 400 "$STATUS" "an amount sent as a string is refused"
call POST "$WRITE/payments" "{\"fromAccountId\":\"$ALICE\",\"toAccountId\":\"$BOB\",\"amountCents\":0}"
eq 400 "$STATUS" "a zero amount is refused"
call POST "$WRITE/payments" "{\"fromAccountId\":\"$ALICE\",\"toAccountId\":\"$BOB\",\"amountCents\":-100}"
eq 400 "$STATUS" "a negative amount is refused"
call POST "$WRITE/payments" "{\"fromAccountId\":\"$ALICE\",\"toAccountId\":\"$CLEARING_ID\",\"amountCents\":100}"
eq 400 "$STATUS" "paying the clearing account is refused"
eq "SYSTEM_ACCOUNT_NOT_PAYABLE" "$(j .error)" "with SYSTEM_ACCOUNT_NOT_PAYABLE"
call POST "$WRITE/payments" "{\"fromAccountId\":\"00000000-0000-4000-8000-0000000000ff\",\"toAccountId\":\"$BOB\",\"amountCents\":100}"
eq 404 "$STATUS" "an unknown account is 404"
eq "ACCOUNT_NOT_FOUND" "$(j .error)" "with ACCOUNT_NOT_FOUND"
call POST "$WRITE/payments" "{\"fromAccountId\":\"not-a-uuid\",\"toAccountId\":\"$BOB\",\"amountCents\":100}"
eq 400 "$STATUS" "a malformed account id is 400"
eq "INVALID_ACCOUNT_ID" "$(j .error)" "with INVALID_ACCOUNT_ID"
call POST "$WRITE/payments" "{\"fromAccountId\":\"$ALICE\",\"toAccountId\":\"$BOB\",\"amountCents\":100,\"note\":\"$(printf 'x%.0s' $(seq 1 200))\"}"
eq 400 "$STATUS" "an over-long note is 400"
eq "NOTE_TOO_LONG" "$(j .error)" "with NOTE_TOO_LONG"
call POST "$WRITE/payments" "{\"fromAccountId\":\"$ALICE\",\"toAccountId\":\"$BOB\",\"amountCents\":100,\"simulate\":\"WRONG\"}"
eq 400 "$STATUS" "an unknown simulate mode is 400"
eq "INVALID_SIMULATE_MODE" "$(j .error)" "with INVALID_SIMULATE_MODE"
call POST "$WRITE/payments" '{"broken json'
eq 400 "$STATUS" "a malformed body is 400, not 500"
eq "INVALID_REQUEST_BODY" "$(j .error)" "with INVALID_REQUEST_BODY"
call POST "$WRITE/accounts" '{}'
eq 400 "$STATUS" "a nameless account is 400"
eq "NAME_REQUIRED" "$(j .error)" "with NAME_REQUIRED"
call POST "$WRITE/accounts" '{"name":"x","initialBalanceCents":-5}'
eq 400 "$STATUS" "a negative opening balance is 400"
eq "INVALID_INITIAL_BALANCE" "$(j .error)" "with INVALID_INITIAL_BALANCE"
call GET "$WRITE/no/such/route" ""
eq 404 "$STATUS" "an unknown route is 404"
eq "NOT_FOUND" "$(j .error)" "and answers in JSON, not HTML"
call GET "$WRITE/accounts/not-a-uuid" ""
eq 400 "$STATUS" "a malformed id in the path is 400"
call GET "$READ/no/such/route" ""
eq 404 "$STATUS" "the read side answers an unknown route in JSON too"
eq "NOT_FOUND" "$(j .error)" "with NOT_FOUND"
call GET "$WRITE/payments/$P1/refund" ""
eq 404 "$STATUS" "a wrong method on a known path is 404, as before"

phase "9. the old boolean simulateFailure is still accepted"
call POST "$WRITE/payments" "{\"fromAccountId\":\"$GRACE\",\"toAccountId\":\"$HEIDI\",\"amountCents\":700,\"simulateFailure\":true}"
eq 201 "$STATUS" "simulateFailure:true is accepted"
eq "PERMANENT" "$(j .simulateMode)" "and means PERMANENT"
POLD=$(j .id)
call POST "$WRITE/payments" "{\"fromAccountId\":\"$GRACE\",\"toAccountId\":\"$HEIDI\",\"amountCents\":701,\"simulateFailure\":\"yes\"}"
eq 400 "$STATUS" "a non-boolean simulateFailure is 400"
eq "INVALID_SIMULATE_FAILURE" "$(j .error)" "with INVALID_SIMULATE_FAILURE"

phase "10. spending controls"
call GET "$WRITE/accounts/$ERIN/limits" ""
eq 200 "$STATUS" "GET /accounts/:id/limits is 200"
eq 100000 "$(j .limits.maxPaymentCents)" "the default per-payment cap"
eq 250000 "$(j .limits.dailyLimitCents)" "the default daily cap"
eq 8 "$(j .limits.velocityMax)" "the default velocity cap"
eq 60 "$(j .usage.windowSeconds)" "the velocity window is reported"
eq 250000 "$(j .remainingTodayCents)" "headroom before anything is spent"
call PUT "$WRITE/accounts/$ERIN/limits" '{"maxPaymentCents":500,"dailyLimitCents":250000,"velocityMax":8}'
eq 200 "$STATUS" "PUT /accounts/:id/limits is 200"
eq 500 "$(j .limits.maxPaymentCents)" "the new cap is returned"
pay "$ERIN" "$BOB" 600 "" ""
eq "FAILED" "$(j .status)" "a payment over the per-payment cap is declined"
eq "AMOUNT_ABOVE_LIMIT" "$(j .failureReason)" "with AMOUNT_ABOVE_LIMIT"
call PUT "$WRITE/accounts/$ERIN/limits" '{"maxPaymentCents":100000,"dailyLimitCents":1000,"velocityMax":8}'
pay "$ERIN" "$BOB" 2000 "" ""
eq "FAILED" "$(j .status)" "a payment over the daily cap is declined"
eq "DAILY_LIMIT_EXCEEDED" "$(j .failureReason)" "with DAILY_LIMIT_EXCEEDED"
call PUT "$WRITE/accounts/$ERIN/limits" '{"maxPaymentCents":100000,"dailyLimitCents":250000,"velocityMax":0}'
pay "$ERIN" "$BOB" 100 "" ""
eq "VELOCITY_EXCEEDED" "$(j .failureReason)" "a zero velocity cap blocks everything"
call PUT "$WRITE/accounts/$ERIN/limits" '{"maxPaymentCents":100000,"dailyLimitCents":250000,"velocityMax":8}'
eq 200 "$STATUS" "the limits can be put back"
call PUT "$WRITE/accounts/$ERIN/limits" '{"maxPaymentCents":-1,"dailyLimitCents":1,"velocityMax":1}'
eq 400 "$STATUS" "a negative cap is refused"
eq "INVALID_MAX_PAYMENT" "$(j .error)" "with INVALID_MAX_PAYMENT"
call PUT "$WRITE/accounts/$CLEARING_ID/limits" '{"maxPaymentCents":1,"dailyLimitCents":1,"velocityMax":1}'
eq 404 "$STATUS" "a system account has no controls to set"

phase "11. the risk screen holds funds for a person"
call GET "$WRITE/accounts/$CLEARING_ID" ""
CLEARING_BEFORE=$(j .balanceCents)
pay "$FRANK" "$HEIDI" 60000 "" ""
eq 201 "$STATUS" "a large payment to a new payee is accepted"
PHELD=$(j .id)
eq "HELD_FOR_REVIEW" "$(j .status)" "and held for review"
echo "$BODY" | jq -e '.holdReasons | index("LARGE_AMOUNT")' >/dev/null && pass "LARGE_AMOUNT is reported" || fail "LARGE_AMOUNT missing"
echo "$BODY" | jq -e '.holdReasons | index("NEW_PAYEE_LARGE")' >/dev/null && pass "NEW_PAYEE_LARGE is reported" || fail "NEW_PAYEE_LARGE missing"
call GET "$WRITE/accounts/$CLEARING_ID" ""
eq "$((CLEARING_BEFORE + 60000))" "$(j .balanceCents)" "the funds are already secured in clearing"
call GET "$WRITE/payments/reviews" ""
eq 200 "$STATUS" "GET /payments/reviews is 200 (and not parsed as an id)"
echo "$BODY" | jq -e --arg id "$PHELD" '.reviews | map(.id) | index($id)' >/dev/null \
  && pass "the held payment is in the review queue" || fail "held payment missing from the queue"
call POST "$WRITE/payments/$PHELD/refund" ""
eq 409 "$STATUS" "the payer cannot refund a held payment"
call POST "$WRITE/payments/$PHELD/approve" ""
eq 200 "$STATUS" "a reviewer can approve it"
eq "PROCESSING" "$(j .status)" "and it rejoins the settlement path"
poll_status "$PHELD" COMPLETED 15 && pass "an approved payment completes normally" || fail "approved payment did not complete"
call POST "$WRITE/payments/$PHELD/approve" ""
eq 409 "$STATUS" "approving twice is refused"
eq "NOT_UNDER_REVIEW_FROM_COMPLETED" "$(j .error)" "with the state in the code"

pay "$FRANK" "$GRACE" 55000 "" ""
PREJECT=$(j .id)
eq "HELD_FOR_REVIEW" "$(j .status)" "a second large payment is held"
call POST "$WRITE/payments/$PREJECT/reject" ""
eq 200 "$STATUS" "a reviewer can reject it"
eq "REFUNDED" "$(j .status)" "which compensates back to the sender"
eq "REJECTED_IN_REVIEW" "$(j .failureReason)" "recorded as a review decision"
call GET "$WRITE/payments/$PREJECT" ""
eq "COMPENSATE" "$(echo "$BODY" | jq -r '.ledger[3].leg')" "by the same COMPENSATE route a stuck payment uses"

phase "12. the ledger reads"
call GET "$WRITE/ledger/journal?limit=5" ""
eq 200 "$STATUS" "GET /ledger/journal is 200"
eq 5 "$(echo "$BODY" | jq '.entries | length')" "it returns whole journal entries"
truthy "$(echo "$BODY" | jq -r '[.entries[].balanced] | all')" "every entry is a balanced pair"
eq 2 "$(echo "$BODY" | jq '.entries[0].lines | length')" "each entry has two lines"
eq "DEBIT" "$(echo "$BODY" | jq -r '.entries[0].lines[0].direction')" "the debit line reads first"
call GET "$WRITE/ledger/journal?limit=5&accountId=$ALICE" ""
eq 200 "$STATUS" "the journal can be narrowed to one account"
truthy "$(echo "$BODY" | jq -r "[.entries[].lines[].accountId] | any(. == \"$ALICE\")")" "and every entry touches it"
call GET "$WRITE/ledger/journal?accountId=not-a-uuid" ""
eq 400 "$STATUS" "a malformed accountId is refused"
call GET "$WRITE/ledger/accounts/$ALICE?limit=50" ""
eq 200 "$STATUS" "GET /ledger/accounts/:id is 200"
truthy "$(j .matches)" "the statement agrees with the cached balance"
OPENING=$(j .openingCents); CLOSING=$(j .closingCents)
MOVEMENT=$(echo "$BODY" | jq '[.lines[].changeCents] | add // 0')
eq "$CLOSING" "$((OPENING + MOVEMENT))" "opening plus the movements equals closing"
call GET "$WRITE/accounts/$ALICE" ""
eq "$CLOSING" "$(j .balanceCents)" "and closing equals the account balance"

phase "13. the read model"
sleep 2
call GET "$READ/accounts/$ALICE/balance" ""
eq 200 "$STATUS" "GET /accounts/:id/balance is 200"
eq "redis-read-model" "$(j .source)" "and says where it came from"
call GET "$WRITE/accounts/$ALICE" ""
WRITE_BAL=$(j .balanceCents)
call GET "$READ/accounts/$ALICE/balance" ""
eq "$WRITE_BAL" "$(j .balanceCents)" "the two sides agree once nothing is in flight"
call GET "$READ/accounts/00000000-0000-4000-8000-0000000000ff/balance" ""
eq 404 "$STATUS" "an unprojected account is 404"
eq "ACCOUNT_NOT_IN_READ_MODEL" "$(j .error)" "with ACCOUNT_NOT_IN_READ_MODEL"
call GET "$READ/balances?ids=$ALICE,$BOB,$CAROL" ""
eq 200 "$STATUS" "GET /balances is 200"
eq 3 "$(echo "$BODY" | jq '.balances | length')" "it answers for every id in one call"
call GET "$READ/accounts/$ALICE/transactions?limit=20" ""
eq 200 "$STATUS" "GET /accounts/:id/transactions is 200"
[ "$(echo "$BODY" | jq '.transactions | length')" -ge 2 ] && pass "history has one row per payment, replays included none" || fail "history looks short"
echo "$BODY" | jq -e --arg a "$P1" --arg b "$P2" '[.transactions[].paymentId] as $ids | ($ids | index($a)) and ($ids | index($b))' >/dev/null \
  && pass "both of the sender's payments are there" || fail "a payment is missing from the projected history"
echo "$BODY" | jq -e --arg id "$P1" '.transactions | map(select(.paymentId == $id and .status == "COMPLETED")) | length == 1' >/dev/null \
  && pass "the completed payment appears once, as COMPLETED" || fail "projected payment row is wrong"
call GET "$READ/accounts/$ALICE/stats" ""
eq 200 "$STATUS" "GET /accounts/:id/stats is 200"
[ "$(j .allTime.sentCents)" -gt 0 ] && pass "lifetime counters are maintained" || fail "sentCents is $(j .allTime.sentCents)"
[ "$(j .today.sentCents)" -gt 0 ] && pass "today's bucket is maintained" || fail "today's sentCents is 0"
eq "$(j .today.sentCents)" "$(j .thisWeek.sentCents)" "this week includes today"
call GET "$READ/activity?limit=20" ""
eq 200 "$STATUS" "GET /activity is 200"
[ "$(echo "$BODY" | jq '.activity | length')" -gt 5 ] && pass "the activity ticker has entries" || fail "activity is empty"
call GET "$READ/pipeline?limit=20" ""
eq 200 "$STATUS" "GET /pipeline is 200"
[ "$(echo "$BODY" | jq '.traces | length')" -gt 5 ] && pass "pipeline traces are recorded" || fail "no pipeline traces"
echo "$BODY" | jq -e '.traces[0] | has("stages") and (.stages | has("outboxMs") and has("transportMs") and has("projectionMs") and has("totalMs"))' >/dev/null \
  && pass "each trace has the four measured stages" || fail "trace stages missing"
echo "$BODY" | jq -e '.traces[0] | (.partition | type == "number") and (.offset | type == "string")' >/dev/null \
  && pass "each trace records where it lived in the log" || fail "trace partition/offset shape wrong"

phase "14. the live stream"
( curl -sN --max-time 10 "$READ/events/stream" > "$TMP/sse" 2>/dev/null & echo $! > "$TMP/ssepid" )
sleep 2
grep -q "hello" "$TMP/sse" && pass "the stream opens with a hello frame" || fail "no hello frame"
pay "$GRACE" "$BOB" 900 "" ""
PSSE=$(j .id)
poll_status "$PSSE" COMPLETED 15 >/dev/null
sleep 2
grep -q "payment-event" "$TMP/sse" && pass "a payment is pushed to open tabs" || fail "no payment-event frame"
grep -q "$PSSE" "$TMP/sse" && pass "the frame carries the payment" || fail "the payment id is not in the stream"
grep -qE '"stages"' "$TMP/sse" && pass "and its measured trace" || fail "no trace on the frame"
call GET "$READ/health" ""
[ "$(j .subscribers)" -ge 1 ] && pass "the subscriber is counted on /health ($(j .subscribers))" || fail "subscribers=$(j .subscribers)"
kill "$(cat "$TMP/ssepid")" 2>/dev/null; wait 2>/dev/null

phase "15. CORS and correlation"
call GET "$WRITE/health" "" "X-Correlation-Id: verify-correlation-1"
eq "verify-correlation-1" "$(hdr X-Correlation-Id)" "the write side adopts a caller's correlation id"
call GET "$READ/health" "" "X-Correlation-Id: verify-correlation-2"
eq "verify-correlation-2" "$(hdr X-Correlation-Id)" "so does the read side"
call GET "$WRITE/health" ""
[ -n "$(hdr X-Correlation-Id)" ] && pass "one is minted when the caller sends none" || fail "no correlation id minted"
eq "*" "$(hdr Access-Control-Allow-Origin)" "CORS allows the frontend's origin"
echo "$(hdr Access-Control-Expose-Headers)" | grep -q "Idempotent-Replay" \
  && pass "Idempotent-Replay is exposed to fetch()" || fail "expose-headers is [$(hdr Access-Control-Expose-Headers)]"
echo "$(hdr Access-Control-Allow-Methods)" | grep -q "PUT" \
  && pass "PUT and DELETE survive a preflight" || fail "allow-methods is [$(hdr Access-Control-Allow-Methods)]"
call OPTIONS "$WRITE/accounts/$ALICE/limits" ""
eq 204 "$STATUS" "a preflight is answered 204"

phase "16. Kafka: partitions, offsets and lag"
call GET "$READ/kafka/overview" ""
eq 200 "$STATUS" "GET /kafka/overview is 200"
eq "payment-events" "$(j .mainTopic)" "it names the main topic"
eq "payment-events-dlq" "$(j .dlqTopic)" "and the parking topic"
MAIN_PARTS=$(echo "$BODY" | jq '[.topics[] | select(.topic == "payment-events")] | .[0].partitions | length')
eq 3 "$MAIN_PARTS" "the main topic really has three partitions"
[ "$(echo "$BODY" | jq '[.topics[] | select(.topic=="payment-events")] | .[0].messages')" -gt 10 ] \
  && pass "the log has the events we published" || fail "message count looks wrong"
echo "$BODY" | jq -e '[.groups[] | select(.groupId == "ledger-query-service")] | length == 1' >/dev/null \
  && pass "the projection group is described" || fail "projection group missing"
echo "$BODY" | jq -e '[.groups[] | select(.groupId=="ledger-query-service")] | .[0].members | length >= 1' >/dev/null \
  && pass "with a live member" || fail "no group members"
echo "$BODY" | jq -e '[.groups[] | select(.groupId=="ledger-query-service")] | .[0].members[0].assignment | length >= 1' >/dev/null \
  && pass "and its partition assignment" || fail "no partition assignment decoded"
LAG=$(echo "$BODY" | jq '[.topics[].lag] | add')
eq 0 "$LAG" "nothing is lagging while the consumer runs"

phase "17. pausing the consumer builds lag, resuming drains it"
call POST "$READ/kafka/consumer/pause" ""
eq 200 "$STATUS" "POST /kafka/consumer/pause is 200"
truthy "$(j .paused)" "and it reports paused"
call GET "$READ/health" ""
truthy "$(j .consumerPaused)" "/health agrees"
pay "$GRACE" "$BOB" 400 "" ""
PPAUSED=$(j .id)
poll_status "$PPAUSED" COMPLETED 15 >/dev/null
sleep 2
call GET "$READ/kafka/overview" ""
LAG=$(echo "$BODY" | jq '[.topics[].lag] | add')
[ "$LAG" -gt 0 ] && pass "lag climbs while paused ($LAG)" || fail "lag stayed at 0 while paused"
call POST "$READ/kafka/consumer/resume" ""
eq 200 "$STATUS" "POST /kafka/consumer/resume is 200"
eq "false" "$(j .paused)" "and it reports running"
DRAINED=no
for i in $(seq 1 30); do
  call GET "$READ/kafka/overview" ""
  [ "$(echo "$BODY" | jq '[.topics[].lag] | add')" -eq 0 ] && { DRAINED=yes; break; }
  sleep 1
done
eq "yes" "$DRAINED" "the backlog drains once resumed, nothing lost"
call GET "$READ/accounts/$GRACE/transactions?limit=30" ""
echo "$BODY" | jq -e --arg id "$PPAUSED" '.transactions | map(select(.paymentId == $id)) | length == 1' >/dev/null \
  && pass "the payment made during the pause is projected" || fail "the paused-window payment never arrived"

phase "18. the dead letter queue"
call POST "$READ/dlq/demo/poison" ""
eq 200 "$STATUS" "POST /dlq/demo/poison is 200"
eq "payment-events" "$(j .topic)" "it writes to the main topic"
PARKED=no
for i in $(seq 1 30); do
  call GET "$READ/dlq?limit=20" ""
  [ "$(echo "$BODY" | jq '[.entries[] | select(.reason=="UNPARSEABLE")] | length')" -ge 1 ] && { PARKED=yes; break; }
  sleep 1
done
eq "yes" "$PARKED" "the consumer parks it instead of dropping it"
DLQID=$(echo "$BODY" | jq -r '[.entries[] | select(.reason=="UNPARSEABLE" and (.replayedAt == null))][0].dlqId')
eq "payment-events-dlq" "$(j .topic)" "GET /dlq names the parking topic"
[ "$(j .pending)" -ge 1 ] && pass "and counts what is still pending" || fail "pending=$(j .pending)"
echo "$BODY" | jq -e '.entries[0] | has("payload") and has("offset") and has("partition") and has("failedAt")' >/dev/null \
  && pass "an entry keeps the original bytes and where they came from" || fail "dlq entry shape wrong"
call GET "$READ/kafka/overview" ""
eq 0 "$(echo "$BODY" | jq '[.topics[].lag] | add')" "a poison message does not block the consumer"
call POST "$READ/dlq/$DLQID/replay" ""
eq 200 "$STATUS" "POST /dlq/:id/replay is 200"
[ "$(j .replayedAt)" != "null" ] && pass "and stamps when it was replayed" || fail "replayedAt not set"
call POST "$READ/dlq/does-not-exist/replay" ""
eq 404 "$STATUS" "replaying an unknown id is 404"
eq "DLQ_ENTRY_NOT_FOUND" "$(j .error)" "with DLQ_ENTRY_NOT_FOUND"
call DELETE "$READ/dlq/$DLQID" ""
eq 200 "$STATUS" "DELETE /dlq/:id discards it from the list"
call DELETE "$READ/dlq/does-not-exist" ""
eq 404 "$STATUS" "discarding an unknown id is 404"
call GET "$READ/health" ""
[ "$(j .counters.deadLettered)" -ge 1 ] && pass "the parked message is counted on /health" || fail "deadLettered=$(j .counters.deadLettered)"

phase "19. rebuild the read model from the log"
call GET "$WRITE/accounts/$ALICE" ""; BEFORE_A=$(j .balanceCents)
call GET "$WRITE/accounts/$BOB" ""; BEFORE_B=$(j .balanceCents)
call GET "$READ/accounts/$ALICE/stats" ""; BEFORE_SENT=$(j .allTime.sentCents)
call POST "$READ/kafka/consumer/rebuild" ""
eq 200 "$STATUS" "POST /kafka/consumer/rebuild is 200"
[ "$(j .cleared)" -gt 3 ] && pass "it deletes the projected keys ($(j .cleared))" || fail "cleared=$(j .cleared)"
eq 3 "$(j .rewoundPartitions)" "and rewinds every partition"
REBUILT=no
for i in $(seq 1 60); do
  call GET "$READ/accounts/$ALICE/balance" ""
  if [ "$STATUS" = "200" ] && [ "$(j .balanceCents)" = "$BEFORE_A" ]; then
    call GET "$READ/accounts/$BOB/balance" ""
    [ "$(j .balanceCents)" = "$BEFORE_B" ] && { REBUILT=yes; break; }
  fi
  sleep 1
done
eq "yes" "$REBUILT" "the read model comes back identical from the log"
call GET "$READ/accounts/$ALICE/stats" ""
eq "$BEFORE_SENT" "$(j .allTime.sentCents)" "including the statistics, counted once"
call GET "$READ/accounts/$ALICE/transactions?limit=30" ""
[ "$(echo "$BODY" | jq '.transactions | length')" -ge 2 ] && pass "and the history" || fail "history did not rebuild"

phase "20. reconciliation, the control that proves the books"
OK=no
for i in $(seq 1 40); do
  call POST "$WRITE/reconciliation/run" ""
  [ "$(j .status)" = "OK" ] && { OK=yes; break; }
  sleep 1
done
eq "yes" "$OK" "the control reports OK once everything has settled"
eq 0 "$(j .driftCents)" "with no drift"
eq "[]" "$(echo "$BODY" | jq -c .findings)" "and nothing to say"
[ "$(j .checkedAccounts)" -ge 10 ] && pass "it checked every account ($(j .checkedAccounts))" || fail "checkedAccounts=$(j .checkedAccounts)"
[ "$(j .durationMs)" -ge 0 ] && pass "and reports how long it took" || fail "no durationMs"
call GET "$WRITE/reconciliation?limit=5" ""
eq 200 "$STATUS" "GET /reconciliation is 200"
eq "OK" "$(j .latest.status)" "the latest run is the one we just made"
[ "$(echo "$BODY" | jq '.history | length')" -ge 2 ] && pass "history is kept, so drift has a first sighting" || fail "no history"

call POST "$WRITE/reconciliation/demo/inject-drift" '{"driftCents":5000}'
eq 200 "$STATUS" "the demo endpoint can break a balance on purpose"
DRIFTED=$(j .accountId)
[ -n "$DRIFTED" ] && pass "and says which account it broke" || fail "no account returned"
call POST "$WRITE/reconciliation/run" ""
eq "DRIFT" "$(j .status)" "the control catches it"
SUM_FINDINGS=$(echo "$BODY" | jq '[.findings[].driftCents | fabs] | add')
eq "$SUM_FINDINGS" "$(j .driftCents)" "and totals the magnitude of every finding"
eq 15000 "$(j .driftCents)" "three checks trip: the account, the zero sum, the read model"
echo "$BODY" | jq -e '[.findings[].code] | index("READ_MODEL_DRIFT")' >/dev/null \
  && pass "the read model is reported as drifted, not merely lagging" || fail "no READ_MODEL_DRIFT finding"
echo "$BODY" | jq -e '[.findings[].code] | index("BALANCE_DRIFT")' >/dev/null \
  && pass "reporting BALANCE_DRIFT" || fail "no BALANCE_DRIFT finding"
echo "$BODY" | jq -e '[.findings[].code] | index("SYSTEM_NOT_ZERO_SUM")' >/dev/null \
  && pass "and that the books no longer sum to zero" || fail "no SYSTEM_NOT_ZERO_SUM finding"
echo "$BODY" | jq -e '[.findings[] | select(.code=="BALANCE_DRIFT")] | .[0] | has("expectedCents") and has("actualCents") and has("accountName")' >/dev/null \
  && pass "a finding names the account and both numbers" || fail "finding is missing its numbers"
echo "$BODY" | jq -e '[.findings[] | select(.code=="SYSTEM_NOT_ZERO_SUM")] | .[0] | has("accountId") | not' >/dev/null \
  && pass "and omits fields that do not apply, rather than sending null" || fail "absent finding fields are being sent as null"
call GET "$WRITE/ledger/trial-balance" ""
eq "false" "$(j .zeroSum)" "the trial balance shows it too"
eq 1 "$(j .mismatchedAccounts)" "naming one mismatched account"
call POST "$WRITE/reconciliation/repair" ""
eq 200 "$STATUS" "POST /reconciliation/repair is 200"
eq 1 "$(echo "$BODY" | jq '.repaired | length')" "it repairs exactly the drifted account"
eq 5000 "$(j .correctedCents)" "by exactly the injected amount"
echo "$BODY" | jq -e '.repaired[0] | has("fromCents") and has("toCents") and has("accountName")' >/dev/null \
  && pass "and reports what it changed" || fail "repair report shape wrong"
call POST "$WRITE/reconciliation/run" ""
eq "OK" "$(j .status)" "the control is green again after the repair"
call GET "$WRITE/ledger/trial-balance" ""
truthy "$(j .zeroSum)" "and the books sum to zero again"
truthy "$(j .balanced)" "with the two columns equal"
eq 0 "$(j .mismatchedAccounts)" "and no account disagreeing"

phase "21. the closed set of books, checked in Postgres itself"
SUM=$(docker compose exec -T postgres psql -U payments -d payments -tAc "SELECT sum(balance_cents) FROM accounts;" 2>/dev/null | tr -d ' \r')
eq 0 "$SUM" "SELECT sum(balance_cents) FROM accounts is zero"
UNBAL=$(docker compose exec -T postgres psql -U payments -d payments -tAc \
  "SELECT count(*) FROM (SELECT entry_group FROM ledger_entries GROUP BY entry_group HAVING count(*) <> 2 OR sum(CASE WHEN direction='CREDIT' THEN amount_cents ELSE -amount_cents END) <> 0) x;" 2>/dev/null | tr -d ' \r')
eq 0 "$UNBAL" "every journal entry is exactly one debit and one credit"
OUTBOX=$(docker compose exec -T postgres psql -U payments -d payments -tAc "SELECT count(*) FROM outbox WHERE published_at IS NULL;" 2>/dev/null | tr -d ' \r')
eq 0 "$OUTBOX" "the outbox is fully drained"
LEGS=$(docker compose exec -T postgres psql -U payments -d payments -tAc "SELECT string_agg(DISTINCT leg, ',' ORDER BY leg) FROM ledger_entries;" 2>/dev/null | tr -d ' \r')
eq "AUTHORISE,COMPENSATE,FUNDING,SETTLE" "$LEGS" "all four legs have been exercised"

printf '\n\033[1m%s\033[0m\n' "summary"
printf '  passed: %s\n' "$(green "$PASS")"
if [ "$FAIL" -gt 0 ]; then
  printf '  failed: %s%s\n' "$(red "$FAIL")" "$FAILED"
  exit 1
fi
printf '  failed: 0\n  %s\n' "$(green 'everything green')"
