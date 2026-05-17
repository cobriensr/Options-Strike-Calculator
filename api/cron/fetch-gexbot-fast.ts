/**
 * GET /api/cron/fetch-gexbot-fast
 *
 * Fast-cron half of the GEXBot Orderflow-tier capture pipeline. Polls
 * the small-payload endpoints once per minute for all 16 tickers:
 *
 *   - 16 × /{ticker}/orderflow/orderflow       → gexbot_snapshots
 *   - 16 × /{ticker}/classic/gex_zero/maxchange → gexbot_api_capture
 *   - 16 × /{ticker}/classic/gex_full/maxchange → gexbot_api_capture
 *
 * Total: 48 HTTP calls per invocation. State per-strike (128 calls) is
 * a sibling cron (`fetch-gexbot-strikes`) so neither cron tips over the
 * Hobby-plan 10-second timeout if GEXBot is briefly slow.
 *
 * See: docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md
 *
 * Environment: GEXBOT_API_KEY, CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  fetchOrderflow,
  fetchMaxchange,
  GEXBOT_TICKERS,
  MAXCHANGE_CATEGORIES,
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

interface SnapshotRow {
  ticker: GexbotTicker;
  body: GexbotResponse;
}

async function storeSnapshots(rows: SnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;
  const sql = getDb();
  for (const { ticker, body } of rows) {
    await sql`
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
    `;
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

    // Build the full work list: 16 orderflow + 32 maxchange = 48 calls.
    type Task =
      | { kind: 'orderflow'; ticker: GexbotTicker }
      | {
          kind: 'maxchange';
          ticker: GexbotTicker;
          category: MaxchangeCategory;
        };

    const tasks: Task[] = [
      ...GEXBOT_TICKERS.map<Task>((ticker) => ({ kind: 'orderflow', ticker })),
      ...GEXBOT_TICKERS.flatMap<Task>((ticker) =>
        MAXCHANGE_CATEGORIES.map<Task>((category) => ({
          kind: 'maxchange',
          ticker,
          category,
        })),
      ),
    ];

    // Wrap each fetch so the rejection carries `task` context for
    // Sentry tagging — Promise.allSettled exposes only `reason`.
    const results = await Promise.all(
      tasks.map(async (task) => {
        try {
          const body =
            task.kind === 'orderflow'
              ? await fetchOrderflow(apiKey, task.ticker)
              : await fetchMaxchange(apiKey, task.ticker, task.category);
          return { ok: true as const, task, body };
        } catch (err) {
          return { ok: false as const, task, err };
        }
      }),
    );

    const snapshots: SnapshotRow[] = [];
    const captures: CaptureRow[] = [];
    let failed = 0;

    for (const result of results) {
      if (!result.ok) {
        failed += 1;
        const tagCategory =
          result.task.kind === 'orderflow' ? 'orderflow' : result.task.category;
        Sentry.captureException(result.err, {
          tags: {
            'gexbot.cron': 'fast',
            'gexbot.ticker': result.task.ticker,
            'gexbot.endpoint': result.task.kind,
            'gexbot.category': tagCategory,
          },
        });
        continue;
      }
      const { task, body } = result;
      if (task.kind === 'orderflow') {
        snapshots.push({ ticker: task.ticker, body });
      } else {
        captures.push({
          ticker: task.ticker,
          endpoint: 'classic',
          category: `${task.category}/maxchange`,
          sourceTimestamp: i(body.timestamp),
          rawJson: JSON.stringify(body),
        });
      }
    }

    await storeSnapshots(snapshots);
    await insertCaptureRows(captures);

    const stored = snapshots.length + captures.length;
    ctx.logger.info(
      {
        stored,
        snapshots: snapshots.length,
        captures: captures.length,
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
        failed,
      },
    };
  },
  { requireApiKey: false },
);
