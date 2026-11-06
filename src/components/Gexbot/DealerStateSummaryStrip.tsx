/**
 * DealerStateSummaryStrip — at-a-glance read above the per-ticker panels
 * in the GEXBot Taker Flow section. GEXBot values are taker-side, so
 * nothing here claims dealer positioning. Surfaces four facts:
 *
 *   1. SPX net-γ sign (spot vs zero-gamma level)
 *   2. VIX net-γ sign
 *   3. Breadth across the 14 distinct underlyings (the ES_SPX / NQ_NDX
 *      futures views are excluded: they repeat SPX / NDX)
 *   4. The most unusual taker Δ flow of the last minute: the underlying
 *      whose |Δ agg_dex| is the largest multiple of its own typical minute
 *      (velocity view, same rule as the Velocity tape; futures views
 *      skipped) + freshness
 *
 * The file and component name and the `dealer-state-*` test ids are legacy
 * names, kept to avoid churn; the panel shows taker-side GEXBot data.
 *
 * Spec: docs/superpowers/specs/gexbot-dealer-state-summary-strip-2026-05-26.md
 */
import { memo, useMemo } from 'react';

import {
  useGexbotData,
  type SnapshotsLatestRow,
} from '../../hooks/useGexbotData';
import { GEXBOT_UNDERLYING_ORDER } from './ticker-order';
import { deriveGammaSign, type GammaSign } from './types';
import {
  formatTakerDelta,
  isUnusual,
  pickMostUnusual,
  TYPICAL_FLOOR,
  UNUSUAL_MULTIPLE,
  usesTypicalFloor,
} from './velocity-tape';

interface DealerStateSummaryStripProps {
  marketOpen: boolean;
}

const SPEC = { view: 'snapshots-latest' as const };
// Same URL as the Velocity tape, so the hook's in-flight dedupe shares one
// request between them.
const VELOCITY_SPEC = { view: 'velocity' as const };

function formatLevel(value: number | null): string {
  if (value == null) return '—';
  return value.toFixed(2);
}

function formatSignedDelta(delta: number): string {
  const sign = delta >= 0 ? '+' : '−';
  return `${sign}${Math.abs(delta).toFixed(2)}`;
}

function formatCTClock(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

function toneClasses(sign: GammaSign): {
  container: string;
  accent: string;
  headline: string;
} {
  if (sign === 'long') {
    return {
      container: 'border-emerald-500/30 bg-emerald-500/5',
      accent: 'bg-emerald-400',
      headline: 'text-emerald-300',
    };
  }
  if (sign === 'short') {
    return {
      container: 'border-rose-500/30 bg-rose-500/5',
      accent: 'bg-rose-400',
      headline: 'text-rose-300',
    };
  }
  return {
    container: 'border-white/10 bg-white/[0.02]',
    accent: 'bg-white/20',
    headline: 'text-tertiary',
  };
}

interface BreadthCounts {
  long: number;
  short: number;
  unknown: number;
}

function countBreadth(rows: SnapshotsLatestRow[]): BreadthCounts {
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));
  const counts: BreadthCounts = { long: 0, short: 0, unknown: 0 };
  for (const ticker of GEXBOT_UNDERLYING_ORDER) {
    const row = byTicker.get(ticker);
    const sign = deriveGammaSign(row?.spot ?? null, row?.zeroGamma ?? null);
    counts[sign] += 1;
  }
  return counts;
}

interface LoudestPick {
  ticker: string;
  /** Last-minute Δ agg_dex: the taker delta flow. Never 0. */
  dAggDex: number;
  /** |Δ agg_dex| as a multiple of the ticker's typical minute or the floor. */
  ratio: number;
  /** True when `ratio` is a multiple of the floor, not of the ticker's own. */
  floored: boolean;
  /** Whether the tape would call this row unusual (the 3x rule). */
  unusual: boolean;
}

function DealerStateSummaryStripInner({
  marketOpen,
}: DealerStateSummaryStripProps) {
  const { rows, loading, error, freshestAt } = useGexbotData(SPEC, marketOpen);
  // A loading or failed velocity read leaves the tile on its empty state;
  // it must not take the whole strip down.
  const velocity = useGexbotData(VELOCITY_SPEC, marketOpen);

  const { spx, vix, breadth } = useMemo(() => {
    const spxRow = rows.find((r) => r.ticker === 'SPX');
    const vixRow = rows.find((r) => r.ticker === 'VIX');
    return {
      spx: spxRow ?? null,
      vix: vixRow ?? null,
      breadth: countBreadth(rows),
    };
  }, [rows]);

  const loudest = useMemo((): LoudestPick | null => {
    const picked = pickMostUnusual(velocity.rows);
    if (!picked || picked.row.dAggDex == null) return null;
    return {
      ticker: picked.row.ticker,
      dAggDex: picked.row.dAggDex,
      ratio: picked.ratio,
      floored: usesTypicalFloor(picked.row),
      unusual: isUnusual(picked.row),
    };
  }, [velocity.rows]);

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="dealer-state-summary-strip-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        GEXBot Taker Flow — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="dealer-state-summary-strip-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        GEXBot Taker Flow — {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="dealer-state-summary-strip-empty"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        GEXBot Taker Flow — awaiting first GEXBot tick
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="dealer-state-summary-strip"
      className="flex flex-col gap-1"
    >
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <GammaTile testid="dealer-state-strip-spx" label="SPX" row={spx} />
        <GammaTile testid="dealer-state-strip-vix" label="VIX" row={vix} />
        <BreadthTile counts={breadth} />
        <LoudestTile pick={loudest} readFailed={velocity.error != null} />
      </div>
      <div className="text-tertiary px-1 text-[10px] tracking-wide uppercase">
        last GEXBot tick {formatCTClock(freshestAt)} CT
      </div>
    </div>
  );
}

interface GammaTileProps {
  testid: string;
  label: string;
  row: SnapshotsLatestRow | null;
}

function GammaTile({ testid, label, row }: GammaTileProps) {
  const spot = row?.spot ?? null;
  const zg = row?.zeroGamma ?? null;
  const sign = deriveGammaSign(spot, zg);
  const tone = toneClasses(sign);

  const subline = (() => {
    if (sign === 'unknown') return '—';
    const delta = (spot as number) - (zg as number);
    return `spot ${formatLevel(spot)} / 0γ ${formatLevel(zg)} (${formatSignedDelta(delta)})`;
  })();

  const headline =
    sign === 'unknown'
      ? `${label} γ`
      : `${label} · ${sign === 'long' ? 'LONG' : 'SHORT'} γ`;

  return (
    <div
      data-testid={testid}
      className={`rounded-md border px-3 py-2 ${tone.container}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${tone.accent}`} aria-hidden />
        <span
          className={`text-[11px] font-semibold tracking-wide ${tone.headline}`}
        >
          {headline}
        </span>
      </div>
      <div className="text-tertiary mt-1 text-[10px] leading-tight">
        {subline}
      </div>
    </div>
  );
}

function BreadthTile({ counts }: { counts: BreadthCounts }) {
  const total = GEXBOT_UNDERLYING_ORDER.length;
  const { long, short, unknown } = counts;
  const majoritySign: GammaSign =
    long === 0 && short === 0 ? 'unknown' : long >= short ? 'long' : 'short';
  const majorityCount = majoritySign === 'long' ? long : short;
  const minorityCount = majoritySign === 'long' ? short : long;
  const tone = toneClasses(majoritySign);

  const headline =
    majoritySign === 'unknown'
      ? '—'
      : `${majorityCount} / ${total} ${majoritySign === 'long' ? 'LONG' : 'SHORT'} γ`;

  const subline =
    majoritySign === 'unknown'
      ? '—'
      : `${minorityCount} ${majoritySign === 'long' ? 'short' : 'long'} · ${unknown} partial`;

  return (
    <div
      data-testid="dealer-state-strip-breadth"
      className={`rounded-md border px-3 py-2 ${tone.container}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${tone.accent}`} aria-hidden />
        <span
          className={`text-[11px] font-semibold tracking-wide ${tone.headline}`}
        >
          BREADTH · {headline}
        </span>
      </div>
      <div className="text-tertiary mt-1 text-[10px] leading-tight">
        {subline}
      </div>
    </div>
  );
}

interface LoudestTileProps {
  pick: LoudestPick | null;
  /**
   * The latest velocity read errored. Shown only when there is no pick: the
   * hook keeps the last good rows for the same URL, and a pick from them is
   * still the best answer.
   */
  readFailed: boolean;
}

const LOUDEST_LABEL = 'most unusual taker Δ / min';
const QUIET_LABEL = `quiet · nothing ≥ ${UNUSUAL_MULTIPLE}× typical`;
const LOUDEST_TITLE = `Last-minute change in taker delta (Δ agg_dex) as a multiple of this ticker's own typical minute (its session median, never under ${TYPICAL_FLOOR}). Ranked by that multiple, not by raw size, because sizes are not comparable across tickers. A grey tile means nothing reached ${UNUSUAL_MULTIPLE}×.`;

/**
 * One decimal. A pick that is not unusual rounds down, so a ratio just under
 * the multiple (2.96) never prints as "3.0×" beside "nothing ≥ 3× typical".
 */
function formatRatio(ratio: number, unusual: boolean): string {
  return (unusual ? ratio : Math.floor(ratio * 10) / 10).toFixed(1);
}

function LoudestTile({ pick, readFailed }: LoudestTileProps) {
  const tone = toneClasses('unknown');

  if (!pick) {
    return (
      <div
        data-testid="dealer-state-strip-loudest"
        className={`rounded-md border px-3 py-2 ${tone.container}`}
      >
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${tone.accent}`} aria-hidden />
          <span
            className={`text-[11px] font-semibold tracking-wide ${tone.headline}`}
          >
            LOUDEST · —
          </span>
        </div>
        {readFailed ? (
          <div className="mt-1 text-[10px] leading-tight text-amber-300/80">
            velocity read failed
          </div>
        ) : (
          <div className="text-tertiary mt-1 text-[10px] leading-tight">—</div>
        )}
        <div className="text-tertiary text-[9px] leading-tight tracking-wide uppercase">
          {LOUDEST_LABEL}
        </div>
      </div>
    );
  }

  const isPositive = pick.dAggDex > 0;
  const flowLabel = isPositive ? 'taker +Δ flow' : 'taker −Δ flow';
  // A top pick that is not unusual (the tape would not mark it) stays neutral:
  // green or red would present a quiet minute as a signal.
  const flowTone = pick.unusual
    ? toneClasses(isPositive ? 'long' : 'short')
    : tone;
  const against = pick.floored ? `the ${TYPICAL_FLOOR} floor` : 'typical';

  return (
    <div
      data-testid="dealer-state-strip-loudest"
      className={`rounded-md border px-3 py-2 ${flowTone.container}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${flowTone.accent}`}
          aria-hidden
        />
        <span
          className={`text-[11px] font-semibold tracking-wide ${flowTone.headline}`}
        >
          LOUDEST · {pick.ticker}
        </span>
      </div>
      <div
        className="text-tertiary mt-1 text-[10px] leading-tight"
        title={LOUDEST_TITLE}
      >
        {flowLabel} {formatTakerDelta(pick.dAggDex)} ·{' '}
        {formatRatio(pick.ratio, pick.unusual)}× {against}
      </div>
      <div className="text-tertiary text-[9px] leading-tight tracking-wide uppercase">
        {pick.unusual ? LOUDEST_LABEL : QUIET_LABEL}
      </div>
    </div>
  );
}

export const DealerStateSummaryStrip = memo(DealerStateSummaryStripInner);
