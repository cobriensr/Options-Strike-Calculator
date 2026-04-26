/**
 * useIVAnomalies — polls `/api/iv-anomalies` and aggregates the raw
 * per-minute anomaly stream into a stable per-compound-key view.
 *
 * Two pipelines share one poll:
 *
 *   1. Display — raw rows are grouped by `${ticker}:${strike}:${side}:${expiry}`
 *      (the "compound key"). While the detector keeps firing a given strike
 *      the hook keeps ONE `ActiveAnomaly` entry on the board and updates
 *      its metrics in place. The display list is sorted by `lastFiredTs`
 *      DESC so the freshest entry is always at the top.
 *
 *   2. Alert — the banner store receives a push + the sound chime fires
 *      ONLY when a compound key transitions from "not active" to "active"
 *      (entry banner) OR from active → cooling / distributing (exit banner).
 *      If a strike is already active, subsequent firings update its metrics
 *      silently. If the strike has been silent for ≥ ANOMALY_SILENCE_MS and
 *      then re-fires, that's treated as a NEW event and re-banners.
 *
 * Phase transitions (exit detection):
 *   - IV regression   → cooling       (iv_mid drops ≥30% of peak-entry span)
 *   - Ask-mid compression → cooling   (div <0.2vp after ≥5 min at >0.5vp)
 *   - Bid-side surge  → distributing  (bid-side vol in 15-min window ≥
 *                                      BID_SIDE_SURGE_RATIO × cumulative
 *                                      ask-side vol of the active span,
 *                                      AND ≥ BID_SIDE_MIN_VOL absolute)
 *
 * The bid-side-surge signal uses real tape data from the secondary
 * `/api/strike-trade-volume` poll (Phase 3 of tape-side spec). Replaced
 * the prior firing-rate-surge proxy on 2026-04-25.
 *
 *   When both signals would fire on the same poll, distributing takes display
 *   priority (stronger signal) but BOTH banners fire so the user sees both
 *   reasons. Cooling → active recovery (IV climbs past old peak) is silent —
 *   no banner, reset peak tracking.
 *
 * Other responsibilities preserved from the earlier row-level impl:
 *
 *   - Fetch on mount + every POLL_INTERVALS.CHAIN ms while the market is
 *     open. Gated on `marketOpen` (matches `useChainData`).
 *   - Back off to 2× the base interval after 3 consecutive network fails.
 *   - First-poll priming: the first successful poll seeds the active map
 *     without firing banners (pre-existing anomalies from before page
 *     load are history, not new signals). Priming also suppresses exit
 *     banners — a page-load state of "already cooling" is not a new event.
 *   - Eviction: each poll sweeps the active map for entries whose
 *     `lastFiredTs` is > ANOMALY_SILENCE_MS old (evaluated against
 *     `Date.now()`, which fake timers can control deterministically).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ANOMALY_SILENCE_MS,
  ASK_MID_ACCUMULATION_THRESHOLD,
  ASK_MID_COMPRESSION_MIN_ACTIVE_MS,
  ASK_MID_COMPRESSION_THRESHOLD,
  BID_SIDE_MIN_VOL,
  BID_SIDE_SURGE_RATIO,
  BID_SIDE_SURGE_WINDOW_MS,
  IV_REGRESSION_THRESHOLD,
  IV_REGRESSION_WINDOW_MS,
  POLL_INTERVALS,
} from '../constants';
import {
  anomalyCompoundKey,
  IV_ANOMALY_TICKERS,
  type ActiveAnomaly,
  type IVAnomaliesListResponse,
  type IVAnomalyExitReason,
  type IVAnomalyPhase,
  type IVAnomalyRow,
  type IVAnomalyTicker,
  type IVFiringPoint,
  type IVHistoryPoint,
  type TapeVolumePoint,
} from '../components/IVAnomalies/types';
import { ivAnomalyBannerStore } from '../components/IVAnomalies/banner-store';
import { playAnomalyChime } from '../utils/anomaly-sound';
import { getErrorMessage } from '../utils/error';

export interface UseIVAnomaliesReturn {
  /** Active compound keys, freshest first. */
  anomalies: ActiveAnomaly[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  // Replay scrubber (Phase 2 of replay spec) — mirrors useDarkPoolLevels.
  selectedDate: string;
  setSelectedDate: (d: string) => void;
  scrubTime: string | null;
  isLive: boolean;
  isScrubbed: boolean;
  canScrubPrev: boolean;
  canScrubNext: boolean;
  scrubPrev: () => void;
  scrubNext: () => void;
  /** Jump directly to a specific HH:MM time slot. */
  scrubTo: (time: string) => void;
  /** All available HH:MM time slots for the trading session. */
  timeGrid: readonly string[];
  scrubLive: () => void;
}

// 5-minute grid from 08:30 to 15:00 CT — matches useDarkPoolLevels.
const TIME_GRID: readonly string[] = (() => {
  const grid: string[] = [];
  for (let min = 8 * 60 + 30; min <= 15 * 60; min += 5) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    grid.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return grid;
})();

function etToday(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

function lastGridTimeBeforeNow(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const nowMin = (h >= 24 ? 0 : h) * 60 + m;
  for (let i = TIME_GRID.length - 1; i >= 0; i--) {
    const slot = TIME_GRID[i]!;
    const [sh, sm] = slot.split(':').map(Number);
    if (sh! * 60 + sm! <= nowMin) return slot;
  }
  return TIME_GRID[0]!;
}

/**
 * Convert a calendar date + HH:MM (CT) into a UTC ISO timestamp suitable
 * for the `?at=` query param AND for `nowMsOverride` in reconcile.
 *
 * Uses Intl to compute the correct CDT/CST offset for the given calendar
 * date — handles spring-forward and fall-back without hardcoded math.
 */
function ctClockToUtcIso(ymdDate: string, hhmm: string): string {
  const probe = new Date(`${ymdDate}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'shortOffset',
  });
  const parts = fmt.formatToParts(probe);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-6';
  const offsetMatch = tz.match(/GMT([+-]\d+)/);
  const offsetHours =
    offsetMatch && offsetMatch[1] ? Number.parseInt(offsetMatch[1], 10) : -6;
  const [hh, mm] = hhmm.split(':').map((v) => Number.parseInt(v, 10));
  const local = new Date(`${ymdDate}T00:00:00Z`);
  local.setUTCHours(hh! - offsetHours, mm!, 0, 0);
  return local.toISOString();
}

interface FetchResult {
  data: IVAnomaliesListResponse | null;
  networkError?: string;
}

async function fetchAnomalies(atIso?: string): Promise<FetchResult> {
  try {
    const url = atIso
      ? `/api/iv-anomalies?at=${encodeURIComponent(atIso)}`
      : '/api/iv-anomalies';
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });
    // Non-owner → 401. Treat as empty (feature is owner-gated).
    if (res.status === 401) return { data: null };
    if (!res.ok) {
      return {
        data: null,
        networkError: `IV anomalies API error ${res.status}`,
      };
    }
    const payload = (await res.json()) as unknown;
    if (
      typeof payload === 'object' &&
      payload != null &&
      (payload as { mode?: unknown }).mode === 'list'
    ) {
      return { data: payload as IVAnomaliesListResponse };
    }
    return { data: null, networkError: 'Unexpected response shape' };
  } catch (err) {
    return {
      data: null,
      networkError: getErrorMessage(err),
    };
  }
}

interface TapeVolumeSeries {
  ticker: IVAnomalyTicker;
  strike: number;
  side: 'call' | 'put';
  data: TapeVolumePoint[];
}

interface TapeVolumeFetchResult {
  series: TapeVolumeSeries[];
}

/**
 * Pull tape-side volume for one ticker since `sinceIso`. The endpoint
 * returns rows for ALL strikes of the ticker — the merge step filters
 * to active anomaly keys.
 *
 * Errors fail soft: returns empty series so the bid_side_surge signal
 * simply doesn't fire instead of blocking the whole hook.
 */
async function fetchTapeVolume(
  ticker: IVAnomalyTicker,
  sinceIso: string,
): Promise<TapeVolumeSeries[]> {
  try {
    const params = new URLSearchParams({ ticker, since: sinceIso });
    const res = await fetch(`/api/strike-trade-volume?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as Partial<TapeVolumeFetchResult>;
    return payload.series ?? [];
  } catch {
    return [];
  }
}

/**
 * After mergeTapeVolume updates an active entry's tape state, this
 * re-runs detectExitTransitions on each active entry. Reconcile only
 * evaluates exits when new rows arrive; tape data evolves on its own
 * cadence, so a strike whose detector firings have stopped but whose
 * tape now shows a bid-side surge would never transition without this
 * pass.
 *
 * Returns the updated map plus any new banner events. `prevMap` is the
 * pre-merge map (post-reconcile) so we can detect actual transitions
 * (entry was active before, now distributing/cooling).
 */
function reEvaluateExitsAfterTape(
  merged: ReadonlyMap<string, ActiveAnomaly>,
  prevMap: ReadonlyMap<string, ActiveAnomaly>,
  isFirstPoll: boolean,
  nowMs: number,
): {
  nextMap: Map<string, ActiveAnomaly>;
  bannerEvents: BannerEvent[];
} {
  const next = new Map(merged);
  const bannerEvents: BannerEvent[] = [];
  for (const [key, entry] of merged) {
    if (entry.phase !== 'active') continue;
    const transitions = detectExitTransitions(entry, entry.latest, nowMs);
    const displayed = pickDisplayedPhase(transitions);
    if (!displayed) continue;
    const prev = prevMap.get(key);
    if (prev && prev.phase !== 'active') continue;
    next.set(key, {
      ...entry,
      phase: displayed.phase,
      exitReason: displayed.reason,
    });
    if (!isFirstPoll) {
      for (const t of transitions) {
        bannerEvents.push({
          row: entry.latest,
          kind: 'exit',
          exitReason: t.reason,
        });
      }
    }
  }
  return { nextMap: next, bannerEvents };
}

/**
 * Merge fresh tape-volume series into the post-reconcile active map.
 * Updates each ActiveAnomaly's tapeVolumeHistory and accumulators in
 * place — non-mutating (returns a new map).
 *
 * Trim policy: keep only samples within BID_SIDE_SURGE_WINDOW_MS of
 * `nowMs` so the rolling-window math in detectExitTransitions stays
 * cheap. Accumulators sum EVERY sample seen during the active span,
 * not just the rolling window.
 */
function mergeTapeVolume(
  active: ReadonlyMap<string, ActiveAnomaly>,
  series: readonly TapeVolumeSeries[],
  nowMs: number,
): Map<string, ActiveAnomaly> {
  const next = new Map<string, ActiveAnomaly>(active);
  // Index incoming series by (ticker:strike:side) for O(1) lookup.
  const byKey = new Map<string, TapeVolumeSeries>();
  for (const s of series) {
    byKey.set(`${s.ticker}:${s.strike}:${s.side}`, s);
  }

  const surgeWindowStart = nowMs - BID_SIDE_SURGE_WINDOW_MS;
  for (const [key, entry] of active) {
    const tapeKey = `${entry.ticker}:${entry.strike}:${entry.side}`;
    const fresh = byKey.get(tapeKey);
    if (!fresh) continue;

    // Filter incoming samples to >= firstSeenTs (strictly within active span).
    const spanStartMs = tsMs(entry.firstSeenTs, 0);
    const spanSamples = fresh.data.filter((p) => tsMs(p.ts, 0) >= spanStartMs);

    // Recompute accumulators from scratch over the active span — this
    // is idempotent across repeated tape polls (the endpoint returns
    // ALL minutes since `since`).
    let accAsk = 0;
    let accBid = 0;
    for (const p of spanSamples) {
      accAsk += p.askSideVol;
      accBid += p.bidSideVol;
    }
    // Trim history to the surge window so detectExitTransitions runs cheap.
    const windowSamples = spanSamples.filter(
      (p) => tsMs(p.ts, 0) >= surgeWindowStart,
    );

    next.set(key, {
      ...entry,
      tapeVolumeHistory: windowSamples,
      accumulatedAskSideVol: accAsk,
      accumulatedBidSideVol: accBid,
    });
  }
  return next;
}

function collectRows(
  payload: IVAnomaliesListResponse,
): readonly IVAnomalyRow[] {
  // Flatten every ticker the server returned. `IV_ANOMALY_TICKERS` is
  // the source of truth for iteration order; tickers not present in the
  // payload contribute an empty slice via the nullish default.
  const out: IVAnomalyRow[] = [];
  for (const t of IV_ANOMALY_TICKERS) {
    const rows = payload.history[t];
    if (rows) out.push(...rows);
  }
  return out;
}

function isKnownTicker(t: string): t is IVAnomalyTicker {
  return (IV_ANOMALY_TICKERS as readonly string[]).includes(t);
}

/**
 * Parse an ISO timestamp to epoch ms. Returns `fallback` if parsing fails
 * or yields NaN so downstream math never silently misbehaves.
 */
function tsMs(iso: string, fallback: number): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Trim a (ts-keyed) rolling history to the last `windowMs`. Keeps the most
 * recent N-1 entries plus the newest so the series grows unbounded only if
 * windowMs grows unbounded.
 */
function trimHistory<T extends { ts: string }>(
  history: readonly T[],
  nowMs: number,
  windowMs: number,
): T[] {
  const cutoff = nowMs - windowMs;
  return history.filter((h) => tsMs(h.ts, 0) >= cutoff);
}

export interface ExitTransition {
  phase: 'cooling' | 'distributing';
  reason: IVAnomalyExitReason;
}

/**
 * Detect whether the current active-span should transition to cooling or
 * distributing. Returns a list — a single poll can flag multiple reasons.
 *
 * Pure and stateless: all inputs come from the `ActiveAnomaly`, output is
 * evaluated against thresholds. Ordered by reason so tests are stable.
 */
export function detectExitTransitions(
  entry: ActiveAnomaly,
  freshestRow: IVAnomalyRow,
  nowMs: number,
): ExitTransition[] {
  const transitions: ExitTransition[] = [];

  const currentIv = freshestRow.ivAtDetect;
  const currentAskMidDiv = freshestRow.askMidDiv;

  // 1. Bid-side surge → distributing.
  //    Real tape signal: bid-side volume in the last BID_SIDE_SURGE_WINDOW_MS
  //    must reach BID_SIDE_SURGE_RATIO × accumulated ask-side AND clear the
  //    BID_SIDE_MIN_VOL noise floor. Replaces the firing-rate-surge proxy
  //    that ran 2026-04-23 → 2026-04-25.
  if (entry.accumulatedAskSideVol > 0 && entry.tapeVolumeHistory.length > 0) {
    const surgeWindowStart = nowMs - BID_SIDE_SURGE_WINDOW_MS;
    let bidSideInWindow = 0;
    for (const p of entry.tapeVolumeHistory) {
      if (tsMs(p.ts, 0) >= surgeWindowStart) {
        bidSideInWindow += p.bidSideVol;
      }
    }
    const ratio = bidSideInWindow / entry.accumulatedAskSideVol;
    if (bidSideInWindow >= BID_SIDE_MIN_VOL && ratio >= BID_SIDE_SURGE_RATIO) {
      transitions.push({ phase: 'distributing', reason: 'bid_side_surge' });
    }
  }

  // 2. IV regression → cooling. Drop from peak ≥30% of (peak - entry) range,
  //    with peak recorded inside the 10-min rolling window.
  const peakAge = nowMs - tsMs(entry.peakTs, nowMs);
  if (peakAge <= IV_REGRESSION_WINDOW_MS && entry.peakIv > entry.entryIv) {
    const peakToEntryRange = entry.peakIv - entry.entryIv;
    const dropThreshold =
      entry.peakIv - IV_REGRESSION_THRESHOLD * peakToEntryRange;
    if (currentIv != null && currentIv < dropThreshold) {
      transitions.push({ phase: 'cooling', reason: 'iv_regression' });
    }
  }

  // 3. Ask-mid compression → cooling. Current div < 0.2vp AFTER having been
  //    above accumulation threshold for ≥5 min. Requires a recorded peak ts.
  if (
    entry.askMidPeakTs != null &&
    currentAskMidDiv != null &&
    currentAskMidDiv < ASK_MID_COMPRESSION_THRESHOLD
  ) {
    const peakAgeAsk = tsMs(entry.askMidPeakTs, 0) - tsMs(entry.firstSeenTs, 0);
    if (peakAgeAsk >= ASK_MID_COMPRESSION_MIN_ACTIVE_MS) {
      transitions.push({ phase: 'cooling', reason: 'ask_mid_compression' });
    }
  }

  return transitions;
}

/**
 * When multiple exit transitions fire on the same poll, distributing wins
 * the DISPLAYED phase. Cooling still emits its own banner so the user sees
 * both reasons. Returns null if the list is empty.
 */
function pickDisplayedPhase(
  transitions: readonly ExitTransition[],
): ExitTransition | null {
  if (transitions.length === 0) return null;
  const distributing = transitions.find((t) => t.phase === 'distributing');
  return distributing ?? transitions[0] ?? null;
}

/** Banner event emitted by reconcile — consumed by the caller to push + chime. */
export interface BannerEvent {
  row: IVAnomalyRow;
  kind: 'entry' | 'exit';
  exitReason?: IVAnomalyExitReason;
}

interface ReconcileResult {
  nextMap: ReadonlyMap<string, ActiveAnomaly>;
  /** Events to fan out to banner store + chime. */
  bannerEvents: BannerEvent[];
  /** Updated set of already-processed detector row ids. */
  nextSeenIds: Set<number>;
}

/**
 * Core aggregation — pure function so it's safe to call without worrying
 * about Strict Mode double-invocation or stale setState closures. Given
 * the existing map, the set of previously-processed row ids, and an
 * incoming batch of raw rows, produces the next map plus the list of
 * events that should banner.
 *
 * The `seenIds` guard is load-bearing: the API returns a rolling history
 * window, so poll N+1 re-sends every row from poll N. Without the guard
 * we'd re-count every row on every poll and inflate `firingCount`.
 *
 * Semantics (matches the spec):
 *   - Group rows by compound key (filtering rows we've already processed).
 *   - New compound key ⇒ add to map in `active` phase; entry banner UNLESS
 *     first poll (priming).
 *   - Existing compound key ⇒ update `latest` and `lastFiredTs`, bump
 *     `firingCount`. A silence gap of ≥ ANOMALY_SILENCE_MS between the
 *     existing `lastFiredTs` and the next row is treated as a NEW event
 *     (reset active-span bookkeeping incl. phase, entry banner).
 *   - Exit-phase detection runs after per-row metric updates. When a row
 *     transitions active → cooling/distributing, emit an exit banner
 *     (unless priming). Cooling → active recovery (IV climbs past old
 *     peak) is silent and resets peak tracking.
 *   - Eviction: after ingestion, drop any entry whose `lastFiredTs` is
 *     > ANOMALY_SILENCE_MS older than `Date.now()`.
 */
function reconcile(
  prev: ReadonlyMap<string, ActiveAnomaly>,
  seenIds: ReadonlySet<number>,
  rows: readonly IVAnomalyRow[],
  isFirstPoll: boolean,
  nowMsOverride?: number,
): ReconcileResult {
  const next = new Map(prev);
  // Replay support (Phase 2 of replay spec): when scrubbed to a past
  // timestamp, the caller passes that timestamp so silence eviction
  // and exit-signal detection compare against T instead of wall-clock
  // now. Defaults to Date.now() in live mode (zero behavior change).
  const nowMs = nowMsOverride ?? Date.now();
  const bannerEvents: BannerEvent[] = [];
  // Guard per-poll idempotence — if the same detector row id shows up in
  // multiple banner paths we still only push once per (id, kind) pair.
  const bannerKeys = new Set<string>();
  const nextSeenIds = new Set(seenIds);

  function pushBanner(event: BannerEvent): void {
    const key = `${event.row.id}:${event.kind}`;
    if (bannerKeys.has(key)) return;
    bannerKeys.add(key);
    bannerEvents.push(event);
  }

  // 1. Group previously-unseen rows by compound key.
  const byKey = new Map<string, IVAnomalyRow[]>();
  for (const row of rows) {
    if (!isKnownTicker(row.ticker)) continue;
    if (seenIds.has(row.id)) continue;
    nextSeenIds.add(row.id);
    const key = anomalyCompoundKey(row);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  // 2. Ingest each bucket.
  for (const [key, bucket] of byKey) {
    // Oldest → newest by ts so `latest` ends up as the freshest row
    // and firing bookkeeping matches chronological order.
    const sorted = [...bucket].sort((a, b) => tsMs(a.ts, 0) - tsMs(b.ts, 0));
    const existing = next.get(key);

    if (!existing) {
      const freshest = sorted.at(-1);
      const firstRow = sorted[0];
      if (!freshest || !firstRow) continue;
      const ticker = freshest.ticker;
      if (!isKnownTicker(ticker)) continue;

      // Seed tracking history from every row in the bucket so exit
      // detection has a baseline from the start.
      const ivHistory: IVHistoryPoint[] = sorted.map((r) => ({
        ts: r.ts,
        ivMid: r.ivAtDetect,
      }));
      const firingHistory: IVFiringPoint[] = sorted.map((r, i) => ({
        ts: r.ts,
        firingCount: i + 1,
      }));

      // peakIv = the max iv_mid seen in this seed batch.
      let peakIv = firstRow.ivAtDetect;
      let peakTs = firstRow.ts;
      for (const r of sorted) {
        if (r.ivAtDetect > peakIv) {
          peakIv = r.ivAtDetect;
          peakTs = r.ts;
        }
      }

      // askMidPeakTs = last ts where the div crossed above the accumulation
      // threshold in the seed batch (or null if never).
      let askMidPeakTs: string | null = null;
      for (const r of sorted) {
        if (
          r.askMidDiv != null &&
          r.askMidDiv > ASK_MID_ACCUMULATION_THRESHOLD
        ) {
          askMidPeakTs = r.ts;
        }
      }

      const seeded: ActiveAnomaly = {
        compoundKey: key,
        ticker,
        strike: freshest.strike,
        side: freshest.side,
        expiry: freshest.expiry,
        latest: freshest,
        firstSeenTs: firstRow.ts,
        lastFiredTs: freshest.ts,
        firingCount: sorted.length,
        phase: 'active',
        exitReason: null,
        entryIv: firstRow.ivAtDetect,
        peakIv,
        peakTs,
        entryAskMidDiv: firstRow.askMidDiv,
        askMidPeakTs,
        ivHistory: trimHistory(ivHistory, nowMs, IV_REGRESSION_WINDOW_MS),
        firingHistory: trimHistory(
          firingHistory,
          nowMs,
          IV_REGRESSION_WINDOW_MS,
        ),
        // Tape volume populated by mergeTapeVolume() after reconcile —
        // defaults are empty here so a freshly-seeded entry doesn't fire
        // bid_side_surge before any tape data has arrived.
        tapeVolumeHistory: [],
        accumulatedAskSideVol: 0,
        accumulatedBidSideVol: 0,
      };

      // If the seed batch already has enough data to trip an exit
      // transition on first observation, evaluate it. We'll still skip the
      // banner on first-poll priming so existing cooling state on mount
      // doesn't flood the board.
      const seedTransitions = detectExitTransitions(seeded, freshest, nowMs);
      const seedDisplayed = pickDisplayedPhase(seedTransitions);
      if (seedDisplayed) {
        seeded.phase = seedDisplayed.phase;
        seeded.exitReason = seedDisplayed.reason;
      }
      next.set(key, seeded);

      if (!isFirstPoll) {
        pushBanner({ row: freshest, kind: 'entry' });
        if (seedDisplayed) {
          for (const t of seedTransitions) {
            pushBanner({
              row: freshest,
              kind: 'exit',
              exitReason: t.reason,
            });
          }
        }
      }
      continue;
    }

    let runLastFiredMs = tsMs(existing.lastFiredTs, nowMs);
    let runLastFiredIso = existing.lastFiredTs;
    let runFirstSeenIso = existing.firstSeenTs;
    let runFiringCount = existing.firingCount;
    let runLatest: IVAnomalyRow = existing.latest;
    let runPhase: IVAnomalyPhase = existing.phase;
    let runExitReason: IVAnomalyExitReason | null = existing.exitReason;
    let runEntryIv = existing.entryIv;
    let runPeakIv = existing.peakIv;
    let runPeakTs = existing.peakTs;
    let runEntryAskMidDiv = existing.entryAskMidDiv;
    let runAskMidPeakTs = existing.askMidPeakTs;
    let runIvHistory: IVHistoryPoint[] = [...existing.ivHistory];
    let runFiringHistory: IVFiringPoint[] = [...existing.firingHistory];
    let runTapeVolumeHistory: TapeVolumePoint[] = [
      ...existing.tapeVolumeHistory,
    ];
    let runAccumulatedAskSideVol = existing.accumulatedAskSideVol;
    let runAccumulatedBidSideVol = existing.accumulatedBidSideVol;
    let rebannerRow: IVAnomalyRow | null = null;

    for (const row of sorted) {
      const rowMs = tsMs(row.ts, nowMs);
      if (rowMs - runLastFiredMs >= ANOMALY_SILENCE_MS) {
        // Silence gap long enough to treat this firing as a new event.
        // Reset active-span + exit bookkeeping and remember the row so we
        // can banner it (unless priming).
        runFirstSeenIso = row.ts;
        runFiringCount = 1;
        runPhase = 'active';
        runExitReason = null;
        runEntryIv = row.ivAtDetect;
        runPeakIv = row.ivAtDetect;
        runPeakTs = row.ts;
        runEntryAskMidDiv = row.askMidDiv;
        runAskMidPeakTs =
          row.askMidDiv != null &&
          row.askMidDiv > ASK_MID_ACCUMULATION_THRESHOLD
            ? row.ts
            : null;
        runIvHistory = [{ ts: row.ts, ivMid: row.ivAtDetect }];
        runFiringHistory = [{ ts: row.ts, firingCount: 1 }];
        runTapeVolumeHistory = [];
        runAccumulatedAskSideVol = 0;
        runAccumulatedBidSideVol = 0;
        rebannerRow = row;
      } else {
        runFiringCount += 1;
        // New peak? Update peak — ivAtDetect is a real number per the
        // server contract (never null on the row).
        if (row.ivAtDetect > runPeakIv) {
          runPeakIv = row.ivAtDetect;
          runPeakTs = row.ts;
          // If we were cooling and IV climbed BACK above the old peak, that
          // is a recovery — return to active, reset exit reason. Peak is
          // already updated to the new high above, so the NEXT cooling
          // transition measures against this new high.
          if (runPhase !== 'active') {
            runPhase = 'active';
            runExitReason = null;
          }
        }
        // Ask-mid peak tracking.
        if (
          row.askMidDiv != null &&
          row.askMidDiv > ASK_MID_ACCUMULATION_THRESHOLD
        ) {
          runAskMidPeakTs = row.ts;
        }
        runIvHistory.push({ ts: row.ts, ivMid: row.ivAtDetect });
        runFiringHistory.push({ ts: row.ts, firingCount: runFiringCount });
      }
      runLatest = row;
      runLastFiredIso = row.ts;
      runLastFiredMs = rowMs;
    }

    // Trim histories to the rolling window.
    runIvHistory = trimHistory(runIvHistory, nowMs, IV_REGRESSION_WINDOW_MS);
    runFiringHistory = trimHistory(
      runFiringHistory,
      nowMs,
      IV_REGRESSION_WINDOW_MS,
    );

    // Candidate record for exit evaluation — use after all row updates.
    const candidate: ActiveAnomaly = {
      ...existing,
      latest: runLatest,
      firstSeenTs: runFirstSeenIso,
      lastFiredTs: runLastFiredIso,
      firingCount: runFiringCount,
      phase: runPhase,
      exitReason: runExitReason,
      entryIv: runEntryIv,
      peakIv: runPeakIv,
      peakTs: runPeakTs,
      entryAskMidDiv: runEntryAskMidDiv,
      askMidPeakTs: runAskMidPeakTs,
      ivHistory: runIvHistory,
      firingHistory: runFiringHistory,
      tapeVolumeHistory: runTapeVolumeHistory,
      accumulatedAskSideVol: runAccumulatedAskSideVol,
      accumulatedBidSideVol: runAccumulatedBidSideVol,
    };

    let finalPhase: IVAnomalyPhase = runPhase;
    let finalExitReason: IVAnomalyExitReason | null = runExitReason;

    // Exit-phase evaluation — only if we're currently in `active` after all
    // row updates. (A row that just triggered a re-event above resets to
    // `active`; evaluating exits on the same poll would mis-fire — wait for
    // the next batch before looking for exit signals.)
    const wasActive = existing.phase === 'active' && !rebannerRow;
    if (wasActive && runPhase === 'active') {
      const transitions = detectExitTransitions(candidate, runLatest, nowMs);
      const displayed = pickDisplayedPhase(transitions);
      if (displayed) {
        finalPhase = displayed.phase;
        finalExitReason = displayed.reason;
        if (!isFirstPoll) {
          // Fire one banner per distinct transition reason — if cooling +
          // distributing both fire, the user sees both reasons.
          for (const t of transitions) {
            pushBanner({
              row: runLatest,
              kind: 'exit',
              exitReason: t.reason,
            });
          }
        }
      }
    }

    next.set(key, {
      ...candidate,
      phase: finalPhase,
      exitReason: finalExitReason,
    });

    if (rebannerRow && !isFirstPoll) {
      pushBanner({ row: rebannerRow, kind: 'entry' });
    }
  }

  // 3. Eviction pass — drop anything that's been silent ≥ threshold.
  //    Runs even on the first poll so pre-existing-but-stale entries
  //    don't clutter the board on mount.
  for (const [key, entry] of next) {
    const lastMs = tsMs(entry.lastFiredTs, nowMs);
    if (nowMs - lastMs >= ANOMALY_SILENCE_MS) {
      next.delete(key);
    }
  }

  return { nextMap: next, bannerEvents, nextSeenIds };
}

export { reconcile };

export function useIVAnomalies(
  enabled: boolean,
  marketOpen: boolean,
): UseIVAnomaliesReturn {
  // Aggregated active entries, keyed by compound key. We keep a map
  // internally for O(1) upsert and convert to a sorted array for the
  // return value. `activeMapRef` mirrors the React state so the async
  // refresh callback can read the current map without racing Strict Mode
  // double-invocation.
  const [activeMap, setActiveMap] = useState<
    ReadonlyMap<string, ActiveAnomaly>
  >(() => new Map());
  const activeMapRef = useRef<ReadonlyMap<string, ActiveAnomaly>>(new Map());
  // Rolling set of detector row ids we've already folded into the map.
  // The API re-sends recent rows across polls; without this guard we'd
  // re-ingest them and inflate firingCount on every poll.
  const seenIdsRef = useRef<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Replay scrub state (Phase 2 of replay spec).
  const [selectedDate, setSelectedDate] = useState(etToday);
  const [scrubTime, setScrubTime] = useState<string | null>(null);
  const isToday = selectedDate === etToday();
  const isLive = isToday && scrubTime === null;
  const isScrubbed = scrubTime !== null;

  // Reset scrub time when date changes — matches useDarkPoolLevels.
  useEffect(() => {
    setScrubTime(null);
  }, [selectedDate]);

  // Replay anchor: the UTC ISO `at` to send to the API and the
  // `nowMsOverride` for reconcile. Live mode uses neither.
  const replayIso: string | null = isLive
    ? null
    : isScrubbed
      ? ctClockToUtcIso(selectedDate, scrubTime!)
      : ctClockToUtcIso(selectedDate, '15:00'); // past-day default = close
  const replayAnchorMs: number | null = replayIso
    ? Date.parse(replayIso)
    : null;

  // Fail streak is STATE (not a ref) so the polling effect re-runs when
  // it crosses the backoff threshold. Mirrored on a ref so the captured
  // `refresh` closure can mutate it without being re-created.
  const [failStreak, setFailStreak] = useState(0);
  const failStreakRef = useRef(0);
  const primedRef = useRef(false);
  // Flipped on unmount so late-arriving fetch responses skip setState.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    // In replay mode we wipe the active map + seenIds at the start of
    // each refresh so the reconcile pass rebuilds the active set
    // cleanly from the new row window. Without this, active entries
    // from the previous time anchor would leak into the next.
    if (replayIso !== null) {
      activeMapRef.current = new Map();
      seenIdsRef.current = new Set();
      primedRef.current = false; // also suppress banner pushes for replay
    }
    fetchAnomalies(replayIso ?? undefined).then(async (result) => {
      if (!mountedRef.current) return;
      if (result.networkError) {
        const next = failStreakRef.current + 1;
        failStreakRef.current = next;
        setFailStreak(next);
        setError(result.networkError);
      } else if (failStreakRef.current !== 0) {
        failStreakRef.current = 0;
        setFailStreak(0);
      }

      if (result.data) {
        const rows = collectRows(result.data);
        const isFirstPoll = !primedRef.current;
        primedRef.current = true;

        // Compute the next map + side-effect queue OUTSIDE setState so
        // Strict Mode double-invocation never double-pushes banners or
        // re-plays the chime. We use a ref to read the current map.
        const { nextMap, bannerEvents, nextSeenIds } = reconcile(
          activeMapRef.current,
          seenIdsRef.current,
          rows,
          isFirstPoll,
          replayAnchorMs ?? undefined,
        );

        // Pull tape-side volume for active tickers and merge into the
        // map. Single-poll latency on bid_side_surge: tape fetched here
        // becomes visible to detectExitTransitions on the NEXT poll.
        // 15-min surge window makes 1-min latency acceptable.
        const tickersWithActive = new Set<IVAnomalyTicker>();
        for (const a of nextMap.values()) tickersWithActive.add(a.ticker);
        let earliestFirstSeenMs = Number.POSITIVE_INFINITY;
        for (const a of nextMap.values()) {
          const ms = tsMs(a.firstSeenTs, 0);
          if (ms < earliestFirstSeenMs) earliestFirstSeenMs = ms;
        }
        let mergedMap: ReadonlyMap<string, ActiveAnomaly> = nextMap;
        const allBannerEvents = [...bannerEvents];
        // Replay skips the tape-volume merge: the bid_side_surge re-eval
        // depends on a 15-min ROLLING window anchored on Date.now(),
        // and recomputing it for an arbitrary past timestamp would
        // require backfilled tape data we don't currently snapshot.
        // Live behavior preserved.
        if (
          replayIso === null &&
          tickersWithActive.size > 0 &&
          Number.isFinite(earliestFirstSeenMs)
        ) {
          const sinceIso = new Date(earliestFirstSeenMs).toISOString();
          const tapeResults = await Promise.all(
            [...tickersWithActive].map((t) => fetchTapeVolume(t, sinceIso)),
          );
          if (!mountedRef.current) return;
          const allSeries = tapeResults.flat();
          const tapeNowMs = Date.now();
          const merged = mergeTapeVolume(nextMap, allSeries, tapeNowMs);
          // Tape can fire bid_side_surge even without new detector rows —
          // re-evaluate exits on the merged map so a strike whose firings
          // stopped but whose tape just turned still transitions.
          const reEval = reEvaluateExitsAfterTape(
            merged,
            nextMap,
            isFirstPoll,
            tapeNowMs,
          );
          mergedMap = reEval.nextMap;
          allBannerEvents.push(...reEval.bannerEvents);
        }

        activeMapRef.current = mergedMap;
        seenIdsRef.current = nextSeenIds;
        setActiveMap(mergedMap);

        // Replay never fires banners or chimes — review of past alerts
        // shouldn't masquerade as live signals.
        if (replayIso === null && allBannerEvents.length > 0) {
          let entryCount = 0;
          let exitCount = 0;
          for (const event of allBannerEvents) {
            ivAnomalyBannerStore.push(event.row, {
              kind: event.kind,
              exitReason: event.exitReason ?? null,
            });
            if (event.kind === 'entry') entryCount += 1;
            else exitCount += 1;
          }
          if (entryCount > 0) playAnomalyChime('entry');
          if (exitCount > 0) playAnomalyChime('exit');
        }
      }
      setLoading(false);
    });
  }, [enabled, replayIso, replayAnchorMs]);

  // Fetch once on mount AND whenever replay anchor changes (date or
  // scrub time). One-shot in replay; polling effect below handles live.
  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  // Poll on interval ONLY in live mode. Past dates and scrubbed
  // timestamps are immutable — one-shot fetch is sufficient.
  useEffect(() => {
    if (!enabled || !marketOpen || !isLive) return;
    const backoff = failStreak >= 3 ? 2 : 1;
    const interval = setInterval(refresh, POLL_INTERVALS.CHAIN * backoff);
    return () => clearInterval(interval);
  }, [enabled, marketOpen, refresh, failStreak, isLive]);

  // ── Scrubber actions ─────────────────────────────────────────
  const scrubTimeIdx = scrubTime !== null ? TIME_GRID.indexOf(scrubTime) : null;
  const canScrubPrev = scrubTimeIdx === null ? true : scrubTimeIdx > 0;
  const canScrubNext =
    scrubTimeIdx !== null && scrubTimeIdx < TIME_GRID.length - 1;

  const scrubPrev = useCallback(() => {
    setScrubTime((cur) => {
      if (cur === null) return lastGridTimeBeforeNow();
      const idx = TIME_GRID.indexOf(cur);
      return idx > 0 ? (TIME_GRID[idx - 1] ?? cur) : cur;
    });
  }, []);

  const scrubNext = useCallback(() => {
    setScrubTime((cur) => {
      if (cur === null) return cur;
      const idx = TIME_GRID.indexOf(cur);
      return idx < TIME_GRID.length - 1 ? (TIME_GRID[idx + 1] ?? cur) : cur;
    });
  }, []);

  const scrubTo = useCallback((time: string) => {
    if (time === TIME_GRID.at(-1)) {
      setScrubTime(null);
    } else if (TIME_GRID.includes(time)) {
      setScrubTime(time);
    }
  }, []);

  const scrubLive = useCallback(() => {
    setScrubTime(null);
  }, []);

  // Freshest first: a user scanning the board cares about "what just fired"
  // more than "what started at 10:05 and is still grinding".
  const anomalies = useMemo<ActiveAnomaly[]>(() => {
    const arr = [...activeMap.values()];
    arr.sort((a, b) => tsMs(b.lastFiredTs, 0) - tsMs(a.lastFiredTs, 0));
    return arr;
  }, [activeMap]);

  return {
    anomalies,
    loading,
    error,
    refresh,
    selectedDate,
    setSelectedDate,
    scrubTime,
    isLive,
    isScrubbed,
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubTo,
    scrubLive,
    timeGrid: TIME_GRID,
  };
}
