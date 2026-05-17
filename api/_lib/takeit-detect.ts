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
 * Look-back constants — pulled wider than the in-cron window so a fire at
 * minute 29 in a 30-min sliding window still sees prior fires from minute 0
 * of the window. The Phase 1 builder uses 30 min for burst-storm + same-dir;
 * we pull 35 min to absorb cron-tick drift.
 */
const SEQ_LOOKBACK_MIN = 35;
const COFIRE_LOOKBACK_MIN = 10;

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
  fetchPriorSessionWinRateByTicker: () => Promise<
    Array<{ underlying_symbol: string; win_rate: number | null }>
  >;
}

export interface TakeitDetectContext {
  bundle: TakeitBundle;
  ctx: SequentialContext;
}

/**
 * Build the per-cron-run context: load the bundle and pre-fetch the three
 * sequential-feature inputs. Returns null if the bundle is unreachable —
 * caller should proceed without takeit scoring (heuristic INSERT only).
 */
export async function loadTakeitDetectContext(
  alertType: AlertType,
  deps: TakeitContextDeps,
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
    const [same, other, winRates] = await Promise.all([
      deps.fetchRecentSameType(SEQ_LOOKBACK_MIN),
      deps.fetchRecentOtherTypeByChain(COFIRE_LOOKBACK_MIN),
      deps.fetchPriorSessionWinRateByTicker(),
    ]);

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
    Sentry.captureException(err as Error, {
      extra: { alertType, where: 'loadTakeitDetectContext.prefetch' },
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
    const featureRec = featuresForLottery(detectCtx.bundle, row, detectCtx.ctx);
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
    const featureRec = featuresForSilentBoom(
      detectCtx.bundle,
      row,
      detectCtx.ctx,
    );
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
