import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLimits, listAccounts } from '../../api/accounts';
import * as readModel from '../../api/read-model';
import { useToasts } from '../../hooks/useToasts';
import type {
  Account,
  AccountLimitsView,
  ActivityEntry,
  ProjectedPayment,
  Stats,
} from '../../types/api';

const STORAGE_KEY = 'walletUserId';

/** A burst of events - a payment fires initiated then completed - should cause
 *  one refresh, not four. */
const REFRESH_DEBOUNCE_MS = 120;

export interface WalletData {
  meId: string | null;
  me: Account | undefined;
  accounts: Account[];
  nameOf: (id: string) => string;
  balances: Record<string, number>;
  transactions: ProjectedPayment[];
  activity: ActivityEntry[];
  stats: Stats | null;
  /** Spending controls and today's usage. Null until first loaded. */
  limits: AccountLimitsView | null;
  /** True once the account list has been fetched at least once. */
  ready: boolean;
  /** True once the read model has answered at least once for this user. */
  hydrated: boolean;
  /** Set when the write side itself is unreachable. */
  offline: boolean;
  signIn: (accountId: string) => void;
  signOut: () => void;
  reloadAccounts: () => Promise<void>;
  scheduleRefresh: () => void;
}

export function useWalletData(): WalletData {
  const { toast } = useToasts();

  const [meId, setMeId] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [transactions, setTransactions] = useState<ProjectedPayment[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [limits, setLimits] = useState<AccountLimitsView | null>(null);
  const [ready, setReady] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [offline, setOffline] = useState(false);

  const byId = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const me = meId ? byId.get(meId) : undefined;

  const nameOf = useCallback(
    (id: string) => byId.get(id)?.name ?? `${String(id).slice(0, 8)}…`,
    [byId],
  );

  const reloadAccounts = useCallback(async () => {
    try {
      setAccounts(await listAccounts());
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setReady(true);
    }
  }, []);

  // Held in refs so the debounced refresh always reads current values without
  // being torn down and recreated on every render.
  const degradedRef = useRef(false);
  const stateRef = useRef({ meId, accounts, balances, transactions, activity, stats });
  stateRef.current = { meId, accounts, balances, transactions, activity, stats };

  const loadReadModel = useCallback(async () => {
    const current = stateRef.current;
    if (!current.meId) return;

    let degraded = false;
    const orDefault = <T,>(promise: Promise<T>, fallback: T): Promise<T> =>
      promise.catch(() => {
        degraded = true;
        return fallback;
      });

    const ids = current.accounts.map((account) => account.id);
    const [balanceResult, transactionResult, statsResult, activityResult] =
      await Promise.all([
        orDefault(readModel.getBalances(ids), { balances: current.balances }),
        orDefault(readModel.getTransactions(current.meId), {
          transactions: current.transactions,
        }),
        orDefault(readModel.getStats(current.meId), current.stats as Stats),
        orDefault(readModel.getActivity(), { activity: current.activity }),
      ]);

    setBalances(balanceResult.balances);
    setTransactions(transactionResult.transactions);
    setStats(statsResult);
    setActivity(activityResult.activity);

    // The write side is still fine when this happens - only the read model is
    // unreachable - so say that rather than implying the money is in danger.
    if (degraded && !degradedRef.current) {
      toast('Read model is not responding. Balances may be out of date.', 'warn');
    }
    degradedRef.current = degraded;
    setHydrated(true);

    // Limits live on the write side, so they are fetched separately: a read
    // model outage must not blank out the caps that are still being enforced.
    getLimits(current.meId)
      .then(setLimits)
      .catch(() => undefined);
  }, [toast]);

  const refreshTimer = useRef<number | undefined>(undefined);
  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      loadReadModel().catch((err) => console.error('refresh failed', err));
    }, REFRESH_DEBOUNCE_MS);
  }, [loadReadModel]);

  useEffect(() => {
    void reloadAccounts();
  }, [reloadAccounts]);

  // Signing in, or arriving with a stored id, pulls the read model once.
  useEffect(() => {
    if (meId) void loadReadModel();
  }, [meId, loadReadModel]);

  const signIn = useCallback((accountId: string) => {
    localStorage.setItem(STORAGE_KEY, accountId);
    setMeId(accountId);
    setHydrated(false);
  }, []);

  const signOut = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setMeId(null);
    setHydrated(false);
  }, []);

  return {
    meId,
    me,
    accounts,
    nameOf,
    balances,
    transactions,
    activity,
    stats,
    limits,
    ready,
    hydrated,
    offline,
    signIn,
    signOut,
    reloadAccounts,
    scheduleRefresh,
  };
}
