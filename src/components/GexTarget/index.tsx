/**
 * GexTarget — 5-panel GEX target widget.
 *
 * Composes TargetTile (Panel 1), UrgencyPanel (Panel 2), SparklinePanel
 * (Panel 3), a Phase-8 price-chart placeholder (Panel 4), and StrikeBox
 * (Panel 5) into a single SectionBox with a mode toggle + scrubber header.
 *
 * The component owns the `mode` toggle state; `useGexTarget` always returns
 * all three modes so switching modes is a pure UI change with no refetch.
 */

import { memo, useState, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { SectionBox, Chip, StatusBadge } from '../ui';
import type { UseGexTargetReturn, SPXCandle } from '../../hooks/useGexTarget';
import { useNopeIntraday } from '../../hooks/useNopeIntraday';
import { TargetTile } from './TargetTile';
import { UrgencyPanel } from './UrgencyPanel';
import { SparklinePanel } from './SparklinePanel';
import { StrikeBox } from './StrikeBox';
import { PriceChart } from './PriceChart';
import {
  computeAttractingMomentum,
  flowConfluence,
  charmScore,
  dominance,
  clarity,
  proximity,
  priceConfirm,
  assignTier,
  assignWallSide,
  GEX_TARGET_CONFIG,
  type TargetScore,
  type StrikeScore,
  type PriceMovementContext,
} from '../../utils/gex-target';

// ── Types ─────────────────────────────────────────────────

export interface GexTargetProps {
  marketOpen: boolean;
  /**
   * The full `useGexTarget` return value, lifted to App.tsx so a single hook
   * call drives both this panel AND the OptionsFlowTable's GEX column. Before
   * lifting, the hook was called twice (here + App) producing two independent
   * polling intervals and two state trees.
   */
  gexTarget: UseGexTargetReturn;
}

type Mode = 'oi' | 'vol' | 'dir';

// ── Helpers ───────────────────────────────────────────────

function formatTime(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Chicago',
    });
  } catch {
    return '';
  }
}

// ── Price context ──────────────────────────────────────────
// Derives a PriceMovementContext from the visible 1-min SPX candles so that
// priceConfirm can be recomputed fresh in the browser rather than using the
// stale value stored in gex_target_features (which could be out of range for
// rows written before the formula was finalized).
function priceCtxFromCandles(candles: SPXCandle[]): PriceMovementContext {
  const latest = candles.at(-1);
  if (!latest) {
    return {
      deltaSpot_1m: 0,
      deltaSpot_3m: 0,
      deltaSpot_5m: 0,
      deltaSpot_20m: 0,
    };
  }
  const spotAt = (n: number) => candles.at(-(n + 1))?.close ?? latest.close;
  return {
    deltaSpot_1m: latest.close - spotAt(1),
    deltaSpot_3m: latest.close - spotAt(3),
    deltaSpot_5m: latest.close - spotAt(5),
    deltaSpot_20m: latest.close - spotAt(20),
  };
}

// ── Main component ─────────────────────────────────────────

export const GexTarget = memo(function GexTarget({
  marketOpen,
  gexTarget,
}: GexTargetProps) {
  const [mode, setMode] = useState<Mode>('oi');

  const {
    oi,
    vol,
    dir,
    timestamp,
    timestamps,
    selectedDate,
    setSelectedDate,
    availableDates,
    isLive,
    isToday,
    isScrubbed,
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubTo,
    scrubLive,
    loading,
    error,
    refresh,
    visibleCandles,
    previousClose,
    openingCallStrike,
    openingPutStrike,
  } = gexTarget;

  // SPY NOPE intraday overlay for PriceChart. Independent fetch — failure
  // here doesn't impact the GEX panels.
  const { points: nopePoints } = useNopeIntraday({ marketOpen });

  // Filter NOPE to the scrubbed time window so the overlay tracks the
  // time picker the same way visibleCandles does for price bars.
  const visibleNopePoints = useMemo(() => {
    if (!isScrubbed || !timestamp) return nopePoints;
    const limit = new Date(timestamp).getTime();
    return nopePoints.filter((p) => new Date(p.timestamp).getTime() <= limit);
  }, [nopePoints, isScrubbed, timestamp]);

  // ── Mode selection ───────────────────────────────────────

  const setOi = useCallback(() => setMode('oi'), []);
  const setVol = useCallback(() => setMode('vol'), []);
  const setDir = useCallback(() => setMode('dir'), []);

  // Recompute all scoring components browser-side so the displayed finalScore,
  // tier, and wallSide always reflect the current algorithm, not stale DB
  // values. priceConfirm is derived from visibleCandles (1-min SPX bars
  // already in the hook), giving the same calculation the cron would produce
  // for the same timestamp.
  const activeScore: TargetScore | null = useMemo(() => {
    const raw = mode === 'oi' ? oi : mode === 'vol' ? vol : dir;
    if (!raw) return null;

    // Spread-copy every entry so we don't mutate shared API response objects.
    const leaderboard: StrikeScore[] = raw.leaderboard.map((s) => ({
      ...s,
      isTarget: false,
    }));

    // Build the peer momentum array once for the full universe so dominance
    // is computed relative to every strike, not just surviving candidates.
    const peerMomenta = leaderboard.map((s) =>
      computeAttractingMomentum(s.features),
    );

    const { weights } = GEX_TARGET_CONFIG;
    const priceCtx = priceCtxFromCandles(visibleCandles);

    for (const s of leaderboard) {
      const dom = dominance(s.features, peerMomenta);
      const fc = flowConfluence(s.features);
      const pc = priceConfirm(s.features, priceCtx);
      const charm = charmScore(s.features);
      const clar = clarity(s.features);
      const prox = proximity(s.features);
      const freshScore =
        weights.flowConfluence * fc * dom * prox +
        weights.priceConfirm * pc * dom * prox +
        weights.charmScore * charm * prox +
        weights.clarity * (clar - 0.5);
      s.finalScore = freshScore;
      s.tier = assignTier(freshScore);
      s.wallSide = assignWallSide(s.tier, s.features.gexDollars);
    }

    // Sort by fresh score desc and find the highest-scoring eligible target.
    // Primary gates:
    //   1. Non-NONE tier
    //   2. Growing wall (attractingMomentum > 0)
    //   3. In the direction price is moving (priceConfirm >= 0)
    //   4. At least one strike away from spot (|distFromSpot| >= 5) so we
    //      recommend a forward-looking level instead of a strike price is
    //      already pinned on. At-spot strikes have priceConfirm = 0 by
    //      construction, so they always slip past the direction gate alone.
    // Fallback: drop the direction + at-spot gates in flat/ambiguous markets
    // where no strike passes all four conditions.
    const byScore = leaderboard
      .slice()
      .sort((a, b) => Math.abs(b.finalScore) - Math.abs(a.finalScore));
    const topTarget =
      byScore.find(
        (s) =>
          s.tier !== 'NONE' &&
          computeAttractingMomentum(s.features) > 0 &&
          priceConfirm(s.features, priceCtx) >= 0 &&
          Math.abs(s.features.distFromSpot) >= 5,
      ) ??
      byScore.find(
        (s) => s.tier !== 'NONE' && computeAttractingMomentum(s.features) > 0,
      );
    if (topTarget) topTarget.isTarget = true;

    return { target: topTarget ?? null, leaderboard };
  }, [mode, oi, vol, dir, visibleCandles]);

  const activeLeaderboard: StrikeScore[] = useMemo(
    () => activeScore?.leaderboard ?? [],
    [activeScore],
  );

  // ── Canonical top-5 strike universe (shared by all panels) ──────────────
  // All three panels — Strike Board, 5-Min Urgency, 20-Min Sparklines — must
  // display the same 5 strikes. The authoritative ranking is by |gexDollars|
  // (largest absolute GEX $ first). Each panel then re-sorts within this set
  // by its own metric (5m % change, 20m % change, or current GEX $).
  //
  // The target strike is always guaranteed to be in the set: if it falls
  // outside the top4 by GEX$, it replaces the 5th entry. Without this, the
  // Strike Board would never highlight the target row (isTarget flag), and
  // the TargetTile would recommend a strike the user can't find in the table.
  const top5ByGex = useMemo(() => {
    const target = activeScore?.target ?? null;
    const sorted = [...activeLeaderboard]
      .sort(
        (a, b) =>
          Math.abs(b.features.gexDollars) - Math.abs(a.features.gexDollars),
      )
      .slice(0, 5);

    if (
      target !== null &&
      sorted.length > 0 &&
      !sorted.some((s) => s.strike === target.strike)
    ) {
      sorted[sorted.length - 1] = target;
    }

    return sorted;
  }, [activeLeaderboard, activeScore]);

  // ── Live badge config ────────────────────────────────────

  // BACKTEST only when viewing a past date — today with closed market is not backtest.
  const badgeLabel = isLive
    ? '● LIVE'
    : isScrubbed
      ? 'SCRUBBED'
      : !isToday
        ? 'BACKTEST'
        : null;
  const badgeColor = isLive ? '#00e676' : isScrubbed ? '#ffb300' : '#ff9800';

  // ── Data availability check ──────────────────────────────

  const dateInAvailable =
    availableDates.length === 0 || availableDates.includes(selectedDate);

  // ── Datalist id ──────────────────────────────────────────

  const datalistId = 'gex-target-available-dates';
  const minDate = availableDates.length > 0 ? availableDates[0] : undefined;
  const maxDate = availableDates.length > 0 ? availableDates.at(-1) : undefined;

  // ── Header ───────────────────────────────────────────────

  const headerRight = (
    <div className="flex flex-wrap items-center gap-2">
      {/* Mode toggle */}
      <div className="flex items-center gap-1">
        <Chip active={mode === 'oi'} onClick={setOi} label="OI" />
        <Chip active={mode === 'vol'} onClick={setVol} label="VOL" />
        <Chip active={mode === 'dir'} onClick={setDir} label="DIR" />
      </div>

      {/* Scrubber */}
      <div className="border-edge flex items-center gap-0.5 rounded border">
        <button
          type="button"
          onClick={scrubPrev}
          disabled={!canScrubPrev}
          aria-label="Previous snapshot"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &#x25C0;
        </button>
        {timestamps.length > 1 && timestamp ? (
          <select
            value={timestamp ?? ''}
            onChange={(e) => scrubTo(e.target.value)}
            aria-label="Jump to snapshot time"
            className="border-edge min-w-[60px] cursor-pointer rounded border bg-transparent px-1 py-0.5 text-center font-mono text-[10px] outline-none"
            style={{
              color: isLive
                ? '#00e676'
                : isScrubbed
                  ? '#ffb300'
                  : !isToday
                    ? '#ff9800'
                    : 'var(--color-secondary)',
            }}
          >
            {timestamps.map((ts) => (
              <option key={ts} value={ts}>
                {formatTime(ts)}
              </option>
            ))}
          </select>
        ) : (
          timestamp && (
            <span
              className="min-w-[44px] text-center font-mono text-[10px]"
              style={{
                color: isLive
                  ? '#00e676'
                  : isScrubbed
                    ? '#ffb300'
                    : !isToday
                      ? '#ff9800'
                      : undefined,
              }}
            >
              {formatTime(timestamp)}
            </span>
          )
        )}
        <button
          type="button"
          onClick={scrubNext}
          disabled={!canScrubNext}
          aria-label="Next snapshot"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &#x25B6;
        </button>
      </div>

      {/* LIVE button — shown when scrubbed or viewing a past date */}
      {(isScrubbed || !isToday) && (
        <button
          type="button"
          onClick={scrubLive}
          aria-label="Resume live"
          className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider transition-colors"
          style={{
            color: '#00e676',
            background: 'rgba(0,230,118,0.08)',
            border: '1px solid rgba(0,230,118,0.25)',
          }}
        >
          LIVE
        </button>
      )}

      {/* Date picker */}
      <input
        type="date"
        value={selectedDate}
        onChange={(e) => setSelectedDate(e.target.value)}
        aria-label="Select date"
        list={datalistId}
        min={minDate}
        max={maxDate}
        className="text-secondary border-edge rounded border bg-transparent px-1.5 py-0.5 font-mono text-[10px]"
      />
      <datalist id={datalistId}>
        {availableDates.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>

      {/* Status badge — omitted when viewing today outside market hours */}
      {badgeLabel && <StatusBadge label={badgeLabel} color={badgeColor} />}

      {/* Refresh */}
      <button
        type="button"
        onClick={refresh}
        disabled={loading}
        aria-label="Refresh GEX target data"
        className="text-secondary hover:text-primary disabled:text-muted cursor-pointer font-mono text-[15px] disabled:cursor-default"
      >
        <span
          className={loading ? 'inline-block animate-spin' : undefined}
          aria-hidden="true"
        >
          ↻
        </span>
      </button>
    </div>
  );

  // ── Content ───────────────────────────────────────────────

  let content: ReactNode;

  if (loading) {
    content = (
      <div className="text-muted flex items-center justify-center py-8 font-mono text-[13px]">
        Loading GEX target…
      </div>
    );
  } else if (error) {
    content = (
      <div className="flex flex-col items-center gap-3 py-8">
        <p
          role="alert"
          className="text-danger font-mono text-[13px] font-medium"
        >
          {error}
        </p>
        <button
          type="button"
          onClick={refresh}
          className="text-secondary border-edge rounded border px-3 py-1 font-mono text-[12px]"
        >
          Retry
        </button>
      </div>
    );
  } else {
    content = (
      <>
        {/* Data-availability banner */}
        {availableDates.length > 0 && !dateInAvailable && (
          <p className="mb-2 text-[11px] text-[var(--color-muted)] italic">
            No data for this date. GEX target history is captured live from the
            cron — select a date from the picker to see available sessions.
          </p>
        )}

        {/* 5-panel layout */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[200px_1fr] md:items-stretch">
          {/* Left column: panels 1-3 (narrower so price chart has room) */}
          <div className="flex flex-col [&>section]:mt-0">
            <TargetTile score={activeScore} />
            <UrgencyPanel leaderboard={top5ByGex} />
            <SparklinePanel leaderboard={top5ByGex} />
          </div>

          {/* Panel 4: price chart */}
          <PriceChart
            candles={visibleCandles}
            previousClose={previousClose}
            score={activeScore}
            openingCallStrike={openingCallStrike}
            openingPutStrike={openingPutStrike}
            nopePoints={visibleNopePoints}
          />
        </div>

        {/* Panel 5: full-width strike box */}
        <div className="mt-3">
          <StrikeBox leaderboard={top5ByGex} />
        </div>
      </>
    );
  }

  return (
    <SectionBox label="GEX TARGET" headerRight={headerRight} collapsible>
      {content}
    </SectionBox>
  );
});

export default GexTarget;
