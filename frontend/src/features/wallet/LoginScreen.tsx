import { useState } from 'react';
import { createAccount } from '../../api/accounts';
import { ApiError } from '../../api/client';
import { Avatar } from '../../components/Avatar';
import { Card } from '../../components/Card';
import { useToasts } from '../../hooks/useToasts';
import { humanise } from '../../lib/labels';
import { fmt, toCents } from '../../lib/money';
import type { Account } from '../../types/api';

interface Props {
  hidden: boolean;
  accounts: Account[];
  onSignIn: (accountId: string) => void;
  onAccountCreated: () => Promise<void>;
}

/**
 * Pick-a-user. No passwords: authentication is deliberately out of scope, so
 * "logging in" just means choosing whose wallet to look at.
 */
export function LoginScreen({ hidden, accounts, onSignIn, onAccountCreated }: Props) {
  const { toast } = useToasts();
  const [name, setName] = useState('');
  const [balance, setBalance] = useState('250');
  const [creating, setCreating] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    const dollars = Number(balance);
    if (!trimmed) return toast('Give the account a name.', 'warn');
    if (!Number.isFinite(dollars) || dollars < 0) {
      return toast('Opening balance must be zero or more.', 'warn');
    }

    setCreating(true);
    try {
      const account = await createAccount(trimmed, toCents(dollars));
      await onAccountCreated();
      toast(`Created ${account.name}.`, 'good');
    } catch (err) {
      toast(humanise(err instanceof ApiError ? err.code : undefined), 'bad');
    } finally {
      setCreating(false);
    }
  }

  return (
    <section id="login" className={`login-wrap${hidden ? ' hidden' : ''}`}>
      <Card>
        <h1>Who are you?</h1>
        <p className="muted small" style={{ margin: '6px 0 16px' }}>
          No passwords - this demo is about moving money safely, not about auth. Pick an
          account to open its wallet.
        </p>

        <div id="people" className="people">
          {accounts.map((account) => (
            <button
              key={account.id}
              className="person"
              onClick={() => onSignIn(account.id)}
            >
              <Avatar name={account.name} />
              <div>{account.name}</div>
              <div className="small muted">{fmt(account.balanceCents)}</div>
            </button>
          ))}
        </div>

        <div id="login-empty" className={`empty${accounts.length > 0 ? ' hidden' : ''}`}>
          No accounts yet. Run <code className="mono">./scripts/seed.sh</code> to create a
          few, or add one below.
        </div>

        <details style={{ marginTop: 16 }}>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            Create an account
          </summary>
          <div style={{ marginTop: 12 }}>
            <label className="field">
              <span>Name</span>
              <input
                id="new-name"
                value={name}
                placeholder="Dana"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Opening balance (dollars)</span>
              <input
                id="new-balance"
                type="number"
                min="0"
                step="0.01"
                value={balance}
                onChange={(event) => setBalance(event.target.value)}
              />
            </label>
            <button
              id="create-account"
              className="primary wide"
              disabled={creating}
              onClick={submit}
            >
              {creating ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </details>
      </Card>
    </section>
  );
}
