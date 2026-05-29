/**
 * GET /api/cron/fetch-gexbot-fast
 *
 * Fast-cron half of the GEXBot Orderflow-tier capture pipeline. Polls
 * the small-payload endpoints once per minute for all 16 tickers:
 *
 *   - 16 × /{ticker}/orderflow/orderflow             → gexbot_snapshots
 *   - 16 × /{ticker}/classic/gex_zero (basic)        → merged into snapshot
 *   - 48 × /{ticker}/classic/{gex_zero|gex_one|gex_full}/maxchange
 *                                                      → gexbot_api_capture
 *   - 48 × /{ticker}/state/{gex_zero|gex_one|gex_full}/maxchange
 *                                                      → gexbot_api_capture
 *
 * Total: 128 HTTP calls per invocation, all small payloads. The classic
 * `gex_zero` basic call supplies the 10 aggregate fields (zero_gamma,
 * sum_gex_*, major_*, delta_risk_reversal, min_dte/sec_min_dte) that the
 * /orderflow payload omits despite the spec listing them — they're merged
 * into the same per-ticker snapshot row. See
 * docs/superpowers/specs/gexbot-classic-basic-capture-2026-05-29.md.
 *
 * The `/state/.../maxchange` sub-route accepts only the 3 DTE buckets
 * (gex_zero|gex_one|gex_full) — the per-strike Greek×DTE categories
 * ({gamma,delta,vanna,charm}_{zero,one}, heavy ~30 KB rows, 128 calls)
 * live in the sibling `fetch-gexbot-strikes` cron so the two payload
 * classes don't share a wall-time budget.
 *
 * See: docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md
 *
 * Environment: GEXBOT_API_KEY, CRON_SECRET
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { isFuturesRthCt } from '../_lib/cron-helpers.js';
import { mapWithConcurrency, withRetry } from '../_lib/uw-fetch.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  fetchOrderflow,
  fetchClassicBasic,
  fetchMaxchange,
  fetchStateMaxchange,
  GEXBOT_TICKERS,
  MAXCHANGE_CATEGORIES,
  STATE_MAXCHANGE_CATEGORIES,
  type GexbotResponse,
  type GexbotTicker,
  type MaxchangeCategory,
} from '../_lib/gexbot-client.js';
import { insertCaptureRows, type CaptureRow } from '../_lib/gexbot-store.js';
import { Sentry } from '../_lib/sentry.js';

// ── Scalar extraction ───────────────────────────────────────
//
// GEXBot's orderflow_response carries numeric fields as JSON numbers,
// but the spec marks most as optional and a few have been observed
// (per the Periscope scraper hardening work) to ship as null or omitted
// when the underlying calc isn't available. `n()` coalesces both into
// `null` so the NUMERIC column ingests cleanly.

function n(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function i(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  return null;
}

/**
 * Concurrency cap for the per-tick fetch fan-out. Sized to keep wall time
 * tight while preventing all 128 calls from launching simultaneously — a
 * 128-way burst paired with the per-call HTTP timeout can produce 128
 * Sentry events in a single tick if GEXBot has a slow minute.
 */
const FETCH_CONCURRENCY = 32;

/**
 * Max Sentry events per tick. Beyond this we emit a single summary
 * captureMessage and drop the remaining stack traces — better signal
 * than 100+ identical TimeoutError reports during a GEXBot outage.
 */
const SENTRY_CAPTURE_CAP = 10;

/**
 * DTE bucket whose classic basic_response feeds the snapshot aggregate
 * columns. We're a 0DTE tool and the snapshot scalars are single-valued,
 * so we take the 0DTE bucket. gex_one/gex_full basic capture is out of scope.
 */
const CLASSIC_BASIC_CATEGORY: MaxchangeCategory = 'gex_zero';

/**
 * The 10 aggregate fields the live /orderflow payload omits but the classic
 * basic_response carries. Merged from the classic gex_zero call into the
 * per-ticker orderflow snapshot row. See spec dated 2026-05-29.
 */
const CLASSIC_BASIC_FIELDS = [
  'zero_gamma',
  'sum_gex_vol',
  'sum_gex_oi',
  'major_pos_vol',
  'major_pos_oi',
  'major_neg_vol',
  'major_neg_oi',
  'delta_risk_reversal',
  'min_dte',
  'sec_min_dte',
] as const;

interface SnapshotRow {
  ticker: GexbotTicker;
  body: GexbotResponse;
}

/**
 * Merge the classic gex_zero aggregate fields into the orderflow body so a
 * single INSERT writes one enriched snapshot row. Orderflow stays canonical
 * for spot/ticker/timestamp and the flow scalars; classic supplies only the
 * 10 fields orderflow drops. Returns the orderflow body unchanged when no
 * classic row is available (fail-open — those 10 columns stay NULL).
 */
function mergeClassic(
  body: GexbotResponse,
  classic: GexbotResponse | undefined,
): GexbotResponse {
  if (!classic) return body;
  const merged: GexbotResponse = { ...body };
  for (const field of CLASSIC_BASIC_FIELDS) merged[field] = classic[field];
  return merged;
}

async function storeSnapshots(
  rows: SnapshotRow[],
  classicByTicker: Map<GexbotTicker, GexbotResponse>,
): Promise<void> {
  if (rows.length === 0) return;
  const sql = getDb();
  for (const { ticker, body: orderflowBody } of rows) {
    const body = mergeClassic(orderflowBody, classicByTicker.get(ticker));
    await withDbRetry(
      () => sql`
      INSERT INTO gexbot_snapshots (
        ticker, source_timestamp, spot, zero_gamma,
        z_mlgamma, z_msgamma, zero_mcall, zero_mput,
        zcvr, zgr, zvanna, zcharm,
        o_mlgamma, o_msgamma, one_mcall, one_mput,
        ocvr, ogr, ovanna, ocharm,
        agg_dex, one_agg_dex, agg_call_dex, one_agg_call_dex,
        agg_put_dex, one_agg_put_dex,
        net_dex, one_net_dex, net_call_dex, one_net_call_dex,
        net_put_dex, one_net_put_dex,
        dexoflow, gexoflow, cvroflow,
        one_dexoflow, one_gexoflow, one_cvroflow,
        sum_gex_vol, sum_gex_oi,
        major_pos_vol, major_pos_oi, major_neg_vol, major_neg_oi,
        delta_risk_reversal, min_dte, sec_min_dte,
        raw_response
      ) VALUES (
        ${ticker}, ${i(body.timestamp)}, ${n(body.spot)}, ${n(body.zero_gamma)},
        ${n(body.z_mlgamma)}, ${n(body.z_msgamma)}, ${n(body.zero_mcall)}, ${n(body.zero_mput)},
        ${n(body.zcvr)}, ${n(body.zgr)}, ${n(body.zvanna)}, ${n(body.zcharm)},
        ${n(body.o_mlgamma)}, ${n(body.o_msgamma)}, ${n(body.one_mcall)}, ${n(body.one_mput)},
        ${n(body.ocvr)}, ${n(body.ogr)}, ${n(body.ovanna)}, ${n(body.ocharm)},
        ${n(body.agg_dex)}, ${n(body.one_agg_dex)}, ${n(body.agg_call_dex)}, ${n(body.one_agg_call_dex)},
        ${n(body.agg_put_dex)}, ${n(body.one_agg_put_dex)},
        ${n(body.net_dex)}, ${n(body.one_net_dex)}, ${n(body.net_call_dex)}, ${n(body.one_net_call_dex)},
        ${n(body.net_put_dex)}, ${n(body.one_net_put_dex)},
        ${n(body.dexoflow)}, ${n(body.gexoflow)}, ${n(body.cvroflow)},
        ${n(body.one_dexoflow)}, ${n(body.one_gexoflow)}, ${n(body.one_cvroflow)},
        ${n(body.sum_gex_vol)}, ${n(body.sum_gex_oi)},
        ${n(body.major_pos_vol)}, ${n(body.major_pos_oi)}, ${n(body.major_neg_vol)}, ${n(body.major_neg_oi)},
        ${n(body.delta_risk_reversal)}, ${i(body.min_dte)}, ${i(body.sec_min_dte)},
        ${JSON.stringify(body)}::jsonb
      )
    `,
      2,
      10_000,
    );
  }
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  'fetch-gexbot-fast',
  async (ctx): Promise<CronResult> => {
    const apiKey = process.env.GEXBOT_API_KEY;
    if (!apiKey) {
      throw new Error('GEXBOT_API_KEY is not configured');
    }

    // Full work list: 16 orderflow + 16 classic gex_zero basic +
    // (16 × 3) classic maxchange + (16 × 3) state maxchange = 128 calls.
    type Task =
      | { kind: 'orderflow'; ticker: GexbotTicker }
      | {
          kind: 'classic-basic';
          ticker: GexbotTicker;
          category: MaxchangeCategory;
        }
      | {
          kind: 'classic-maxchange';
          ticker: GexbotTicker;
          category: MaxchangeCategory;
        }
      | {
          kind: 'state-maxchange';
          ticker: GexbotTicker;
          category: MaxchangeCategory;
        };

    const tasks: Task[] = [
      ...GEXBOT_TICKERS.map<Task>((ticker) => ({ kind: 'orderflow', ticker })),
      ...GEXBOT_TICKERS.map<Task>((ticker) => ({
        kind: 'classic-basic',
        ticker,
        category: CLASSIC_BASIC_CATEGORY,
      })),
      ...GEXBOT_TICKERS.flatMap<Task>((ticker) =>
        MAXCHANGE_CATEGORIES.map<Task>((category) => ({
          kind: 'classic-maxchange',
          ticker,
          category,
        })),
      ),
      ...GEXBOT_TICKERS.flatMap<Task>((ticker) =>
        STATE_MAXCHANGE_CATEGORIES.map<Task>((category) => ({
          kind: 'state-maxchange',
          ticker,
          category,
        })),
      ),
    ];

    // Wrap each fetch so the rejection carries `task` context for
    // Sentry tagging — Promise.allSettled exposes only `reason`.
    // Concurrency-capped (FETCH_CONCURRENCY) to avoid a 128-way burst on
    // every cron tick.
    const results = await mapWithConcurrency(
      tasks,
      FETCH_CONCURRENCY,
      async (task) => {
        try {
          // Retry transient 5xx / timeout / ECONNRESET up to 2 times
          // (3 attempts total, 1s + 2s exponential backoff). Suppresses
          // single-tick TimeoutError storms (SENTRY-EMERALD-DESERT-8F:
          // 214 events / 9 days) caused by GEXBot 1–2s slow minutes
          // brushing the 2.5s per-call timeout. `withRetry`'s classifier
          // matches /50[234]/ and /timeout|ECONN.../ but NOT 4xx, so a
          // bad API key still fails fast.
          let body: GexbotResponse;
          switch (task.kind) {
            case 'orderflow':
              body = await withRetry(() => fetchOrderflow(apiKey, task.ticker));
              break;
            case 'classic-basic':
              body = await withRetry(() =>
                fetchClassicBasic(apiKey, task.ticker, task.category),
              );
              break;
            case 'classic-maxchange':
              body = await withRetry(() =>
                fetchMaxchange(apiKey, task.ticker, task.category),
              );
              break;
            case 'state-maxchange':
              body = await withRetry(() =>
                fetchStateMaxchange(apiKey, task.ticker, task.category),
              );
              break;
            default: {
              // Exhaustiveness check — adding a new Task variant without
              // a matching case here trips a TS error at compile time.
              const _exhaustive: never = task;
              throw new Error(
                `unhandled task kind: ${JSON.stringify(_exhaustive)}`,
              );
            }
          }
          return { ok: true as const, task, body };
        } catch (err) {
          return { ok: false as const, task, err };
        }
      },
    );

    const snapshots: SnapshotRow[] = [];
    const captures: CaptureRow[] = [];
    const classicByTicker = new Map<GexbotTicker, GexbotResponse>();
    let failed = 0;
    let sentryCaptured = 0;

    for (const result of results) {
      if (!result.ok) {
        failed += 1;
        if (sentryCaptured < SENTRY_CAPTURE_CAP) {
          const tagCategory =
            result.task.kind === 'orderflow'
              ? 'orderflow'
              : result.task.category;
          Sentry.captureException(result.err, {
            tags: {
              'gexbot.cron': 'fast',
              'gexbot.ticker': result.task.ticker,
              'gexbot.endpoint': result.task.kind,
              'gexbot.category': tagCategory,
            },
          });
          sentryCaptured += 1;
        }
        continue;
      }
      const { task, body } = result;
      switch (task.kind) {
        case 'orderflow':
          snapshots.push({ ticker: task.ticker, body });
          break;
        case 'classic-basic':
          // Not a stored row of its own — merged into the orderflow
          // snapshot for the same ticker in storeSnapshots().
          classicByTicker.set(task.ticker, body);
          break;
        case 'classic-maxchange':
          captures.push({
            ticker: task.ticker,
            endpoint: 'classic',
            category: `${task.category}/maxchange`,
            sourceTimestamp: i(body.timestamp),
            rawJson: JSON.stringify(body),
          });
          break;
        case 'state-maxchange':
          captures.push({
            ticker: task.ticker,
            endpoint: 'state',
            category: `${task.category}/maxchange`,
            sourceTimestamp: i(body.timestamp),
            rawJson: JSON.stringify(body),
          });
          break;
        default: {
          const _exhaustive: never = task;
          throw new Error(
            `unhandled task kind in result loop: ${JSON.stringify(_exhaustive)}`,
          );
        }
      }
    }

    if (failed > SENTRY_CAPTURE_CAP) {
      Sentry.captureMessage(
        `fetch-gexbot-fast: ${failed - SENTRY_CAPTURE_CAP} additional failures suppressed (cap=${SENTRY_CAPTURE_CAP})`,
        {
          level: 'warning',
          tags: {
            'gexbot.cron': 'fast',
            'gexbot.summary': 'true',
          },
        },
      );
    }

    await storeSnapshots(snapshots, classicByTicker);
    await insertCaptureRows(captures);

    // How many snapshot rows received their classic gex_zero aggregate
    // merge — the live health signal for the 10-column revival. A drop to
    // 0 means GexBot stopped serving /classic/gex_zero basic.
    const enriched = snapshots.filter((s) =>
      classicByTicker.has(s.ticker),
    ).length;

    const stored = snapshots.length + captures.length;
    ctx.logger.info(
      {
        stored,
        snapshots: snapshots.length,
        captures: captures.length,
        enriched,
        failed,
      },
      'fetch-gexbot-fast completed',
    );

    return {
      status: failed === 0 ? 'success' : 'partial',
      rows: stored,
      metadata: {
        snapshots: snapshots.length,
        captures: captures.length,
        enriched,
        failed,
      },
    };
  },
  // Gate to futures-tied RTH (08:30–15:55 CT) instead of the default
  // equity-RTH window — GEXBot publishes through the futures settlement
  // window, and we want to keep capturing past the equity close at 15:00 CT.
  { requireApiKey: false, timeCheck: isFuturesRthCt },
);
