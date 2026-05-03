/**
 * StrikeBattleMap — per-strike grid showing customer directional flow
 * vs dealer net gamma at the same OTM 0DTE strikes for SPY + QQQ.
 *
 * Aim: surface magnets (single-strike pin candidates) and amplifiers
 * (cascade-risk strikes) in one view. Reads from the new
 * /api/gex-strike-expiry endpoint (populated by the uw-stream daemon's
 * gex_strike_expiry:<TICKER> WS handler).
 *
 * Per-strike directional-flow proxy:
 *   The /api/gex-strike-expiry endpoint exposes call/put gamma
 *   ask_vol & bid_vol — gamma-weighted aggressor volumes at the
 *   strike. We derive a customer directional read as:
 *
 *     bullish_demand  = call_gamma_ask_vol  - call_gamma_bid_vol
 *     bearish_demand  = put_gamma_ask_vol   - put_gamma_bid_vol
 *     directional     = bullish_demand - bearish_demand
 *
 *   This is a proxy for "cumulative dir delta at strike" sourced from
 *   the GEX channel itself, not the strike_exposures table — which
 *   keeps the panel single-source for now. A follow-up stage can
 *   substitute the canonical strike_exposures customer flow if the
 *   proxy turns out to need refinement.
 *
 * Dealer net gamma at strike:
 *
 *     net_gamma = call_gamma_oi + put_gamma_oi
 *
 *   Sign convention as emitted by UW (no flip applied) — see migration
 *   #111 in api/_lib/db-migrations.ts.
 *
 * Date scrubber: today (live, polls every 30s) vs any past date
 * (frozen one-shot). Mirrors the GreekFlowPanel scrubber pattern.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import {
  useGexStrikeExpiry,
  type GexStrikeExpiryResponse,
  type GexStrikeExpiryRow,
  type GexStrikeExpiryTicker,
} from '../../hooks/useGexStrikeExpiry';
import { SectionBox } from '../ui';
import { DateInput } from '../ui/DateInput';
import { ctWallClockToUtcIso, getETToday } from '../../utils/timezone';
import {
  computeConcentration,
  nearestOtmStrikes,
  type ConcentrationLabel,
  type StrikeMagnitude,
} from './concentration';
import { Legend } from './Legend';
import { MinuteScrubber } from './MinuteScrubber';
import { StrikeRow } from './StrikeRow';

interface StrikeBattleMapProps {
  marketOpen: boolean;
}

const TICKERS: readonly GexStrikeExpiryTicker[] = ['SPY', 'QQQ'] as const;
const STRIKE_COUNT_OPTIONS = [10, 20, 30] as const;
type StrikeCount = (typeof STRIKE_COUNT_OPTIONS)[number];
const DEFAULT_STRIKE_COUNT: StrikeCount = 10;

function customerDirectionalFlow(row: GexStrikeExpiryRow): number {
  const callBull =
    (row.call_gamma_ask_vol ?? 0) - (row.call_gamma_bid_vol ?? 0);
  const putBear = (row.put_gamma_ask_vol ?? 0) - (row.put_gamma_bid_vol ?? 0);
  return callBull - putBear;
}

function dealerNetGamma(row: GexStrikeExpiryRow): number {
  return (row.call_gamma_oi ?? 0) + (row.put_gamma_oi ?? 0);
}

function StrikeBattleMapInner({ marketOpen }: StrikeBattleMapProps) {
  const today = getETToday();
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [strikeCount, setStrikeCount] =
    useState<StrikeCount>(DEFAULT_STRIKE_COUNT);
  const [selectedMinuteCT, setSelectedMinuteCT] = useState<number | null>(null);
  const isLive = selectedDate === today;
  const effectiveMarketOpen = isLive ? marketOpen : false;
  const liveAvailable = isLive && marketOpen;

  // Reset the minute filter whenever the date changes — switching days
  // should land on "latest available" for the new day rather than
  // carrying the previous minute over (which would silently produce
  // empty rows if the new day has different ts_minute coverage).
  useEffect(() => {
    setSelectedMinuteCT(null);
  }, [selectedDate]);

  // Convert the CT minute-of-day to a UTC ISO string for the API. DST-
  // safe via ctWallClockToUtcIso(); null = "latest available" (live for
  // today during market hours, EOD snapshot for backfilled days).
  const at = useMemo(
    () =>
      selectedMinuteCT == null
        ? null
        : ctWallClockToUtcIso(selectedDate, selectedMinuteCT),
    [selectedDate, selectedMinuteCT],
  );

  // The endpoint reads `expiry`; for the Battle Map we always look at
  // the same-day 0DTE expiry, so expiry == selectedDate.
  const { data, loading, error } = useGexStrikeExpiry(
    effectiveMarketOpen,
    selectedDate,
    at,
  );

  const headerRight = (
    <div className="flex items-center gap-2">
      <StrikeCountToggle value={strikeCount} onChange={setStrikeCount} />
      {!isLive && (
        <button
          type="button"
          onClick={() => setSelectedDate(today)}
          className="text-secondary hover:text-primary border-edge cursor-pointer rounded border bg-transparent px-2 py-0.5 font-mono text-[10px]"
        >
          TODAY
        </button>
      )}
      <DateInput
        value={selectedDate}
        onChange={setSelectedDate}
        label="Strike Battle Map date"
        labelVisible={false}
        className="text-secondary border-edge rounded border bg-transparent px-1.5 py-0.5 font-mono text-[10px]"
      />
    </div>
  );

  return (
    <SectionBox label="Strike Battle Map" headerRight={headerRight} collapsible>
      <p className="text-secondary mb-3 font-sans text-xs">
        Per-strike customer directional flow vs dealer net gamma for 0DTE SPY +
        QQQ. Magnets surface pin candidates; widen the strike band on volatile
        sessions. Backfilled days show the EOD snapshot only — true per-minute
        scrubbing kicks in on live + future days as the daemon writes history.
      </p>
      <Legend />
      <MinuteScrubber
        value={selectedMinuteCT}
        onChange={setSelectedMinuteCT}
        liveAvailable={liveAvailable}
      />
      <Body
        data={data}
        loading={loading}
        error={error}
        strikeCount={strikeCount}
      />
    </SectionBox>
  );
}

interface StrikeCountToggleProps {
  value: StrikeCount;
  onChange: (n: StrikeCount) => void;
}

function StrikeCountToggle({ value, onChange }: StrikeCountToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Strike count"
      className="border-edge inline-flex overflow-hidden rounded border"
    >
      {STRIKE_COUNT_OPTIONS.map((opt) => (
        <button
          key={opt}
          type="button"
          role="radio"
          aria-checked={value === opt}
          onClick={() => onChange(opt)}
          className={`cursor-pointer px-2 py-0.5 font-mono text-[10px] ${
            value === opt
              ? 'bg-surface text-primary'
              : 'text-secondary hover:text-primary'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function Body({
  data,
  loading,
  error,
  strikeCount,
}: {
  data: Record<GexStrikeExpiryTicker, GexStrikeExpiryResponse | null>;
  loading: boolean;
  error: string | null;
  strikeCount: StrikeCount;
}) {
  const haveAny = TICKERS.some((t) => data[t]?.rows.length);
  if (error && !haveAny) {
    return (
      <div role="alert" className="text-secondary font-sans text-xs">
        {error}
      </div>
    );
  }
  if (loading && !haveAny) {
    return <div className="text-secondary font-sans text-xs">Loading…</div>;
  }
  if (!haveAny) {
    return (
      <div className="text-secondary font-sans text-xs">
        No strike-level GEX yet. Daemon will populate as UW pushes WS updates
        during market hours.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {TICKERS.map((ticker) => (
        <TickerSection
          key={ticker}
          ticker={ticker}
          payload={data[ticker]}
          strikeCount={strikeCount}
        />
      ))}
    </div>
  );
}

interface TickerSectionProps {
  ticker: GexStrikeExpiryTicker;
  payload: GexStrikeExpiryResponse | null;
  strikeCount: StrikeCount;
}

function TickerSection({ ticker, payload, strikeCount }: TickerSectionProps) {
  const view = useMemo(
    () => buildTickerView(payload, strikeCount),
    [payload, strikeCount],
  );

  if (view == null) {
    return (
      <div className="border-edge bg-surface rounded-md border p-2">
        <div className="text-primary mb-1 flex items-center justify-between font-sans text-[11px]">
          <span className="font-semibold">{ticker}</span>
          <span className="text-secondary font-mono text-[9px]">no data</span>
        </div>
        <p className="text-secondary font-sans text-[10px]">
          Waiting for daemon to deliver {ticker} strikes.
        </p>
      </div>
    );
  }

  const { rows, spot, concentrationLabel, magnetStrike, asOf } = view;
  return (
    <div
      className="border-edge bg-surface rounded-md border p-2"
      data-testid={`battle-map-ticker-${ticker}`}
    >
      <div className="text-primary mb-2 flex items-baseline justify-between font-sans text-[11px]">
        <span className="font-semibold">{ticker}</span>
        <span className="text-secondary font-mono text-[9px]">
          spot {spot.toFixed(2)} · {LABEL_TEXT[concentrationLabel]}
          {magnetStrike != null ? ` @ ${magnetStrike}` : ''}
          {asOf ? ` · ${fmtTime(asOf)}` : ''}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <StrikeRow
            key={r.strike}
            strike={r.strike}
            flowSigned={r.flowSigned}
            flowMagMax={view.flowMagMax}
            gammaSigned={r.gammaSigned}
            gammaMagMax={view.gammaMagMax}
            isMagnet={r.strike === magnetStrike}
          />
        ))}
      </div>
    </div>
  );
}

interface RenderableRow {
  strike: number;
  flowSigned: number;
  gammaSigned: number;
}

interface TickerView {
  rows: RenderableRow[];
  spot: number;
  flowMagMax: number;
  gammaMagMax: number;
  concentrationLabel: ConcentrationLabel;
  magnetStrike: number | null;
  asOf: string | null;
}

function buildTickerView(
  payload: GexStrikeExpiryResponse | null,
  strikeCount: StrikeCount,
): TickerView | null {
  if (payload == null) return null;
  const all = payload.rows;
  if (all.length === 0) return null;
  // Spot price proxy — UW writes the underlying price into every row;
  // pick whichever non-null value the latest row carries.
  const spot = all.find((r) => r.price != null)?.price ?? null;
  if (spot == null || !Number.isFinite(spot)) return null;

  // strikeCount is the total visible strikes (calls + puts), split evenly.
  const perSide = Math.floor(strikeCount / 2);
  const { calls, puts } = nearestOtmStrikes(all, spot, perSide);
  // Display order: puts first (descending strike), then calls (ascending),
  // matching standard option-chain visual convention.
  const ordered = [...puts, ...calls];

  const enriched: RenderableRow[] = ordered.map((row) => ({
    strike: row.strike,
    flowSigned: customerDirectionalFlow(row),
    gammaSigned: dealerNetGamma(row),
  }));

  const flowMags: StrikeMagnitude[] = enriched.map((r) => ({
    strike: r.strike,
    signed: r.flowSigned,
  }));
  const concentration = computeConcentration(flowMags);

  const flowMagMax = enriched.reduce(
    (acc, r) => Math.max(acc, Math.abs(r.flowSigned)),
    0,
  );
  const gammaMagMax = enriched.reduce(
    (acc, r) => Math.max(acc, Math.abs(r.gammaSigned)),
    0,
  );

  // Latest minute label — pick the most recent ts_minute among the
  // visible strikes (DISTINCT ON in the SQL guarantees one row per
  // strike, but ts_minutes can vary by a minute or two).
  const asOf = ordered
    .map((r) => r.ts_minute)
    .sort()
    .at(-1);

  return {
    rows: enriched,
    spot,
    flowMagMax,
    gammaMagMax,
    concentrationLabel: concentration.label,
    magnetStrike:
      concentration.label === 'magnet' ? concentration.topStrike : null,
    asOf: asOf ?? null,
  };
}

const LABEL_TEXT: Record<ConcentrationLabel, string> = {
  magnet: 'magnet',
  partial: 'partial',
  smeared: 'smeared',
  empty: 'no flow',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

export const StrikeBattleMap = memo(StrikeBattleMapInner);
