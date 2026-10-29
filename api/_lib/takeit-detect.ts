/**
 * Take-It detect-time integration helpers.
 *
 * Phase 3c: at detect-cron startup, pre-fetch the bundle + the sequential
 * context needed by takeit-features.ts. Per fire, build the feature record
 * and run the scorer. All paths fail-open: any error path returns a null
 * score, the heuristic INSERT still proceeds.
 *
 * Spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md
 */

import { isRetryableDbError } from './db.js';
import { DeadlineError, withDeadline } from './deadline.js';
import { Sentry } from './sentry.js';
import {
  type AlertType,
  type LotteryAlertRow,
  type SequentialContext,
  type SilentBoomAlertRow,
  featuresForLottery,
  featuresForSilentBoom,
  tickerDirKey,
} from './takeit-features.js';
import { getBundle } from './takeit-bundle-loader.js';
import {
  type TakeitBundle,
  featuresFromRow,
  predictTakeitScore,
} from './takeit-score.js';

/**
 * Defense-in-depth sanitizer for numeric scoring inputs. The tree walk
 * already routes null and NaN via `default_left`, but it compares ±Infinity
 * as a real value, so an infinite feature always takes one side of every
 * split. XGBoost refuses inf at training (fit/DMatrix: "Input data contains
 * `inf`"), so the model never saw one; predict_proba would still score it
 * as a real value, as walkTree does. We coerce every non-finite value (and
 * any non-number) to null so the model gets its known "missing" routing,
 * the stored feature record holds no NaN/Infinity, and the count below
 * shows where bad inputs come from.
 *
 * When rejectedCount > 0, the calling score function (scoreLottery /
 * scoreSilentBoom) fires Sentry.captureMessage at level 'info' with the
 * row's option_chain_id in extra, so we can backtrack what's emitting bad
 * inputs. Per-row Sentry events are intentional — Sentry groups by message
 * fingerprint by default, so 1000 rows with the same sanitize-trigger
 * produce ONE issue with N occurrences, not N separate issues.
 */
export function sanitizeScoringInputs(
  rec: Record<string, number | null | undefined>,
): Record<string, number | null>;
export function sanitizeScoringInputs(
  rec: Record<string, number | null | undefined>,
  opts: { withRejectedCount: true },
): { sanitized: Record<string, number | null>; rejectedCount: number };
export function sanitizeScoringInputs(
  rec: Record<string, number | null | undefined>,
  opts?: { withRejectedCount: boolean },
):
  | Record<string, number | null>
  | { sanitized: Record<string, number | null>; rejectedCount: number } {
  const sanitized: Record<string, number | null> = {};
  let rejectedCount = 0;
  for (const [key, value] of Object.entries(rec)) {
    if (value == null) {
      sanitized[key] = null;
      continue;
    }
    if (!Number.isFinite(value)) {
      sanitized[key] = null;
      rejectedCount += 1;
      continue;
    }
    sanitized[key] = value;
  }
  if (opts?.withRejectedCount) {
    return { sanitized, rejectedCount };
  }
  return sanitized;
}

/**
 * Look-back constants — pulled wider than the in-cron window so a fire at
 * minute 29 in a 30-min sliding window still sees prior fires from minute 0
 * of the window. The Phase 1 builder uses 30 min for burst-storm + same-dir;
 * we pull 35 min to absorb cron-tick drift.
 */
const SEQ_LOOKBACK_MIN = 35;
const COFIRE_LOOKBACK_MIN = 10;

/**
 * Per-run budget for the whole sequential-context prefetch, whatever
 * retries the callers give their queries. The detect crons run in a 60 s
 * function; on a slow Neon the old 3-attempt × 10 s prefetch used most of
 * that, then timed the run out and lost fires (spec
 * lottery-cron-timeouts-2026-10-28.md). On the deadline the run scores
 * nothing (takeit_prob NULL) and writes its fires anyway. The queries are
 * not cancelled; Neon finishes them and the result is dropped.
 */
const PREFETCH_DEADLINE_MS = 5_000;

/**
 * Upper bound on one shared win-rate load (see priorSessionWinRatesForDay).
 * It only frees the in-flight marker when a request hangs, so a later run
 * can try again; a slow load that does finish should land, because the
 * next attempt would be just as slow. The query measured 4.9 s on an idle
 * Neon and passed 10 s under load (2026-10-28). The load outlives the run
 * that started it (later runs share it), so it may exceed the crons' 60 s
 * maxDuration; a hung one blocks Take-It for about two minute-runs.
 */
const WIN_RATE_LOAD_TIMEOUT_MS = 120_000;

/**
 * How far into its run a run with nothing else to do (an empty pre-open
 * scan) may wait on the day's win-rate load it started (awaitWinRateWarmup),
 * measured from the run's start, not from the wait: a tick scan that spent
 * 33 s in retries leaves only 12 s. Waiting keeps the instance from being
 * frozen with the load in flight, so the first real run of the day finds
 * the cache warm. 15 s short of the crons' 60 s maxDuration, which leaves
 * room for the Sentry check-in, the Axiom event and the response.
 */
const WIN_RATE_WARMUP_UNTIL_MS = 45_000;

export interface RecentFireRow {
  fire_time: Date;
  underlying_symbol: string;
  option_type: 'C' | 'P';
}

export interface RecentCofireRow {
  option_chain_id: string;
  underlying_symbol: string;
  option_type: 'C' | 'P';
  fire_time: Date;
}

/**
 * SQL-friendly DB shape used by the cron's caller. The cron already holds a
 * neon `Sql` tagged-template; we accept a tiny shim interface so this module
 * is unit-testable without pulling neon-serverless into the test.
 */
export interface TakeitContextDeps {
  fetchRecentSameType: (lookbackMin: number) => Promise<RecentFireRow[]>;
  fetchRecentOtherTypeByChain: (
    lookbackMin: number,
  ) => Promise<RecentCofireRow[]>;
  fetchPriorSessionWinRateByTicker: () => Promise<PriorWinRateRow[]>;
}

export interface PriorWinRateRow {
  underlying_symbol: string;
  win_rate: number | null;
}

interface WinRateEntry {
  /** ET date (YYYY-MM-DD) the rows were loaded for: dates before it. */
  day: string;
  /** The load itself, so callers that arrive mid-load share it. */
  rows: Promise<PriorWinRateRow[]>;
}

// One entry per alert type (a closed two-member key), replaced when the ET
// date changes. Each detect cron is its own function, so an instance holds
// one entry in practice. Module state outlives a request on Fluid Compute,
// which is the point: the load runs once per ET day per instance instead
// of once per run.
const winRateCache: Partial<Record<AlertType, WinRateEntry>> = {};

/**
 * The per-ticker prior-session win rates for the ET day `today`, loaded
 * once per day per alert type and shared by every run on this instance.
 *
 * The answer depends only on `today`: `load(today)` must aggregate fires
 * dated strictly before it, and those rows' outcome columns are written by
 * the post-close enrich crons, so they don't change during the session. A
 * new date replaces the entry. A failed or hung load is dropped, never
 * cached, so the next run tries again; a load still in flight is shared,
 * so a slow Neon sees one copy of the query, not one per run.
 */
export function priorSessionWinRatesForDay(
  alertType: AlertType,
  today: string,
  load: (beforeDate: string) => Promise<PriorWinRateRow[]>,
): Promise<PriorWinRateRow[]> {
  const cached = winRateCache[alertType];
  if (cached?.day === today) return cached.rows;

  const entry: WinRateEntry = {
    day: today,
    rows: withDeadline(
      load(today),
      WIN_RATE_LOAD_TIMEOUT_MS,
      'Take-It win-rate load',
    ),
  };
  winRateCache[alertType] = entry;
  // Drop a failed load, unless a newer day already replaced it. This
  // handler also keeps the rejection from going unhandled when no run is
  // awaiting it any more (its run passed the prefetch deadline).
  entry.rows.catch(() => {
    if (winRateCache[alertType] === entry) delete winRateCache[alertType];
  });
  return entry.rows;
}

/**
 * Wait for a win-rate load started earlier in the run
 * (priorSessionWinRatesForDay), until WIN_RATE_WARMUP_UNTIL_MS after
 * `startTimeMs`, the run's start (CronContext.startTimeMs). No wait at all
 * once the run is past that. For a run that has nothing else to do, so the
 * load finishes while the instance is still running. Never rejects: a
 * failed load is already out of the cache, the next run starts it again,
 * and its prefetch reports the failure.
 */
export async function awaitWinRateWarmup(
  warmup: Promise<unknown>,
  startTimeMs: number,
): Promise<void> {
  const budgetMs = WIN_RATE_WARMUP_UNTIL_MS - (Date.now() - startTimeMs);
  if (budgetMs <= 0) return;
  try {
    await withDeadline(warmup, budgetMs, 'Take-It win-rate warm-up');
  } catch {
    // See above: nothing to report here, and nothing waits on the result.
  }
}

/**
 * Why a Take-It prefetch failed, for the cron's run status:
 *   - 'timeout': it passed PREFETCH_DEADLINE_MS (Neon slow);
 *   - 'transient': a retryable Neon error (a blip);
 *   - 'error': anything else, i.e. a broken query. A bug: the run reports
 *     'error'.
 */
export interface TakeitPrefetchFailure {
  reason: string;
  kind: 'timeout' | 'transient' | 'error';
}

export interface TakeitDetectContext {
  bundle: TakeitBundle;
  ctx: SequentialContext;
}

/**
 * Build the per-cron-run context: load the bundle and pre-fetch the three
 * sequential-feature inputs. Returns null if the bundle is unreachable or
 * the prefetch fails — caller should proceed without takeit scoring
 * (heuristic INSERT only).
 *
 * The prefetch runs under PREFETCH_DEADLINE_MS. A failure (deadline or
 * rejection) sends one Sentry event per call, that is one per cron run (a
 * warning for a timeout or a Neon blip, an error for a broken query), and
 * is passed to `onPrefetchFailure` so the run can count it and report its
 * status.
 */
export async function loadTakeitDetectContext(
  alertType: AlertType,
  deps: TakeitContextDeps,
  onPrefetchFailure?: (failure: TakeitPrefetchFailure) => void,
): Promise<TakeitDetectContext | null> {
  let bundle: TakeitBundle | null;
  try {
    bundle = await getBundle(alertType);
  } catch (err) {
    // BundleSchemaError is the only thrown case (fail-closed). For detect we
    // log + skip — silent miscompute is worse, but a broken alert flow is
    // also bad. Log loud + skip the score, heuristic still lands.
    Sentry.captureException(err as Error, {
      extra: { alertType, where: 'loadTakeitDetectContext' },
    });
    return null;
  }
  if (!bundle) return null;

  try {
    const [same, other, winRates] = await withDeadline(
      Promise.all([
        deps.fetchRecentSameType(SEQ_LOOKBACK_MIN),
        deps.fetchRecentOtherTypeByChain(COFIRE_LOOKBACK_MIN),
        deps.fetchPriorSessionWinRateByTicker(),
      ]),
      PREFETCH_DEADLINE_MS,
      'Take-It prefetch',
    );

    const recentOtherTypeByChain = new Map<string, RecentCofireRow[]>();
    const recentOtherTypeByTickerDir = new Map<
      string,
      Array<{ fire_time: Date; option_chain_id: string }>
    >();
    for (const r of other) {
      const chainList = recentOtherTypeByChain.get(r.option_chain_id);
      if (chainList) chainList.push(r);
      else recentOtherTypeByChain.set(r.option_chain_id, [r]);

      const dirKey = tickerDirKey(r.underlying_symbol, r.option_type);
      const dirEntry = {
        fire_time: r.fire_time,
        option_chain_id: r.option_chain_id,
      };
      const dirList = recentOtherTypeByTickerDir.get(dirKey);
      if (dirList) dirList.push(dirEntry);
      else recentOtherTypeByTickerDir.set(dirKey, [dirEntry]);
    }

    const priorSessionWinRateByTicker = new Map<string, number | null>();
    for (const w of winRates) {
      priorSessionWinRateByTicker.set(w.underlying_symbol, w.win_rate);
    }

    return {
      bundle,
      ctx: {
        recentSameTypeFires: same,
        recentOtherTypeByChain,
        recentOtherTypeByTickerDir,
        priorSessionWinRateByTicker,
      },
    };
  } catch (err) {
    let kind: TakeitPrefetchFailure['kind'] = 'error';
    if (err instanceof DeadlineError) kind = 'timeout';
    else if (isRetryableDbError(err)) kind = 'transient';
    Sentry.captureException(err, {
      // Neon being slow or blipping degrades one run (warning); any other
      // rejection is a broken query, a bug that pages (error).
      level: kind === 'error' ? 'error' : 'warning',
      // Timeouts (Neon slow) and errors (a blip or a broken query) are
      // different problems: keep them in separate issues.
      fingerprint: [
        'takeit-detect',
        alertType,
        kind === 'timeout' ? 'prefetch-timeout' : 'prefetch-error',
      ],
      tags: { 'takeit.alert_type': alertType },
      extra: { alertType, where: 'loadTakeitDetectContext.prefetch' },
    });
    onPrefetchFailure?.({
      reason: err instanceof Error ? err.message : String(err),
      kind,
    });
    return null;
  }
}

/** Result of a per-row Take-It scoring pass — also returns the feature
 *  record so the detect cron can persist it for the SHAP fill cron. */
export interface TakeitScoreResult {
  prob: number | null;
  version: string | null;
  features: Record<string, number | null> | null;
}

/** Score one lottery alert row → calibrated prob (null on failure). */
export function scoreLottery(
  detectCtx: TakeitDetectContext | null,
  row: LotteryAlertRow,
): TakeitScoreResult {
  if (!detectCtx) return { prob: null, version: null, features: null };
  try {
    const rawFeatureRec = featuresForLottery(
      detectCtx.bundle,
      row,
      detectCtx.ctx,
    );
    const { sanitized: featureRec, rejectedCount } = sanitizeScoringInputs(
      rawFeatureRec,
      { withRejectedCount: true },
    );
    if (rejectedCount > 0) {
      Sentry.captureMessage(
        `takeit: ${rejectedCount} non-finite feature(s) sanitized`,
        {
          level: 'info',
          tags: { 'takeit.alert_type': 'lottery', 'takeit.sanitize': 'true' },
          extra: {
            option_chain_id: row.option_chain_id,
            rejected_count: rejectedCount,
          },
        },
      );
    }
    const featureArr = featuresFromRow(detectCtx.bundle, featureRec);
    const result = predictTakeitScore(detectCtx.bundle, featureArr);
    return {
      prob: result.prob_calibrated,
      version: detectCtx.bundle.version,
      features: featureRec,
    };
  } catch (err) {
    Sentry.captureException(err as Error, {
      extra: {
        alertType: 'lottery',
        where: 'scoreLottery',
        option_chain_id: row.option_chain_id,
      },
    });
    return { prob: null, version: null, features: null };
  }
}

/** Score one silent-boom alert row → calibrated prob (null on failure). */
export function scoreSilentBoom(
  detectCtx: TakeitDetectContext | null,
  row: SilentBoomAlertRow,
): TakeitScoreResult {
  if (!detectCtx) return { prob: null, version: null, features: null };
  try {
    const rawFeatureRec = featuresForSilentBoom(
      detectCtx.bundle,
      row,
      detectCtx.ctx,
    );
    const { sanitized: featureRec, rejectedCount } = sanitizeScoringInputs(
      rawFeatureRec,
      { withRejectedCount: true },
    );
    if (rejectedCount > 0) {
      Sentry.captureMessage(
        `takeit: ${rejectedCount} non-finite feature(s) sanitized`,
        {
          level: 'info',
          tags: {
            'takeit.alert_type': 'silentboom',
            'takeit.sanitize': 'true',
          },
          extra: {
            option_chain_id: row.option_chain_id,
            rejected_count: rejectedCount,
          },
        },
      );
    }
    const featureArr = featuresFromRow(detectCtx.bundle, featureRec);
    const result = predictTakeitScore(detectCtx.bundle, featureArr);
    return {
      prob: result.prob_calibrated,
      version: detectCtx.bundle.version,
      features: featureRec,
    };
  } catch (err) {
    Sentry.captureException(err as Error, {
      extra: {
        alertType: 'silentboom',
        where: 'scoreSilentBoom',
        option_chain_id: row.option_chain_id,
      },
    });
    return { prob: null, version: null, features: null };
  }
}
