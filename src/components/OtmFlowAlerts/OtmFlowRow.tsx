/**
 * OtmFlowRow — a single far-OTM SPXW flow alert row.
 *
 * Color code combines `type + dominant_side` per the matrix from the
 * plan doc:
 *   call + ask = "Bullish load"      (emerald)
 *   put  + ask = "Bearish hedge"     (rose)
 *   call + bid = "Call unwind"       (amber)
 *   put  + bid = "Put unwind"        (sky)
 *
 * Stateless presentation — all formatting inline, no hooks. Parent owns
 * fetch state and layout.
 */

import { memo } from 'react';
import type { OtmFlowAlert } from '../../types/otm-flow';

// ── Formatters ────────────────────────────────────────────────

function formatPremium(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function formatSidePct(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(0)}%`;
}

function formatDistancePct(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${(pct * 100).toFixed(2)}%`;
}

function formatAgeMinutes(createdAt: string, nowMs: number): string {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return '—';
  const mins = Math.max(0, Math.round((nowMs - created) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  const remPart = rem > 0 ? ` ${rem}m` : '';
  return `${hrs}h${remPart}`;
}

function formatCtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  }).format(d);
}

// ── Color mapping ─────────────────────────────────────────────

interface RowPalette {
  accent: string;
  label: string;
}

function paletteFor(type: 'call' | 'put', side: 'ask' | 'bid'): RowPalette {
  if (type === 'call' && side === 'ask') {
    return { accent: 'text-emerald-500', label: 'Bullish load' };
  }
  if (type === 'put' && side === 'ask') {
    return { accent: 'text-rose-500', label: 'Bearish hedge' };
  }
  if (type === 'call' && side === 'bid') {
    return { accent: 'text-amber-500', label: 'Call unwind' };
  }
  return { accent: 'text-sky-500', label: 'Put unwind' };
}

// ── Rule shortening ───────────────────────────────────────────

/**
 * Maps UW alert rule names to compact badge labels that fit the tight
 * footer column. Unknown rules fall back to a trimmed uppercase form so
 * a new server-side rule renders sensibly without a frontend change.
 * Mirrors the same shape used by WhalePositioningTable.
 */
const RULE_LABEL: Record<string, string> = {
  RepeatedHits: 'RH',
  RepeatedHitsAscendingFill: 'RH↑',
  RepeatedHitsDescendingFill: 'RH↓',
  FloorTradeLargeCap: 'FLOOR',
  FloorTradeSmallCap: 'FLOOR',
  FloorTradeMidCap: 'FLOOR',
  SweepsFollowedByFloor: 'SWP+FL',
  OtmEarningsFloor: 'OTMEARN',
  LowHistoricVolumeFloor: 'LOWVOL',
};

function shortRule(rule: string): string {
  if (RULE_LABEL[rule]) return RULE_LABEL[rule]!;
  return rule
    .replace(/(Trade|Condition|Fill)/g, '')
    .toUpperCase()
    .slice(0, 8);
}

// ── Component ─────────────────────────────────────────────────

export interface OtmFlowRowProps {
  alert: OtmFlowAlert;
  nowMs: number;
  isNew?: boolean;
}

export const OtmFlowRow = memo(function OtmFlowRow({
  alert,
  nowMs,
  isNew,
}: OtmFlowRowProps) {
  const palette = paletteFor(alert.type, alert.dominant_side);
  const sideRatio =
    alert.dominant_side === 'ask' ? alert.ask_side_ratio : alert.bid_side_ratio;
  const sidePct = (sideRatio ?? 0) * 100;

  return (
    <div
      className={
        'border-edge hover:bg-surface-alt flex items-center gap-3 border-b px-3 py-2 font-mono text-[13px] transition-colors' +
        (isNew ? ' bg-surface-alt/60' : '')
      }
    >
      {/* Accent + label */}
      <div className="flex min-w-[110px] flex-col">
        <span className={`font-semibold ${palette.accent}`}>
          {palette.label}
        </span>
        <span className="text-muted text-[11px]">
          {alert.type.toUpperCase()} · {alert.dominant_side.toUpperCase()} ·{' '}
          {formatSidePct(sideRatio)}
        </span>
      </div>

      {/* Strike + distance — strike links to the contract on Unusual Whales */}
      <div className="flex min-w-[90px] flex-col text-right">
        <a
          href={`https://unusualwhales.com/option-chain/${encodeURIComponent(alert.option_chain)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground font-semibold hover:underline"
          title={`View ${alert.option_chain} on Unusual Whales`}
          aria-label={`Open ${alert.option_chain} on Unusual Whales (opens in new tab)`}
        >
          {Math.round(alert.strike)}
        </a>
        <span className="text-muted text-[11px]">
          {formatDistancePct(alert.distance_pct)}
        </span>
      </div>

      {/* Premium */}
      <div className="flex min-w-[70px] flex-col text-right">
        <span className="text-foreground font-semibold">
          {formatPremium(alert.total_premium)}
        </span>
        <span className="text-muted text-[11px]">{alert.total_size} ct</span>
      </div>

      {/* Side bar */}
      <div className="flex flex-1 flex-col gap-1">
        <div className="bg-surface-alt border-edge relative h-[6px] overflow-hidden rounded-full border">
          <div
            className={
              'absolute top-0 left-0 h-full ' +
              (alert.dominant_side === 'ask'
                ? alert.type === 'call'
                  ? 'bg-emerald-500'
                  : 'bg-rose-500'
                : alert.type === 'call'
                  ? 'bg-amber-500'
                  : 'bg-sky-500')
            }
            style={{ width: `${Math.min(100, Math.max(0, sidePct))}%` }}
            aria-hidden="true"
          />
        </div>
        <div className="text-muted flex items-center justify-between text-[11px]">
          <span>{formatCtTime(alert.created_at)} CT</span>
          <span>
            {shortRule(alert.alert_rule)}
            {alert.has_sweep ? ' · sweep' : ''}
            {alert.has_multileg ? ' · multi' : ''}
          </span>
        </div>
      </div>

      {/* Age */}
      <div className="text-muted min-w-[40px] text-right text-[11px]">
        {formatAgeMinutes(alert.created_at, nowMs)}
      </div>
    </div>
  );
});
