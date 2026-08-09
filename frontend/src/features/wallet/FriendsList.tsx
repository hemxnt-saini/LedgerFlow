import { Avatar } from '../../components/Avatar';
import { Card, CardHead } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { fmt } from '../../lib/money';
import type { Account } from '../../types/api';

interface Props {
  friends: Account[];
  balances: Record<string, number>;
  onPay: (accountId: string) => void;
}

export function FriendsList({ friends, balances, onPay }: Props) {
  return (
    <Card>
      <CardHead title="Friends" aside="live balances" />
      <div id="friends" className="list">
        {friends.length === 0 ? (
          <EmptyState>No one else has an account yet. Create one to send money.</EmptyState>
        ) : (
          friends.map((friend) => (
            <div
              key={friend.id}
              className="item"
              tabIndex={0}
              onClick={() => onPay(friend.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onPay(friend.id);
                }
              }}
            >
              <Avatar name={friend.name} />
              <div className="grow stack">
                <div>{friend.name}</div>
                <div className="tiny muted">
                  {fmt(balances[friend.id] ?? friend.balanceCents)}
                </div>
              </div>
              <div className="small muted">Pay →</div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
