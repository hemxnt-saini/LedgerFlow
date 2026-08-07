/* Developer event monitor. Shows the real pipeline, with measured timings. */

const WRITE = `http://${location.hostname}:4000`;
const READ = `http://${location.hostname}:4001`;
const CLEARING_ID = '00000000-0000-4000-8000-000000000001';

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = (cents) => money.format((Number(cents) || 0) / 100);
const ms = (value) => `${Math.round(value)}ms`;

const state = { traces: [], byId: new Map(), names: new Map() };

const setLive = (connected) => {
  $('live-dot').className = `live-dot ${connected ? 'on' : 'off'}`;
  $('live-label').textContent = connected ? 'live' : 'reconnecting…';
};

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function renderStages() {
  const sample = state.traces.slice(0, 50);
  $('sample-size').textContent = sample.length ? `median of last ${sample.length}` : '';
  for (const [id, key] of [
    ['s-outbox', 'outboxMs'],
    ['s-transport', 'transportMs'],
    ['s-projection', 'projectionMs'],
    ['s-total', 'totalMs'],
  ]) {
    const value = median(sample.map((trace) => trace.stages[key]));
    $(id).textContent = value === null ? '–' : ms(value);
  }
}

function renderTypes() {
  const counts = new Map();
  for (const trace of state.traces) counts.set(trace.type, (counts.get(trace.type) ?? 0) + 1);
  const container = $('types');
  container.replaceChildren();
  if (counts.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'None yet.';
    container.append(empty);
    return;
  }
  for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    const row = document.createElement('div');
    row.className = 'item flat';
    const label = document.createElement('div');
    label.className = 'grow mono small';
    label.textContent = type;
    const value = document.createElement('div');
    value.className = 'amount';
    value.textContent = String(count);
    row.append(label, value);
    container.append(row);
  }
}

function renderDetail(trace) {
  const detail = $('detail');
  detail.replaceChildren();
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(
    { event: state.byId.get(trace.eventId) ?? '(loaded from history)', trace },
    null,
    2,
  );
  detail.append(pre);
}

function addRow(trace, fresh) {
  const tbody = $('events');
  const row = document.createElement('tr');
  if (fresh) row.className = 'fresh';

  const cells = [
    new Date(trace.projectedAt).toLocaleTimeString(),
    trace.type,
    trace.paymentId ? `${trace.paymentId.slice(0, 8)}…` : '—',
  ];
  for (const text of cells) {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (text === trace.type) cell.className = 'mono';
    row.append(cell);
  }
  for (const key of ['outboxMs', 'transportMs', 'projectionMs', 'totalMs']) {
    const cell = document.createElement('td');
    cell.className = 'num';
    cell.textContent = ms(trace.stages[key]);
    row.append(cell);
  }
  row.onclick = () => renderDetail(trace);

  tbody.prepend(row);
  while (tbody.children.length > 200) tbody.lastElementChild.remove();
  $('events-empty').classList.add('hidden');
  $('event-count').textContent = `${state.traces.length} events`;
}

function render() {
  const tbody = $('events');
  tbody.replaceChildren();
  for (const trace of [...state.traces].reverse()) addRow(trace, false);
  $('events-empty').classList.toggle('hidden', state.traces.length > 0);
  $('event-count').textContent = `${state.traces.length} events`;
  renderStages();
  renderTypes();
}

async function refreshClearing() {
  try {
    const accounts = await fetch(`${WRITE}/accounts?includeSystem=true`).then((r) => r.json());
    state.names = new Map(accounts.map((account) => [account.id, account.name]));
    const clearing = accounts.find((account) => account.id === CLEARING_ID);
    $('clearing').textContent = fmt(clearing?.balanceCents ?? 0);
  } catch {
    $('clearing').textContent = '–';
  }
}

async function boot() {
  $('clear').onclick = () => {
    state.traces = [];
    state.byId.clear();
    render();
    $('detail').textContent = 'Click a row to inspect its payload and timings.';
  };

  try {
    const { traces } = await fetch(`${READ}/pipeline?limit=200`).then((r) => r.json());
    state.traces = traces;
  } catch {
    // The read side may not be up yet; the live stream will fill in.
  }
  render();
  await refreshClearing();

  const stream = new EventSource(`${READ}/events/stream`);
  stream.addEventListener('hello', () => setLive(true));
  stream.onerror = () => setLive(false);
  stream.addEventListener('payment-event', (message) => {
    setLive(true);
    const { event, trace } = JSON.parse(message.data);
    state.byId.set(trace.eventId, event);
    state.traces.unshift(trace);
    state.traces = state.traces.slice(0, 200);
    addRow(trace, true);
    renderStages();
    renderTypes();
    refreshClearing();
  });
}

boot();
