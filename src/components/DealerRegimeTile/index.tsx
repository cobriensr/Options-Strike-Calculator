/**
 * DealerRegimeTile — 4-cell row showing the dealer-gamma regime at spot
 * for SPX, NDX, SPY, QQQ. Sits above the Strike Battle Map as the
 * primary "is the market dampening or amplifying?" read.
 *
 * Each cell maps a `zero_gamma_levels` row through the pure classifier
 * to one of: `long-γ`, `short-γ`, `transition`, `uncertain`.
 *
 * Backtest scrubber:
 *   - Date scrubber: today (live, polls every 30s) vs any past date
 *     (frozen one-shot read of latest-per-ticker for that day).
 *   - Minute scrubber (CT): when set, snapshots the response to rows
 *     where ts ≤ at. Disables polling.
 *
 * The classifier's `now` is derived from the scrubbed timestamp so the
 * staleness gate is judged relative to the snapshot moment, not
 * wall-clock time. Otherwise scrubbing back to Friday 14:00 from a
 * Sunday session would always classify uncertain (50+ hours stale).
 *
 * Spec: docs/superpowers/specs/dealer-regime-tile-2026-05-03.md
 */

import { memo, useEffect, useMemo, useState } from 'react';
import {
  useDealerRegime,
  type DealerRegimeRow,
} from '../../hooks/useDealerRegime';
import { SectionBox } from '../ui';
import { DateInput } from '../ui/DateInput';
import {
  ctWallClockToUtcIso,
  etWallClockToUtcIso,
  getETToday,
} from '../../utils/timezone';
import { classify, type DealerRegimeState } from './classify';
import { Cell } from './Cell';
import { MinuteScrubber } from '../StrikeBattleMap/MinuteScrubber';

const TICKERS = ['SPX', 'NDX', 'SPY', 'QQQ'] as const;
type Ticker = (typeof TICKERS)[number];

interface DealerRegimeTileProps {
  marketOpen: boolean;
}

interface ClassifiedCell {
  ticker: Ticker;
  row: DealerRegimeRow | null;
  state: DealerRegimeState;
}

function DealerRegimeTileInner({ marketOpen }: DealerRegimeTileProps) {
  const today = getETToday();
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [selectedMinuteCT, setSelectedMinuteCT] = useState<number | null>(null);
  const isLive = selectedDate === today;
  const liveAvailable = isLive && marketOpen;

  // Reset minute filter when date changes — switching days should land
  // on "latest available" for the new day rather than carrying a stale
  // minute over.
  useEffect(() => {
    setSelectedMinuteCT(null);
  }, [selectedDate]);

  // Scrubbed timestamp drives both the API filter and the classifier's
  // `now` reference. When live (no scrubbing): null + Date.now() default.
  // When date-only past: snap `now` to 4 PM ET so a mid-session row
  // isn't flagged stale relative to wall-clock.
  const at = useMemo(() => {
    if (selectedMinuteCT == null) return null;
    return ctWallClockToUtcIso(selectedDate, selectedMinuteCT);
  }, [selectedDate, selectedMinuteCT]);

  const dateParam = isLive ? null : selectedDate;
  const { data, loading, error } = useDealerRegime(
    liveAvailable,
    dateParam,
    at,
  );

  const classifierNow = useMemo<number | undefined>(() => {
    if (at) return Date.parse(at);
    if (!isLive) {
      // Date-only past selection: anchor to 4 PM ET that day so the
      // staleness gate is judged against close-of-session.
      const iso = etWallClockToUtcIso(selectedDate, 16 * 60);
      return iso ? Date.parse(iso) : undefined;
    }
    return undefined; // live mode → classifier uses Date.now()
  }, [at, isLive, selectedDate]);

  const cells = useMemo<ClassifiedCell[]>(() => {
    const byTicker = new Map<Ticker, DealerRegimeRow>();
    for (const r of data?.rows ?? []) {
      byTicker.set(r.ticker, r);
    }
    return TICKERS.map((ticker) => {
      const row = byTicker.get(ticker) ?? null;
      const state: DealerRegimeState = row
        ? classify(
            {
              spot: row.spot,
              zeroGamma: row.zeroGamma,
              confidence: row.confidence,
              netGammaAtSpot: row.netGammaAtSpot,
              ts: row.ts,
            },
            { now: classifierNow },
          )
        : 'uncertain';
      return { ticker, row, state };
    });
  }, [data, classifierNow]);

  const headerRight = (
    <div className="flex items-center gap-2">
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
        label="Dealer Regime date"
        labelVisible={false}
        className="text-secondary border-edge rounded border bg-transparent px-1.5 py-0.5 font-mono text-[10px]"
      />
    </div>
  );

  return (
    <SectionBox label="Dealer Regime" headerRight={headerRight} collapsible>
      <p className="text-secondary mb-3 font-sans text-xs">
        Dealer-gamma regime at spot for SPX, NDX, SPY, QQQ.{' '}
        <span className="text-sky-300">Long γ</span> = dampening
        (mean-reverting), <span className="text-amber-300">short γ</span> =
        amplifying (acceleration-prone),{' '}
        <span className="text-zinc-300">transition</span> = spot near zero-gamma
        boundary, <span className="text-zinc-500">uncertain</span> = low
        confidence or stale data. Live polls every 30s; scrub the date or
        minute slider to read past sessions (compute-zero-gamma cron writes
        every 5 min, so per-minute resolution snaps to the nearest 5-minute
        bar).
      </p>
      <MinuteScrubber
        value={selectedMinuteCT}
        onChange={setSelectedMinuteCT}
        liveAvailable={liveAvailable}
      />
      <Body
        cells={cells}
        loading={loading}
        error={error}
        hasData={data != null}
      />
    </SectionBox>
  );
}

interface BodyProps {
  cells: ClassifiedCell[];
  loading: boolean;
  error: string | null;
  hasData: boolean;
}

function Body({ cells, loading, error, hasData }: BodyProps) {
  if (error && !hasData) {
    return (
      <div role="alert" className="text-secondary font-sans text-xs">
        {error}
      </div>
    );
  }
  if (loading && !hasData) {
    return <div className="text-secondary font-sans text-xs">Loading…</div>;
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map((c) => (
        <Cell key={c.ticker} ticker={c.ticker} row={c.row} state={c.state} />
      ))}
    </div>
  );
}

export const DealerRegimeTile = memo(DealerRegimeTileInner);
