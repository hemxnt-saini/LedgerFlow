import { useToasts } from '../hooks/useToasts';

export function Toasts() {
  const { toasts } = useToasts();
  return (
    <div id="toasts" className="toasts">
      {toasts.map((item) => (
        <div key={item.id} className={`toast ${item.tone}`.trim()}>
          {item.text}
        </div>
      ))}
    </div>
  );
}
