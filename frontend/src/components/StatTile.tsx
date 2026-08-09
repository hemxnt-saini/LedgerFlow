export function StatTile({ label, value, id }: { label: string; value: string; id: string }) {
  return (
    <div className="stat">
      <div className="k">{label}</div>
      <div className="v" id={id}>
        {value}
      </div>
    </div>
  );
}
