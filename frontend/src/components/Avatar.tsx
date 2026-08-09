import { initials } from '../lib/money';

export function Avatar({ name }: { name: string | undefined }) {
  return <div className="avatar">{initials(name)}</div>;
}
