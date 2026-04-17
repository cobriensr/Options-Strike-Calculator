/**
 * ChainCard — compact summary row for one pyramid chain.
 *
 * The primary row is a single expand/collapse button (clicking the row toggles
 * the leg table below). Action buttons (Edit / Delete / Add Leg) live in a
 * separate cluster to the right so they don't hijack the expand click.
 *
 * Colour conventions:
 *   - net points: green > 0, red < 0, muted for null/zero
 *   - day_type badge: muted pill that echoes the chain's regime
 *   - exit_reason: plain text (concise), only when set
 *
 * Accessibility:
 *   - the expand button owns `aria-expanded` + `aria-controls`; the caller
 *     renders the LegTable inside a container whose `id` matches.
 *   - all action buttons have explicit `aria-label`s so screen reader users
 *     can target the correct chain without relying on visible text.
 */

import type { PyramidChain } from '../../types/pyramid';

export interface ChainCardProps {
  readonly chain: PyramidChain;
  readonly expanded: boolean;
  readonly contentId: string;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onAddLeg: () => void;
}

/** Format "N legs, MW" summary; falls back gracefully when counts are null. */
function formatLegSummary(
  total: number | null,
  winning: number | null,
): string {
  const totalPart = total != null ? `${total} legs` : '\u2014 legs';
  if (winning == null) return totalPart;
  return `${totalPart}, ${winning}W`;
}

/** Format `net_points` with sign + fixed precision; empty string for null. */
function formatNetPoints(pts: number | null): string {
  if (pts == null) return '\u2014';
  const sign = pts > 0 ? '+' : '';
  return `${sign}${pts.toFixed(2)} pts`;
}

/** Pick text colour class from net_points sign. */
function netPointsColor(pts: number | null): string {
  if (pts == null || pts === 0) return 'text-muted';
  return pts > 0 ? 'text-success' : 'text-danger';
}

/** Normalise exit_reason to a user-friendly string. */
function formatExitReason(reason: string | null): string {
  if (reason == null) return '';
  return reason
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

export default function ChainCard({
  chain,
  expanded,
  contentId,
  onToggle,
  onEdit,
  onDelete,
  onAddLeg,
}: ChainCardProps) {
  const legSummary = formatLegSummary(chain.total_legs, chain.winning_legs);
  const netLabel = formatNetPoints(chain.net_points);
  const netColor = netPointsColor(chain.net_points);
  const exitLabel = formatExitReason(chain.exit_reason);
  const directionLabel =
    chain.direction != null
      ? chain.direction.charAt(0).toUpperCase() + chain.direction.slice(1)
      : '\u2014';

  return (
    <div
      className="border-edge bg-surface-alt flex items-center justify-between gap-3 rounded-md border px-3 py-2"
      data-testid={`pyramid-chain-card-${chain.id}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label={`Toggle legs for chain ${chain.id}`}
        className="flex flex-1 cursor-pointer items-center gap-2 text-left"
      >
        <span
          className="text-muted text-[11px] transition-transform duration-150"
          style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
          aria-hidden="true"
        >
          {'\u25BE'}
        </span>
        <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px]">
          <span className="text-primary font-semibold">
            {chain.trade_date ?? '\u2014'}
          </span>
          <span className="text-secondary">{chain.instrument ?? '\u2014'}</span>
          <span className="text-secondary">{directionLabel}</span>
          <span className={`${netColor} font-semibold tabular-nums`}>
            {netLabel}
          </span>
          <span className="text-muted">{legSummary}</span>
          {chain.day_type != null && (
            <span className="bg-chip-bg text-muted rounded-full px-2 py-0.5 font-sans text-[10px] tracking-wider uppercase">
              {chain.day_type}
            </span>
          )}
          {exitLabel.length > 0 && (
            <span className="text-muted font-sans text-[10px] italic">
              {exitLabel}
            </span>
          )}
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onAddLeg}
          aria-label={`Add leg to chain ${chain.id}`}
          className="border-edge-strong bg-chip-bg text-primary hover:bg-surface cursor-pointer rounded-md border-[1.5px] px-2 py-1 font-sans text-[10px] font-semibold tracking-wider uppercase"
        >
          + Leg
        </button>
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit chain ${chain.id}`}
          className="border-edge-strong bg-chip-bg text-primary hover:bg-surface cursor-pointer rounded-md border-[1.5px] px-2 py-1 font-sans text-[10px] font-semibold tracking-wider uppercase"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete chain ${chain.id}`}
          className="border-edge-strong bg-chip-bg text-danger hover:bg-surface cursor-pointer rounded-md border-[1.5px] px-2 py-1 font-sans text-[10px] font-semibold tracking-wider uppercase"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
