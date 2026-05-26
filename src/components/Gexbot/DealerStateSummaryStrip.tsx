/**
 * DealerStateSummaryStrip — at-a-glance regime read above the per-ticker
 * panels in the GEXBot Dealer State section. Surfaces the four
 * load-bearing facts a trader needs before drilling into the panels:
 *
 *   1. SPX dealer γ sign (primary instrument)
 *   2. VIX dealer γ sign (vol-of-vol meta-regime)
 *   3. Cross-asset breadth across the 16-ticker universe
 *   4. Loudest dealer flow (max |dexoflow|) + freshness
 *
 * Spec: docs/superpowers/specs/gexbot-dealer-state-summary-strip-2026-05-26.md
 */
import { memo, useMemo } from 'react';

import {
  useGexbotData,
  type SnapshotsLatestRow,
} from '../../hooks/useGexbotData';
import { GEXBOT_TICKER_ORDER } from './ticker-order';
import { deriveGammaSign, type GammaSign } from './types';

interface DealerStateSummaryStripProps {
  marketOpen: boolean;
}

const SPEC = { view: 'snapshots-latest' as const };

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
  for (const ticker of GEXBOT_TICKER_ORDER) {
    const row = byTicker.get(ticker);
    const sign = deriveGammaSign(row?.spot ?? null, row?.zeroGamma ?? null);
    counts[sign] += 1;
  }
  return counts;
}

interface LoudestPick {
  ticker: string;
  dexoflow: number;
}

function pickLoudest(rows: SnapshotsLatestRow[]): LoudestPick | null {
  let best: LoudestPick | null = null;
  let bestMag = 0;
  for (const r of rows) {
    if (r.dexoflow == null) continue;
    const mag = Math.abs(r.dexoflow);
    if (mag > bestMag) {
      bestMag = mag;
      best = { ticker: r.ticker, dexoflow: r.dexoflow };
    }
  }
  return best;
}

function DealerStateSummaryStripInner({
  marketOpen,
}: DealerStateSummaryStripProps) {
  const { rows, loading, error, freshestAt } = useGexbotData(SPEC, marketOpen);

  const { spx, vix, breadth, loudest } = useMemo(() => {
    const spxRow = rows.find((r) => r.ticker === 'SPX');
    const vixRow = rows.find((r) => r.ticker === 'VIX');
    return {
      spx: spxRow ?? null,
      vix: vixRow ?? null,
      breadth: countBreadth(rows),
      loudest: pickLoudest(rows),
    };
  }, [rows]);

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="dealer-state-summary-strip-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Dealer State — loading…
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
        Dealer State — {error}
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
        Dealer State — awaiting first GEXBot tick
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
        <LoudestTile pick={loudest} />
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
  const total = GEXBOT_TICKER_ORDER.length;
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
}

function LoudestTile({ pick }: LoudestTileProps) {
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
        <div className="text-tertiary mt-1 text-[10px] leading-tight">—</div>
      </div>
    );
  }

  const isPositive = pick.dexoflow >= 0;
  const flowLabel = isPositive ? 'dealer +flow' : 'dealer −flow';
  const flowTone = isPositive ? toneClasses('long') : toneClasses('short');

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
      <div className="text-tertiary mt-1 text-[10px] leading-tight">
        {flowLabel} {formatSignedDelta(pick.dexoflow)}
      </div>
    </div>
  );
}

export const DealerStateSummaryStrip = memo(DealerStateSummaryStripInner);
