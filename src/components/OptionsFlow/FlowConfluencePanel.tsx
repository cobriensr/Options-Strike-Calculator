/**
 * FlowConfluencePanel — summary panel for retail↔whale strike convergence.
 *
 * Pairs intraday retail flow (0-1 DTE ranked strikes) with institutional
 * whale positioning (2-7 DTE, ≥$1M prints) at or near the same strike
 * level and badges each pair by relationship:
 *
 *   - AGREE      — retail and whale lean the same way (aligned-call/put)
 *   - HEDGE      — retail calls + whale puts (institutional cover while
 *                  retail chases upside; the core use case)
 *   - CONTRARIAN — retail puts + whale calls (rare inversion)
 *
 * Compact one-row-per-match layout; denser than the tables below it so
 * this reads as a "what's notable today?" summary. Pure presentational —
 * the parent owns both source hooks and passes arrays down.
 */

import { useMemo } from 'react';
import type { RankedStrike, WhaleAlert } from '../../types/flow';
import {
  findConfluences,
  type ConfluenceMatch,
  type ConfluenceRelationship,
} from '../../utils/flow-confluence';
import { classifyRegime } from '../../utils/market-regime';
import type { InternalBar } from '../../types/market-internals';

// ============================================================
// TYPES
// ============================================================

export interface FlowConfluencePanelProps {
  intradayStrikes: RankedStrike[];
  whaleAlerts: WhaleAlert[];
  className?: string;
  /** Market internals bars from the shared hook in App.tsx. */
  bars?: InternalBar[];
}

type BadgeKind = 'AGREE' | 'HEDGE' | 'CONTRARIAN';

// ============================================================
// FORMATTERS
// ============================================================

function formatPremium(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

function formatSignedInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n);
  if (rounded === 0) return '0';
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

function formatStrike(n: number): string {
  return Math.round(n).toLocaleString();
}

// ============================================================
// BADGE MAPPING
// ============================================================

function relationshipToBadge(rel: ConfluenceRelationship): BadgeKind {
  if (rel === 'aligned-call' || rel === 'aligned-put') return 'AGREE';
  if (rel === 'retail-call-whale-put') return 'HEDGE';
  return 'CONTRARIAN';
}

function badgeClass(kind: BadgeKind): string {
  switch (kind) {
    case 'AGREE':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
    case 'HEDGE':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/40';
    case 'CONTRARIAN':
      return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40';
  }
}

function rowAccentClass(kind: BadgeKind): string {
  switch (kind) {
    case 'AGREE':
      return 'border-l-emerald-500/50';
    case 'HEDGE':
      return 'border-l-amber-500/50';
    case 'CONTRARIAN':
      return 'border-l-indigo-500/50';
  }
}

function sideBadgeClass(side: 'call' | 'put'): string {
  return side === 'call' ? 'text-emerald-400' : 'text-rose-400';
}

function sideLabel(side: 'call' | 'put'): string {
  return side === 'call' ? 'C' : 'P';
}

function sideIcon(side: 'call' | 'put'): string {
  return side === 'call' ? '▲' : '▼';
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function MatchRow({ match }: { match: ConfluenceMatch }) {
  const badge = relationshipToBadge(match.relationship);
  return (
    <div
      className={`border-edge/40 flex flex-wrap items-center gap-2 border-b border-l-4 px-3 py-2 font-mono text-[11px] ${rowAccentClass(badge)}`}
      data-testid="confluence-row"
      data-relationship={match.relationship}
    >
      {/* Retail side */}
      <span
        className={`${sideBadgeClass(match.retail_side)} font-mono text-[11px]`}
        aria-hidden="true"
      >
        {sideIcon(match.retail_side)}
      </span>
      <span className="text-secondary font-semibold">
        {formatStrike(match.retail_strike)}
      </span>
      <span
        className={`${sideBadgeClass(match.retail_side)} font-bold`}
        aria-label={match.retail_side === 'call' ? 'Retail call' : 'Retail put'}
      >
        {sideLabel(match.retail_side)}
      </span>
      <span className="text-muted text-[10px]">retail</span>
      <span className="text-secondary">
        {formatPremium(match.retail_premium)}
      </span>
      <span className="text-muted text-[10px]">
        ({match.retail_hit_count}{' '}
        {match.retail_hit_count === 1 ? 'hit' : 'hits'})
      </span>

      <span className="text-edge px-1" aria-hidden="true">
        ⟷
      </span>

      {/* Whale side */}
      <span className="text-secondary font-semibold">
        {formatStrike(match.whale_strike)}
      </span>
      <span
        className={`${sideBadgeClass(match.whale_side)} font-bold`}
        aria-label={match.whale_side === 'call' ? 'Whale call' : 'Whale put'}
      >
        {sideLabel(match.whale_side)}
      </span>
      <span className="text-muted text-[10px]">whale</span>
      <span className="text-secondary">
        {formatPremium(match.whale_premium)}
      </span>
      <span className="text-muted text-[10px]">({match.whale_dte}d)</span>

      {/* Strike delta */}
      <span className="text-muted ml-auto text-[10px]">
        Δ {formatSignedInt(match.strike_delta)}
      </span>

      {/* Relationship badge */}
      <span
        data-testid="confluence-badge"
        data-kind={badge}
        className={`inline-flex items-center rounded-full border px-2 py-0.5 font-sans text-[10px] font-bold tracking-wider ${badgeClass(badge)}`}
      >
        {badge}
      </span>
    </div>
  );
}

// ============================================================
// REGIME ANNOTATION
// ============================================================

const REGIME_ANNOTATION: Record<
  'range' | 'trend' | 'neutral',
  { text: string; className: string }
> = {
  range: {
    text: 'Range day — GEX walls are reliable, fade TICK extremes',
    className: 'text-cyan-400 bg-cyan-500/10',
  },
  trend: {
    text: 'Trend day — flow direction matters more, walls may break',
    className: 'text-violet-400 bg-violet-500/10',
  },
  neutral: {
    text: 'No clear regime',
    className: 'text-zinc-500 bg-zinc-500/10',
  },
};

// ============================================================
// MAIN
// ============================================================

export function FlowConfluencePanel({
  intradayStrikes,
  whaleAlerts,
  className,
  bars,
}: FlowConfluencePanelProps) {
  const matches = useMemo(
    () => findConfluences(intradayStrikes, whaleAlerts),
    [intradayStrikes, whaleAlerts],
  );

  const regime = useMemo(
    () => (bars && bars.length > 0 ? classifyRegime(bars) : null),
    [bars],
  );
  const annotation = regime ? REGIME_ANNOTATION[regime.regime] : null;

  const hasRetail = intradayStrikes.length > 0;
  const hasWhale = whaleAlerts.length > 0;

  return (
    <div
      className={`border-edge bg-surface overflow-hidden rounded-lg border ${className ?? ''}`}
      aria-label="Retail whale confluence"
    >
      {/* Hidden match count for programmatic / test access — the visible
          count now surfaces in the SectionBox badge. */}
      <span className="sr-only" data-testid="confluence-match-count">
        {matches.length} {matches.length === 1 ? 'match' : 'matches'}
      </span>

      {/* Regime annotation — compact single-line context */}
      {regime && annotation && (
        <div
          className={`px-3 py-1.5 font-sans text-[11px] ${annotation.className}`}
          data-testid="regime-annotation"
          data-regime={regime.regime}
        >
          {annotation.text}
        </div>
      )}

      {/* Body */}
      {!hasRetail && !hasWhale && (
        <div
          className="text-muted px-3 py-4 text-center font-sans text-[12px] italic"
          role="status"
        >
          Waiting on retail and whale flow…
        </div>
      )}

      {!hasRetail && hasWhale && (
        <div
          className="text-muted px-3 py-4 text-center font-sans text-[12px] italic"
          role="status"
        >
          Loading retail flow…
        </div>
      )}

      {hasRetail && !hasWhale && (
        <div
          className="text-muted px-3 py-4 text-center font-sans text-[12px] italic"
          role="status"
        >
          No whale data yet
        </div>
      )}

      {hasRetail && hasWhale && matches.length === 0 && (
        <div
          className="text-muted px-3 py-4 text-center font-sans text-[12px]"
          role="status"
        >
          No confluence matches in current window — retail and whale flow
          aren&apos;t clustering near the same strikes right now.
        </div>
      )}

      {hasRetail && hasWhale && matches.length > 0 && (
        <div>
          {matches.map((m) => (
            <MatchRow
              key={`${m.retail_strike}-${m.retail_side}-${m.whale_option_chain}`}
              match={m}
            />
          ))}
        </div>
      )}
    </div>
  );
}
