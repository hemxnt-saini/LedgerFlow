import type { ReactNode } from 'react';

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`card ${className}`.trim()}>{children}</div>;
}

export function CardHead({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="card-head">
      <h2>{title}</h2>
      {aside !== undefined && <span className="tiny muted">{aside}</span>}
    </div>
  );
}
