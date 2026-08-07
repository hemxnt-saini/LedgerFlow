/* Wallet UI. Vanilla JS, no build step, no framework.
 *
 * Two backends, and the split is the whole point:
 *   WRITE (:4000) commands - send a payment, refund one. Owns Postgres.
 *   READ  (:4001) queries  - balances, history, stats, and the live SSE feed.
 *                            Owns nothing but a Redis projection of Kafka.
 */

const WRITE = `http://${location.hostname}:4000`;
const READ = `http://${location.hostname}:4001`;

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = (cents) => money.format((Number(cents) || 0) / 100);
const initials = (name) =>
  (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

const STATUS_LABEL = {
  PROCESSING: 'Processing',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  AWAITING_REFUND: 'Awaiting refund',
  REFUNDED: 'Refunded',
};

const REASON_LABEL = {
  INSUFFICIENT_FUNDS: "You don't have enough for that",
  SAME_ACCOUNT: 'You cannot pay yourself',
  INVALID_AMOUNT: 'That amount is not valid',
  SETTLEMENT_FAILED_SIMULATED: 'Settlement failed (simulated)',
  RECEIVER_UNAVAILABLE: 'The receiver could not be credited',
  IDEMPOTENCY_KEY_REUSED: 'That idempotency key was already used for a different payment',
  NOT_REFUNDABLE_FROM_COMPLETED: 'This payment arrived - there is nothing to refund',
  ACCOUNT_NOT_FOUND: 'That account no longer exists',
  NOT_FOUND: 'Not found',
};
const humanise = (code) =>
  REASON_LABEL[code] ?? (code ? code.replace(/_/g, ' ').toLowerCase() : 'Something went wrong');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  meId: localStorage.getItem('walletUserId'),
  accounts: [],
  byId: new Map(),
  balances: {},
  transactions: [],
  activity: [],
  stats: null,
  notifications: [],
  unread: 0,
  degraded: false,
  watching: null, // paymentId the send modal is following
};

const me = () => state.byId.get(state.meId);
const nameOf = (id) => state.byId.get(id)?.name ?? `${String(id).slice(0, 8)}…`;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(url, options = {}) {
  // Never hang forever. A browser allows only six connections per origin over
  // HTTP/1.1 and the event stream permanently holds one of them, so with
  // enough tabs of this app open a request can queue indefinitely. A request
  // that cannot finish should say so, not spin.
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error ?? `HTTP ${res.status}`);
    error.code = body.error;
    error.status = res.status;
    throw error;
  }
  return body;
}

const loadAccounts = async () => {
  state.accounts = await api(`${WRITE}/accounts`);
  state.byId = new Map(state.accounts.map((account) => [account.id, account]));
};

async function loadReadModel() {
  if (!state.meId) return;
  const ids = state.accounts.map((account) => account.id).join(',');
  let degraded = false;
  const orDefault = (promise, fallback) =>
    promise.catch(() => {
      degraded = true;
      return fallback;
    });

  const [balances, transactions, stats, activity] = await Promise.all([
    orDefault(api(`${READ}/balances?ids=${ids}`), { balances: state.balances }),
    orDefault(api(`${READ}/accounts/${state.meId}/transactions?limit=100`), {
      transactions: state.transactions,
    }),
    orDefault(api(`${READ}/accounts/${state.meId}/stats`), state.stats),
    orDefault(api(`${READ}/activity?limit=40`), { activity: state.activity }),
  ]);
  state.balances = balances.balances;
  state.transactions = transactions.transactions;
  state.stats = stats;
  state.activity = activity.activity;

  // The write side is still fine when this happens - only the read model is
  // unreachable - so say that rather than implying the money is in danger.
  if (degraded && !state.degraded) {
    toast('Read model is not responding. Balances may be out of date.', 'warn');
  }
  state.degraded = degraded;
}

// A burst of events (a payment fires initiated then completed) should cause
// one refresh, not four.
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      await loadReadModel();
      renderDashboard();
    } catch (err) {
      console.error('refresh failed', err);
    }
  }, 120);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderLogin() {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');

  const people = $('people');
  people.replaceChildren();
  $('login-empty').classList.toggle('hidden', state.accounts.length > 0);

  for (const account of state.accounts) {
    const card = el('button', 'person');
    card.append(
      el('div', 'avatar', initials(account.name)),
      el('div', null, account.name),
      el('div', 'small muted', fmt(account.balanceCents)),
    );
    card.onclick = () => signIn(account.id);
    people.append(card);
  }
}

function renderBalance() {
  const readBalance = state.balances[state.meId];
  const balance = readBalance !== undefined ? readBalance : me()?.balanceCents ?? 0;
  $('balance').textContent = fmt(balance);

  const inFlight = state.transactions.filter(
    (txn) => txn.status === 'PROCESSING' && txn.fromAccountId === state.meId,
  );
  const held = inFlight.reduce((total, txn) => total + txn.amountCents, 0);
  $('pending').textContent = held
    ? `${fmt(held)} in flight - held in clearing until it settles`
    : '';
  $('stat-inflight').textContent = String(inFlight.length);
}

function renderStats() {
  const stats = state.stats;
  if (!stats) return;
  $('stat-today-sent').textContent = fmt(stats.today.sentCents);
  $('stat-today-recv').textContent = fmt(stats.today.receivedCents);
  $('stat-week-sent').textContent = fmt(stats.thisWeek.sentCents);
  $('stat-total-sent').textContent = fmt(stats.allTime.sentCents);
  $('stat-total-recv').textContent = fmt(stats.allTime.receivedCents);
  $('stat-count-sent').textContent = String(stats.allTime.sentCount);
  $('stat-count-recv').textContent = String(stats.allTime.receivedCount);
}

function renderFriends() {
  const container = $('friends');
  container.replaceChildren();
  const friends = state.accounts.filter((account) => account.id !== state.meId);

  if (friends.length === 0) {
    container.append(el('div', 'empty', 'No one else has an account yet. Create one to send money.'));
    return;
  }

  for (const friend of friends) {
    const balance = state.balances[friend.id] ?? friend.balanceCents;
    const row = el('div', 'item');
    row.tabIndex = 0;
    row.append(el('div', 'avatar', initials(friend.name)));
    const body = el('div', 'grow stack');
    body.append(el('div', null, friend.name), el('div', 'tiny muted', fmt(balance)));
    row.append(body, el('div', 'small muted', 'Pay →'));
    const open = () => openSend(friend.id);
    row.onclick = open;
    row.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    };
    container.append(row);
  }
}

function visibleTransactions() {
  const term = $('search').value.trim().toLowerCase();
  const status = $('filter-status').value;
  const direction = $('filter-direction').value;

  return state.transactions.filter((txn) => {
    const outgoing = txn.fromAccountId === state.meId;
    if (status && txn.status !== status) return false;
    if (direction === 'out' && !outgoing) return false;
    if (direction === 'in' && outgoing) return false;
    if (!term) return true;
    const haystack = [
      nameOf(txn.fromAccountId),
      nameOf(txn.toAccountId),
      txn.note ?? '',
      (txn.amountCents / 100).toFixed(2),
      txn.status,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(term);
  });
}

function renderTransactions() {
  const container = $('transactions');
  container.replaceChildren();
  const rows = visibleTransactions();
  $('txn-count').textContent = `${rows.length} of ${state.transactions.length}`;

  if (state.transactions.length === 0) {
    container.append(
      el('div', 'empty', 'No payments yet. Send one to a friend and watch it appear here.'),
    );
    return;
  }
  if (rows.length === 0) {
    container.append(el('div', 'empty', 'Nothing matches that search.'));
    return;
  }

  for (const txn of rows) {
    const outgoing = txn.fromAccountId === state.meId;
    const other = outgoing ? txn.toAccountId : txn.fromAccountId;
    const row = el('div', 'item');
    row.tabIndex = 0;
    row.append(el('div', 'avatar', initials(nameOf(other))));

    const body = el('div', 'grow stack');
    const title = el('div', 'row');
    title.append(
      el('span', null, `${outgoing ? 'To' : 'From'} ${nameOf(other)}`),
      el('span', `badge ${txn.status}`, STATUS_LABEL[txn.status] ?? txn.status),
    );
    const sub = el('div', 'tiny muted truncate');
    sub.textContent = [txn.note, ago(txn.updatedAt || txn.createdAt)].filter(Boolean).join(' · ');
    body.append(title, sub);

    const amount = el(
      'div',
      `amount ${outgoing ? 'out' : 'in'}`,
      `${outgoing ? '−' : '+'}${fmt(txn.amountCents)}`,
    );
    row.append(body, amount);

    const open = () => openDetail(txn.paymentId);
    row.onclick = open;
    row.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    };
    container.append(row);
  }
}

function activityLine(entry) {
  const from = nameOf(entry.fromAccountId);
  const to = nameOf(entry.toAccountId);
  const amount = fmt(entry.amountCents);
  switch (entry.type) {
    case 'payment.initiated':
      return `${from} started paying ${to} ${amount}`;
    case 'payment.completed':
      return `${from} paid ${to} ${amount}`;
    case 'payment.failed':
      return `${from} → ${to} ${amount} declined`;
    case 'payment.stuck':
      return `${from} → ${to} ${amount} stuck, awaiting refund`;
    case 'payment.refunded':
      return `${amount} refunded to ${from}`;
    default:
      return `${entry.type} ${amount}`;
  }
}

function renderActivity() {
  const container = $('activity');
  container.replaceChildren();
  if (state.activity.length === 0) {
    container.append(el('div', 'empty', 'Nothing has happened yet.'));
    return;
  }
  for (const entry of state.activity.slice(0, 40)) {
    const row = el('div', 'item flat');
    const body = el('div', 'grow stack');
    body.append(el('div', null, activityLine(entry)), el('div', 'tiny muted', ago(entry.occurredAt)));
    row.append(body);
    container.append(row);
  }
}

function renderNotifications() {
  $('bell-count').textContent = String(state.unread);
  $('bell-count').classList.toggle('hidden', state.unread === 0);

  const container = $('notifications');
  container.replaceChildren();
  if (state.notifications.length === 0) {
    container.append(el('div', 'empty', 'Nothing new.'));
    return;
  }
  for (const note of state.notifications.slice(0, 30)) {
    const row = el('div', 'item flat');
    const body = el('div', 'grow stack');
    body.append(el('div', 'small', note.text), el('div', 'tiny muted', ago(note.at)));
    row.append(body);
    container.append(row);
  }
}

function renderDashboard() {
  if (!me()) return;
  $('me-name').textContent = me().name;
  renderBalance();
  renderStats();
  renderFriends();
  renderTransactions();
  renderActivity();
  renderNotifications();
}

// ---------------------------------------------------------------------------
// Toasts + notifications
// ---------------------------------------------------------------------------

function toast(text, tone = '') {
  const node = el('div', `toast ${tone}`, text);
  $('toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 250);
  }, 4200);
}

function notify(text, tone = '') {
  state.notifications.unshift({ text, at: new Date().toISOString() });
  state.notifications = state.notifications.slice(0, 50);
  state.unread += 1;
  toast(text, tone);
  renderNotifications();
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

let lastFocused = null;

function closeModal() {
  $('modal-root').replaceChildren();
  state.watching = null;
  lastFocused?.focus();
}

function openModal(build) {
  lastFocused = document.activeElement;
  const overlay = el('div', 'overlay');
  const modal = el('div', 'modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  overlay.onclick = (event) => {
    if (event.target === overlay) closeModal();
  };
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') closeModal();
    },
    { once: true },
  );
  build(modal);
  overlay.append(modal);
  $('modal-root').replaceChildren(overlay);
  modal.querySelector('input, select, button')?.focus();
  return modal;
}

/** Step 1 of the send flow: who, how much, why. */
function openSend(presetFriendId) {
  const friends = state.accounts.filter((account) => account.id !== state.meId);
  if (friends.length === 0) {
    toast('There is nobody to pay yet - create another account first.', 'warn');
    return;
  }

  openModal((modal) => {
    modal.append(el('h2', null, 'Send money'));

    const form = el('form');
    form.style.marginTop = '14px';
    form.innerHTML = `
      <label class="field"><span>To</span>
        <select id="send-to">${friends
          .map((friend) => `<option value="${friend.id}">${friend.name}</option>`)
          .join('')}</select>
      </label>
      <label class="field"><span>Amount (dollars)</span>
        <input id="send-amount" type="number" min="0.01" step="0.01" placeholder="25.00" />
      </label>
      <label class="field"><span>Note (optional)</span>
        <input id="send-note" maxlength="140" placeholder="Dinner last night" />
      </label>
      <label class="field"><span>Settlement behaviour (demo)</span>
        <select id="send-mode">
          <option value="NONE">Normal</option>
          <option value="TRANSIENT">Transient fault - retries, then succeeds</option>
          <option value="PERMANENT">Permanent fault - retries, gives up, refunds</option>
        </select>
      </label>
      <p class="tiny muted" style="margin: -6px 0 10px">
        A transient fault is the common case in real systems: something breaks
        briefly. The saga retries with backoff and the payment still completes.
        Only a permanent fault exhausts the retries and gets the money returned.
      </p>
      <div id="send-error" class="small hidden" style="color: var(--bad); margin-top: 10px"></div>
      <div class="row" style="margin-top: 16px">
        <button type="button" id="send-cancel" class="grow">Cancel</button>
        <button type="submit" class="primary grow">Review</button>
      </div>
    `;
    modal.append(form);
    if (presetFriendId) form.querySelector('#send-to').value = presetFriendId;

    form.querySelector('#send-cancel').onclick = closeModal;
    form.onsubmit = (event) => {
      event.preventDefault();
      const error = form.querySelector('#send-error');
      const dollars = Number(form.querySelector('#send-amount').value);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        error.textContent = 'Enter an amount greater than zero.';
        error.classList.remove('hidden');
        return;
      }
      // Dollars are a display unit. Everything past this line is integer cents.
      const amountCents = Math.round(dollars * 100);
      const balance = state.balances[state.meId] ?? me().balanceCents;
      if (amountCents > balance) {
        error.textContent = `That is more than your ${fmt(balance)} balance. It will be declined.`;
        error.classList.remove('hidden');
      }
      openReview({
        toAccountId: form.querySelector('#send-to').value,
        amountCents,
        note: form.querySelector('#send-note').value.trim(),
        simulate: form.querySelector('#send-mode').value,
      });
    };
  });
}

/** Step 2: confirm before any money moves. */
function openReview(draft) {
  openModal((modal) => {
    modal.append(el('h2', null, 'Review payment'));
    modal.append(el('div', 'review-amount', fmt(draft.amountCents)));

    const lines = [
      ['From', me().name],
      ['To', nameOf(draft.toAccountId)],
      ['Note', draft.note || '—'],
    ];
    if (draft.simulate && draft.simulate !== 'NONE') {
      lines.push(['Mode', draft.simulate === 'TRANSIENT' ? 'Transient fault (recovers)' : 'Permanent fault (refunds)']);
    }
    for (const [key, value] of lines) {
      const line = el('div', 'review-line');
      line.append(el('span', 'muted small', key), el('span', null, value));
      modal.append(line);
    }

    const actions = el('div', 'row');
    actions.style.marginTop = '18px';
    const back = el('button', 'grow', 'Back');
    const confirm = el('button', 'primary grow', 'Confirm & send');
    back.onclick = () => openSend(draft.toAccountId);
    confirm.onclick = () => submitPayment(draft, confirm);
    actions.append(back, confirm);
    modal.append(actions);
  });
}

/** Step 3: the saga, watched live. */
function openProgress(payment) {
  state.watching = payment.id;
  const modal = openModal((node) => {
    node.append(el('h2', null, 'Sending payment'));
    node.append(el('div', 'review-amount', fmt(payment.amountCents)));
    const steps = el('div', 'steps');
    steps.id = 'saga-steps';
    node.append(steps);
    const footer = el('div');
    footer.id = 'saga-footer';
    node.append(footer);
  });
  renderProgress(payment);
  return modal;
}

const SAGA_STEPS = [
  ['Payment authorised', 'Money taken from your balance and held in the clearing account.'],
  ['Settling', 'Moving the held funds on to the receiver.'],
  ['Done', ''],
];

function renderProgress(payment) {
  const steps = $('saga-steps');
  const footer = $('saga-footer');
  if (!steps || !footer) return;

  const status = payment.status;
  const marks =
    status === 'PROCESSING'
      ? ['done', 'active', 'todo']
      : status === 'COMPLETED'
        ? ['done', 'done', 'done']
        : status === 'FAILED'
          ? ['error', 'todo', 'todo']
          : status === 'AWAITING_REFUND'
            ? ['done', 'error', 'warn']
            : ['done', 'error', 'done']; // REFUNDED

  const labels = [...SAGA_STEPS];
  if (status === 'FAILED') labels[0] = ['Declined', humanise(payment.failureReason)];
  if (status === 'AWAITING_REFUND') {
    labels[1] = ['Settlement failed', humanise(payment.failureReason)];
    labels[2] = ['Refund pending', 'Your money is in clearing and is being returned automatically.'];
  }
  if (status === 'REFUNDED') {
    labels[1] = ['Settlement failed', humanise(payment.failureReason)];
    labels[2] = ['Refunded', 'Every cent is back in your balance.'];
  }
  if (status === 'COMPLETED') labels[2] = ['Delivered', `${nameOf(payment.toAccountId)} has the money.`];

  steps.replaceChildren();
  labels.forEach(([title, detail], index) => {
    const mark = marks[index];
    const step = el('div', `step ${mark}`);
    const glyph = mark === 'done' ? '✓' : mark === 'error' ? '!' : mark === 'warn' ? '⟲' : '';
    step.append(el('div', 'dot', glyph));
    const body = el('div', 'body stack');
    body.append(el('div', null, title));
    if (detail) body.append(el('div', 'tiny muted', detail));
    step.append(body);
    steps.append(step);
  });

  footer.replaceChildren();
  if (status === 'PROCESSING') {
    footer.append(el('div', 'tiny muted', 'Watching the event stream…'));
    return;
  }

  const tone = status === 'COMPLETED' ? 'good' : status === 'REFUNDED' ? 'warn' : status === 'AWAITING_REFUND' ? 'warn' : 'bad';
  const glyph = status === 'COMPLETED' ? '✓' : status === 'FAILED' ? '✕' : '⟲';
  footer.append(el('div', `result-icon ${tone}`, glyph));

  const actions = el('div', 'row');
  if (status === 'AWAITING_REFUND') {
    const now = el('button', 'primary grow', 'Refund now');
    now.onclick = async () => {
      now.disabled = true;
      now.textContent = 'Refunding…';
      try {
        await api(`${WRITE}/payments/${payment.id}/refund`, { method: 'POST' });
      } catch (err) {
        toast(humanise(err.code), 'bad');
        now.disabled = false;
        now.textContent = 'Refund now';
      }
    };
    actions.append(now);
  }
  const done = el('button', actions.children.length ? 'grow' : 'primary grow', 'Done');
  done.onclick = closeModal;
  actions.append(done);
  footer.append(actions);
}

async function submitPayment(draft, button) {
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    const payment = await api(`${WRITE}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Generated per attempt, stable across retries of this attempt. The
        // user never sees or types one.
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        fromAccountId: state.meId,
        toAccountId: draft.toAccountId,
        amountCents: draft.amountCents,
        note: draft.note || undefined,
        simulate: draft.simulate && draft.simulate !== 'NONE' ? draft.simulate : undefined,
      }),
    });
    openProgress(payment);
    scheduleRefresh();
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Confirm & send';
    toast(humanise(err.code), 'bad');
  }
}

/** The audit trail behind a payment: its status and every ledger leg. */
async function openDetail(paymentId) {
  openModal((modal) => {
    modal.append(el('h2', null, 'Payment'));
    const loading = el('div', 'skeleton');
    loading.style.marginTop = '14px';
    modal.append(loading);
  });

  let payment;
  try {
    payment = await api(`${WRITE}/payments/${paymentId}`);
  } catch (err) {
    closeModal();
    toast(humanise(err.code), 'bad');
    return;
  }

  openModal((modal) => {
    const outgoing = payment.fromAccountId === state.meId;
    modal.append(el('h2', null, 'Payment'));
    modal.append(el('div', 'review-amount', fmt(payment.amountCents)));

    const head = el('div', 'row');
    head.style.justifyContent = 'center';
    head.append(
      el('span', `badge ${payment.status}`, STATUS_LABEL[payment.status] ?? payment.status),
    );
    modal.append(head);

    const lines = [
      ['From', nameOf(payment.fromAccountId)],
      ['To', nameOf(payment.toAccountId)],
      ['Direction', outgoing ? 'Sent' : 'Received'],
      ['Note', payment.note || '—'],
      ['Created', new Date(payment.createdAt).toLocaleString()],
      ['Updated', new Date(payment.updatedAt).toLocaleString()],
    ];
    if (payment.failureReason) lines.push(['Reason', humanise(payment.failureReason)]);
    const table = el('div');
    table.style.marginTop = '12px';
    for (const [key, value] of lines) {
      const line = el('div', 'review-line');
      line.append(el('span', 'muted small', key), el('span', 'small', value));
      table.append(line);
    }
    modal.append(table);

    modal.append(el('h3', null, 'Ledger entries'));
    const ledger = el('div', 'list');
    ledger.style.marginTop = '8px';
    if (payment.ledger.length === 0) {
      ledger.append(el('div', 'empty', 'No money moved, so nothing was written to the ledger.'));
    }
    for (const entry of payment.ledger) {
      const row = el('div', 'item flat');
      const body = el('div', 'grow stack');
      body.append(
        el('div', 'small', `${entry.leg} · ${entry.direction} ${entry.accountName}`),
        el('div', 'tiny muted', new Date(entry.createdAt).toLocaleTimeString()),
      );
      row.append(body, el('div', `amount ${entry.direction === 'DEBIT' ? 'out' : 'in'}`, fmt(entry.amountCents)));
      ledger.append(row);
    }
    modal.append(ledger);
    modal.append(
      el(
        'div',
        'tiny muted',
        'Every leg is one debit and one credit. A refund appends new opposite entries - nothing is ever edited or deleted.',
      ),
    );

    const actions = el('div', 'row');
    actions.style.marginTop = '16px';
    if (payment.status === 'AWAITING_REFUND') {
      const refund = el('button', 'danger grow', 'Refund now');
      refund.onclick = async () => {
        refund.disabled = true;
        refund.textContent = 'Refunding…';
        try {
          await api(`${WRITE}/payments/${payment.id}/refund`, { method: 'POST' });
          closeModal();
          toast('Refunded - the money is back in your balance.', 'good');
        } catch (err) {
          refund.disabled = false;
          refund.textContent = 'Refund now';
          toast(humanise(err.code), 'bad');
        }
      };
      actions.append(refund);
    }
    const close = el('button', 'primary grow', 'Close');
    close.onclick = closeModal;
    actions.append(close);
    modal.append(actions);
  });
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

function setLive(connected) {
  $('live-dot').className = `live-dot ${connected ? 'on' : 'off'}`;
  $('live-label').textContent = connected ? 'live' : 'reconnecting…';
}

function connectStream() {
  // EventSource reconnects by itself, which is most of why this is SSE and
  // not a WebSocket.
  const stream = new EventSource(`${READ}/events/stream`);
  stream.addEventListener('hello', () => setLive(true));
  stream.onerror = () => setLive(false);
  stream.addEventListener('payment-event', (message) => {
    setLive(true);
    const { event } = JSON.parse(message.data);
    handleEvent(event);
  });
}

function handleEvent(event) {
  if (event.type === 'account.created') {
    loadAccounts().then(scheduleRefresh);
    return;
  }

  const outgoing = event.fromAccountId === state.meId;
  const incoming = event.toAccountId === state.meId;
  if (outgoing || incoming) {
    const other = nameOf(outgoing ? event.toAccountId : event.fromAccountId);
    const amount = fmt(event.amountCents);
    if (event.type === 'payment.completed') {
      notify(outgoing ? `You paid ${other} ${amount}` : `${other} sent you ${amount}`, 'good');
    } else if (event.type === 'payment.failed' && outgoing) {
      notify(`Payment to ${other} declined: ${humanise(event.failureReason)}`, 'bad');
    } else if (event.type === 'payment.stuck' && outgoing) {
      notify(`${amount} to ${other} is stuck - a refund is on its way`, 'warn');
    } else if (event.type === 'payment.refunded' && outgoing) {
      notify(`${amount} refunded to you`, 'warn');
    }
  }

  // If the send modal is watching this payment, advance it in place.
  if (state.watching && event.paymentId === state.watching && event.type !== 'payment.initiated') {
    api(`${WRITE}/payments/${state.watching}`)
      .then((payment) => renderProgress(payment))
      .catch(() => undefined);
  }

  scheduleRefresh();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function signIn(accountId) {
  state.meId = accountId;
  localStorage.setItem('walletUserId', accountId);
  state.notifications = [];
  state.unread = 0;
  showApp();
}

async function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('transactions').replaceChildren(el('div', 'skeleton'), el('div', 'skeleton'));
  await loadReadModel();
  renderDashboard();
}

function wireControls() {
  $('send-btn').onclick = () => openSend();
  $('switch-user').onclick = () => {
    localStorage.removeItem('walletUserId');
    state.meId = null;
    renderLogin();
  };
  $('bell-btn').onclick = () => {
    const panel = $('bell-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      state.unread = 0;
      renderNotifications();
    }
  };
  $('clear-notifications').onclick = () => {
    state.notifications = [];
    state.unread = 0;
    renderNotifications();
  };
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.bell')) $('bell-panel').classList.add('hidden');
  });
  for (const id of ['search', 'filter-status', 'filter-direction']) {
    $(id).addEventListener('input', renderTransactions);
  }
  $('create-account').onclick = async () => {
    const name = $('new-name').value.trim();
    const dollars = Number($('new-balance').value);
    if (!name) return toast('Give the account a name.', 'warn');
    if (!Number.isFinite(dollars) || dollars < 0) return toast('Opening balance must be zero or more.', 'warn');
    try {
      const account = await api(`${WRITE}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, initialBalanceCents: Math.round(dollars * 100) }),
      });
      await loadAccounts();
      renderLogin();
      toast(`Created ${account.name}.`, 'good');
    } catch (err) {
      toast(humanise(err.code), 'bad');
    }
  };
}

async function boot() {
  wireControls();
  try {
    await loadAccounts();
  } catch {
    document.body.prepend(
      el(
        'div',
        'empty',
        'Cannot reach the payment service on :4000. Is docker compose up running?',
      ),
    );
    return;
  }

  if (state.meId && state.byId.has(state.meId)) await showApp();
  else renderLogin();

  connectStream();
  // Relative timestamps go stale on a page nobody touches.
  setInterval(() => {
    if (!$('app').classList.contains('hidden')) {
      renderTransactions();
      renderActivity();
    }
  }, 30_000);
}

boot();
