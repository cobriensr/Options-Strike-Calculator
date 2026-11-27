/**
 * ExpectedMoveTile — GEXBot's ±1σ expected move for SPX, computed server
 * side from the call and put IV in the latest per-strike capture
 * (`api/_lib/gexbot-expected-move.ts`, `view=expected-move`).
 *
 * The range is centred on spot and covers the time left to expiry, so it
 * narrows through the session. It is a size, not a direction: the tile is
 * always neutral. When the capture cannot produce a move the tile names the
 * reason instead of showing a number. Once `marketOpen` is false the tile
 * reads "session closed" whatever the rows say, an empty body included, so a
 * tab held through the close and a load after it agree.
 *
 * Spec: docs/superpowers/specs/gexbot-expected-move-net-vanna-2026-11-20.md
 */

import { memo } from 'react';

import { useGexbotData, type ExpectedMoveRow } from '../../hooks/useGexbotData';
import { SrHint } from '../ui/SrHint';
import { toneClasses } from './tile-tone';
import { formatDte } from './types';

interface ExpectedMoveTileProps {
  marketOpen: boolean;
}

const SPEC = { view: 'expected-move' as const };

const NAME = 'SPX ±1σ';
const TITLE =
  "GEXBot's formula: spot × smoothed ATM IV × √(days to expiry / 365), where the smoothed IV weights the ATM strike 50% and the strikes either side 25% each. Our choices, not documented by GEXBot: ATM is the listed strike nearest spot, and a strike's IV is the mean of its call and put IV. Days to expiry count down to 4:00 PM ET, so the range narrows through the session.";

/**
 * What a screen reader gets in place of the hover title: what the number is
 * and where it comes from, without repeating the visible label.
 */
const HINT = 'one standard deviation, from at-the-money implied volatility';

const UNAVAILABLE_TEXT: Record<
  NonNullable<ExpectedMoveRow['unavailable']>,
  string
> = {
  no_atm_iv: 'no IV at the ATM strike in the latest capture',
  no_spot: 'no spot in the latest capture',
  no_dte: 'expiry not reported',
  expired: 'session closed',
};

function formatLevel(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

interface Shown {
  headline: string;
  detail: string;
}

/**
 * What a closed market shows, whatever the last row says. The hook stops
 * polling when `marketOpen` goes false (16:00 ET, 13:00 ET on a half day) and
 * the vendor's last stamp of a session is 15:59:59 ET, never 16:00, so the
 * server's `expired` never reaches an open tab: without this the tile would
 * freeze on its last live move.
 */
const SESSION_CLOSED: Shown = {
  headline: `${NAME} · —`,
  detail: UNAVAILABLE_TEXT.expired,
};

function describeRow(row: ExpectedMoveRow): Shown {
  if (row.unavailable != null) {
    return {
      headline: `${NAME} · —`,
      detail: UNAVAILABLE_TEXT[row.unavailable],
    };
  }
  const { expectedMove, lower, upper, atmIv } = row;
  if (expectedMove == null || lower == null || upper == null || atmIv == null) {
    // The server sends a reason with every missing move; a row with neither
    // is malformed, and a dash is the honest display.
    return { headline: `${NAME} · —`, detail: '—' };
  }
  const range = `${formatLevel(lower)} – ${formatLevel(upper)}`;
  const iv = `ATM IV ${(atmIv * 100).toFixed(1)}%`;
  return {
    headline: `${NAME} · ±${formatLevel(expectedMove)} pts`,
    detail: `${range} · ${iv} · ${formatDte(row.minDte)}`,
  };
}

function ExpectedMoveTileInner({ marketOpen }: ExpectedMoveTileProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="expected-move-tile-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        {NAME} expected move — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="expected-move-tile-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        {NAME} expected move — {error}
      </div>
    );
  }

  const row = rows[0];
  // After the close the view still answers, but its 5-minute window is empty
  // for any load that comes after the last tick (a reload, a PWA update, the
  // weekend, a new device). "Awaiting" is only true while the market is open.
  if (!row && marketOpen) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="expected-move-tile-empty"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        {NAME} expected move — awaiting first GEXBot tick
      </div>
    );
  }

  const tone = toneClasses('unknown');
  const shown = marketOpen && row ? describeRow(row) : SESSION_CLOSED;

  return (
    <div
      data-testid="expected-move-tile"
      title={TITLE}
      className={`rounded-md border px-3 py-2 ${tone.container}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${tone.accent}`} aria-hidden />
        <span
          data-testid="expected-move-value"
          className={`text-[11px] font-semibold tracking-wide ${tone.headline}`}
        >
          {shown.headline}
        </span>
      </div>
      <div
        data-testid="expected-move-range"
        className="text-tertiary mt-1 text-[10px] leading-tight"
      >
        {shown.detail}
      </div>
      <div className="text-tertiary text-[9px] leading-tight tracking-wide uppercase">
        GEXBot expected move · to expiry
      </div>
      <SrHint>{HINT}</SrHint>
    </div>
  );
}

export const ExpectedMoveTile = memo(ExpectedMoveTileInner);
