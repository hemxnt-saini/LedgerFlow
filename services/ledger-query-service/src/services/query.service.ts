import * as readModel from '../repositories/read-model.repository';

/**
 * Assembles read responses. Everything here is O(1) or close to it, because
 * the projection already did the arithmetic on the way in - the read side
 * never scans history to answer a question.
 */

const SOURCE = 'redis-read-model' as const;

export async function getBalance(accountId: string) {
  const account = await readModel.findAccount(accountId);
  if (!account) return null;
  return {
    accountId,
    name: account.name,
    balanceCents: account.balanceCents,
    source: SOURCE,
  };
}

export async function getBalances(ids: string[]) {
  return { balances: await readModel.findBalances(ids), source: SOURCE };
}

export async function getTransactions(accountId: string, limit: number) {
  return {
    accountId,
    transactions: await readModel.findPaymentsForAccount(accountId, limit),
    source: SOURCE,
  };
}

const emptyCounters = () => ({
  sentCents: 0,
  receivedCents: 0,
  sentCount: 0,
  receivedCount: 0,
});

const sum = (buckets: readModel.Counters[]) =>
  buckets.reduce(
    (total, bucket) => ({
      sentCents: total.sentCents + bucket.sentCents,
      receivedCents: total.receivedCents + bucket.receivedCents,
      sentCount: total.sentCount + bucket.sentCount,
      receivedCount: total.receivedCount + bucket.receivedCount,
    }),
    emptyCounters(),
  );

/** Lifetime totals plus today and this week, from seven day-buckets. */
export async function getStats(accountId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    return date.toISOString().slice(0, 10);
  });

  const [allTime, ...weekBuckets] = await Promise.all([
    readModel.findLifetimeCounters(accountId),
    ...days.map((day) => readModel.findDayCounters(accountId, day)),
  ]);

  return {
    accountId,
    allTime,
    today: weekBuckets[days.indexOf(today)] ?? emptyCounters(),
    thisWeek: sum(weekBuckets),
    source: SOURCE,
  };
}

export async function getActivity(limit: number) {
  return { activity: await readModel.findActivity(limit), source: SOURCE };
}

export async function getPipelineTraces(limit: number) {
  return { traces: await readModel.findPipelineTraces(limit) };
}
