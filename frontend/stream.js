/* Kafka control room. Everything shown here is read from the broker itself. */

const WRITE = `http://${location.hostname}:4000`;
const READ = `http://${location.hostname}:4001`;

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const state = { overview: null, messages: [], lastLag: 0 };

const setLive = (connected) => {
  $('live-dot').className = `live-dot ${connected ? 'on' : 'off'}`;
  $('live-label').textContent = connected ? 'live' : 'reconnecting…';
};

function toast(text, tone = '') {
  const node = el('div', `toast ${tone}`, text);
  $('toasts').append(node);
  setTimeout(() => node.remove(), 4200);
}

const mainTopic = () =>
  state.overview?.topics.find((topic) => topic.topic === state.overview.mainTopic);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderPartitions() {
  const topic = mainTopic();
  const container = $('partitions');
  container.replaceChildren();
  if (!topic) return;

  $('topic-name').textContent = topic.topic;
  $('k-messages').textContent = String(topic.messages);
  $('k-partitions').textContent = String(topic.partitions.length);
  $('k-lag').textContent = String(topic.lag);
  const dlq = state.overview.topics.find((t) => t.topic === state.overview.dlqTopic);
  $('k-dlq').textContent = String(dlq?.messages ?? 0);

  for (const partition of topic.partitions) {
    const row = el('div', 'partition');
    const head = el('div', 'partition-head');
    head.append(
      el('span', `pill p${partition.partition % 3}`, `${topic.topic}-${partition.partition}`),
      el(
        'span',
        'tiny muted',
        `offsets ${partition.low}–${partition.high}` +
          (partition.committed === null
            ? ' · never committed'
            : ` · read to ${partition.committed}`) +
          (partition.lag > 0 ? ` · ${partition.lag} behind` : ''),
      ),
    );
    row.append(head);

    // The log as a line: how much has been consumed, how much is waiting.
    const bar = el('div', 'logbar');
    const total = Math.max(partition.high - partition.low, 0);
    const position = partition.committed === null ? partition.low : partition.committed;
    const readCount = Math.max(position - partition.low, 0);
    if (total > 0) {
      const read = el('div', 'read');
      read.style.width = `${(readCount / total) * 100}%`;
      const unread = el('div', 'unread');
      unread.style.width = `${(partition.lag / total) * 100}%`;
      bar.append(read, unread);

      const ticks = el('div', 'ticks');
      for (let i = 0; i < Math.min(total, 40); i++) ticks.append(el('div', 'tick'));
      bar.append(ticks);
    }
    row.append(bar);
    container.append(row);
  }
}

function renderGroups() {
  const container = $('groups');
  container.replaceChildren();
  const groups = state.overview?.groups ?? [];
  if (groups.length === 0) {
    container.append(el('div', 'empty', 'No consumer groups yet.'));
    return;
  }
  for (const group of groups) {
    const row = el('div', 'item flat');
    const body = el('div', 'grow stack');
    body.append(
      el('div', 'small mono', group.groupId),
      el(
        'div',
        'tiny muted',
        `${group.state} · ${group.members.length} member(s)` +
          (group.members[0]?.assignment.length
            ? ` · owns ${group.members[0].assignment.join(', ')}`
            : ''),
      ),
    );
    row.append(body);
    container.append(row);
  }
}

async function renderDlq() {
  const container = $('dlq');
  try {
    const { entries } = await fetch(`${READ}/dlq?limit=10`).then((r) => r.json());
    container.replaceChildren();
    if (entries.length === 0) {
      container.append(el('div', 'empty', 'Nothing parked. Good.'));
      return;
    }
    for (const entry of entries) {
      const row = el('div', 'item flat');
      const body = el('div', 'grow stack');
      body.append(
        el('div', 'small', entry.reason + (entry.replayedAt ? ' · replayed' : '')),
        el('div', 'tiny muted truncate', `${entry.sourceTopic}-${entry.partition}@${entry.offset} · ${entry.detail}`),
      );
      const replay = el('button', 'tiny', 'Replay');
      replay.onclick = async () => {
        replay.disabled = true;
        await fetch(`${READ}/dlq/${entry.dlqId}/replay`, { method: 'POST' });
        toast('Replayed onto the main topic.', 'good');
        setTimeout(renderDlq, 1500);
      };
      row.append(body, replay);
      container.append(row);
    }
  } catch {
    container.replaceChildren(el('div', 'empty', 'Could not reach the read side.'));
  }
}

function renderPaused() {
  const paused = state.overview?.consumerPaused ?? false;
  $('paused-pill').classList.toggle('hidden', !paused);
  $('paused-banner').classList.toggle('hidden', !paused);
  $('pause').classList.toggle('hidden', paused);
  $('resume').classList.toggle('hidden', !paused);
}

function addMessage(event, trace) {
  const partition = trace.partition ?? 0;
  const tbody = $('messages');
  const row = document.createElement('tr');
  row.className = 'fresh';
  const cells = [
    new Date(trace.projectedAt).toLocaleTimeString(),
    null, // partition pill
    event.type,
    (event.paymentId ?? event.accountId ?? '—').slice(0, 8),
    String(state.lastLag),
  ];
  cells.forEach((text, index) => {
    const cell = document.createElement('td');
    if (index === 1) {
      cell.append(el('span', `pill p${partition % 3}`, `p${partition}`));
    } else {
      cell.textContent = text;
      if (index === 2) cell.className = 'mono';
      if (index === 4) cell.className = 'num';
    }
    row.append(cell);
  });
  tbody.prepend(row);
  while (tbody.children.length > 150) tbody.lastElementChild.remove();
  $('messages-empty').classList.add('hidden');
  $('msg-count').textContent = `${tbody.children.length} messages`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function refresh() {
  try {
    state.overview = await fetch(`${READ}/kafka/overview`).then((r) => r.json());
    state.lastLag = mainTopic()?.lag ?? 0;
    renderPartitions();
    renderGroups();
    renderPaused();
  } catch {
    setLive(false);
  }
}

async function boot() {
  $('pause').onclick = async () => {
    await fetch(`${READ}/kafka/consumer/pause`, { method: 'POST' });
    toast('Consumer paused. Send payments and watch lag build.', 'warn');
    await refresh();
  };
  $('resume').onclick = async () => {
    await fetch(`${READ}/kafka/consumer/resume`, { method: 'POST' });
    toast('Consumer resumed. The backlog is draining.', 'good');
    await refresh();
  };
  $('rebuild').onclick = async () => {
    const out = $('control-out');
    out.classList.remove('hidden');
    out.textContent = 'Deleting the read model and rewinding to offset 0…';
    const result = await fetch(`${READ}/kafka/consumer/rebuild`, { method: 'POST' }).then((r) =>
      r.json(),
    );
    out.textContent = JSON.stringify(result, null, 2);
    toast('Read model wiped. Rebuilding from the log.', 'warn');
  };
  $('burst').onclick = async () => {
    const accounts = await fetch(`${WRITE}/accounts`).then((r) => r.json());
    if (accounts.length < 2) return toast('Run scripts/seed.sh first.', 'warn');
    for (let i = 0; i < 5; i++) {
      await fetch(`${WRITE}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          fromAccountId: accounts[0].id,
          toAccountId: accounts[1 + (i % (accounts.length - 1))].id,
          amountCents: 100 + i,
          note: 'burst',
        }),
      });
    }
    toast('Sent 5 payments.', 'good');
    await refresh();
  };

  await refresh();
  await renderDlq();

  const stream = new EventSource(`${READ}/events/stream`);
  stream.addEventListener('hello', () => setLive(true));
  stream.onerror = () => setLive(false);
  stream.addEventListener('payment-event', (message) => {
    setLive(true);
    const { event, trace } = JSON.parse(message.data);
    addMessage(event, trace);
    refresh();
  });
  stream.addEventListener('dead-letter', () => {
    toast('A message was parked in the DLQ.', 'warn');
    renderDlq();
  });

  // Lag only changes when the broker moves, and while paused nothing arrives
  // on the stream to trigger a redraw - so poll slowly as well.
  setInterval(refresh, 2000);
}

boot();
