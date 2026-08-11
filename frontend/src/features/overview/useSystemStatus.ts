import { useCallback, useEffect, useState } from 'react';
import { listAccounts } from '../../api/accounts';
import { getTrialBalance } from '../../api/ledger';
import { getOverview } from '../../api/kafka';
import { listReviews } from '../../api/payments';
import { getReconciliation } from '../../api/reconciliation';
import { useInterval } from '../../hooks/useInterval';
import { CLEARING_ACCOUNT_ID, READ_URL, WRITE_URL } from '../../lib/config';
import type { KafkaOverview, ReconciliationRun, TrialBalance } from '../../types/api';

export interface SystemStatus {
  writeUp: boolean | null;
  readUp: boolean | null;
  books: TrialBalance | null;
  clearingCents: number | null;
  reviewCount: number | null;
  kafka: KafkaOverview | null;
  recon: ReconciliationRun | null;
}

const EMPTY: SystemStatus = {
  writeUp: null,
  readUp: null,
  books: null,
  clearingCents: null,
  reviewCount: null,
  kafka: null,
  recon: null,
};

const ping = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(4_000) })
    .then((res) => res.ok)
    .catch(() => false);

/**
 * Everything the landing page needs to say whether the system is healthy.
 *
 * Each source is settled independently rather than in one all-or-nothing
 * await: this is the page someone opens *because* something looks wrong, so
 * one service being down has to leave the rest of the panel readable instead
 * of blanking it.
 */
export function useSystemStatus(enabled = true, everyMs = 5_000): SystemStatus {
  const [status, setStatus] = useState<SystemStatus>(EMPTY);

  const load = useCallback(async () => {
    const [writeUp, readUp, books, accounts, reviews, kafka, recon] = await Promise.all([
      ping(`${WRITE_URL}/health`),
      ping(`${READ_URL}/health`),
      getTrialBalance().catch(() => null),
      listAccounts(true).catch(() => null),
      listReviews(200).catch(() => null),
      getOverview().catch(() => null),
      getReconciliation(1).catch(() => null),
    ]);

    setStatus({
      writeUp,
      readUp,
      books,
      clearingCents:
        accounts?.find((account) => account.id === CLEARING_ACCOUNT_ID)?.balanceCents ?? null,
      reviewCount: reviews?.reviews.length ?? null,
      kafka,
      recon: recon?.latest ?? null,
    });
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  // Six endpoints on a timer is not something to run behind a page that never
  // renders it, so the interval is switched off rather than merely slowed.
  useInterval(() => void load(), enabled ? everyMs : null);

  return status;
}
