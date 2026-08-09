import { STATUS_LABEL } from '../lib/labels';
import type { PaymentStatus } from '../types/api';

/** The class name is the status, so the stylesheet colours it. */
export function StatusBadge({ status }: { status: PaymentStatus }) {
  return <span className={`badge ${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}
