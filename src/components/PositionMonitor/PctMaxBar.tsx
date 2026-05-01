/**
 * Inline horizontal progress bar showing % of max profit reached.
 *
 * Color thresholds:
 *   ≥ 80%  → success (near max)
 *   ≥ 50%  → accent  (mid)
 *   < 50%  → caution (early)
 *
 * Renders an em-dash placeholder when `pct` is null. Used by both row
 * (PositionRow.tsx) and card (PositionCards.tsx) layouts.
 */
export function PctMaxBar({ pct }: Readonly<{ pct: number | null }>) {
  if (pct === null) return <span className="text-muted">{'—'}</span>;

  const clamped = Math.min(Math.max(pct, 0), 100);
  const barColor =
    pct >= 80 ? 'bg-success' : pct >= 50 ? 'bg-accent' : 'bg-caution';

  return (
    <div className="flex items-center gap-1.5">
      <div className="bg-edge h-2 w-12 overflow-hidden rounded-full">
        <div
          className={`h-full rounded-full ${barColor}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-xs">{pct.toFixed(0)}%</span>
    </div>
  );
}
