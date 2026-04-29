/**
 * GET /api/greek-flow
 *
 * Owner-or-guest read endpoint for the SPY+QQQ Greek flow session.
 * Reads from `vega_flow_etf` (populated by `fetch-greek-flow-etf` cron),
 * computes cumulative columns via Postgres window functions, and adds
 * derived metrics (slope / flip / cliff / divergence) for the UI panel.
 *
 * Owner-or-guest because `vega_flow_etf` is derived from UW (OPRA-licensed)
 * options flow — same access category as /api/spot-gex-history,
 * /api/zero-gamma, and /api/vega-spikes.
 *
 * Query params:
 *   ?date=YYYY-MM-DD  — optional; defaults to the latest ET date present
 *                       in `vega_flow_etf`. Used by the panel to scrub
 *                       historical sessions.
 *
 * Response:
 *   {
 *     date: string | null,                  // resolved date (null if table empty)
 *     tickers: {
 *       SPY: { rows: GreekFlowRow[], metrics: GreekFlowMetrics },
 *       QQQ: { rows: GreekFlowRow[], metrics: GreekFlowMetrics }
 *     },
 *     divergence: Record<GreekFlowField, DivergenceResult>,
 *     asOf: string                          // ISO timestamp of response
 *   }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  isMarketOpen,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { greekFlowQuerySchema } from './_lib/validation.js';
import {
  GREEK_FLOW_FIELDS,
  getGreekFlowSession,
  resolveLatestGreekFlowDate,
  splitByTicker,
  type GreekFlowField,
  type GreekFlowRow,
  type GreekFlowTicker,
} from './_lib/db-greek-flow.js';
import {
  divergence,
  lateDayCliff,
  recentFlip,
  slopeLastNMinutes,
  type CliffResult,
  type DivergenceResult,
  type FlipResult,
  type FlowPoint,
  type SlopeResult,
} from './_lib/greek-flow-metrics.js';

export type GreekFlowMetrics = Record<
  GreekFlowField,
  {
    slope: SlopeResult;
    flip: FlipResult;
    cliff: CliffResult;
  }
>;

export interface GreekFlowResponse {
  date: string | null;
  tickers: Record<
    GreekFlowTicker,
    {
      rows: GreekFlowRow[];
      metrics: GreekFlowMetrics;
    }
  >;
  divergence: Record<GreekFlowField, DivergenceResult>;
  asOf: string;
}

const CUM_FIELD_MAP: Record<GreekFlowField, keyof GreekFlowRow> = {
  dir_vega_flow: 'cum_dir_vega_flow',
  total_vega_flow: 'cum_total_vega_flow',
  otm_dir_vega_flow: 'cum_otm_dir_vega_flow',
  otm_total_vega_flow: 'cum_otm_total_vega_flow',
  dir_delta_flow: 'cum_dir_delta_flow',
  total_delta_flow: 'cum_total_delta_flow',
  otm_dir_delta_flow: 'cum_otm_dir_delta_flow',
  otm_total_delta_flow: 'cum_otm_total_delta_flow',
};

function toFlowPoints(
  rows: GreekFlowRow[],
  field: GreekFlowField,
): FlowPoint[] {
  const cumKey = CUM_FIELD_MAP[field];
  return rows.map((r) => ({
    timestamp: r.timestamp,
    cumulative: r[cumKey] as number,
  }));
}

function computeMetrics(rows: GreekFlowRow[]): GreekFlowMetrics {
  // Build once per field; the .reduce keeps the type checker happy
  // about the Record<...> shape and avoids `as any`.
  return GREEK_FLOW_FIELDS.reduce<GreekFlowMetrics>((acc, field) => {
    const points = toFlowPoints(rows, field);
    acc[field] = {
      slope: slopeLastNMinutes(points),
      flip: recentFlip(points),
      cliff: lateDayCliff(points),
    };
    return acc;
  }, {} as GreekFlowMetrics);
}

function lastCumulative(
  rows: GreekFlowRow[],
  field: GreekFlowField,
): number | null {
  const cumKey = CUM_FIELD_MAP[field];
  const last = rows.at(-1);
  return last ? (last[cumKey] as number) : null;
}

function emptyResponse(asOf: string): GreekFlowResponse {
  const emptyMetrics = GREEK_FLOW_FIELDS.reduce<GreekFlowMetrics>(
    (acc, field) => {
      acc[field] = {
        slope: { slope: null, points: 0 },
        flip: {
          occurred: false,
          atTimestamp: null,
          magnitude: 0,
          currentSign: 0,
        },
        cliff: { magnitude: 0, atTimestamp: null },
      };
      return acc;
    },
    {} as GreekFlowMetrics,
  );
  const emptyDivergence = GREEK_FLOW_FIELDS.reduce<
    Record<GreekFlowField, DivergenceResult>
  >(
    (acc, field) => {
      acc[field] = { spySign: 0, qqqSign: 0, diverging: false };
      return acc;
    },
    {} as Record<GreekFlowField, DivergenceResult>,
  );
  return {
    date: null,
    tickers: {
      SPY: { rows: [], metrics: emptyMetrics },
      QQQ: { rows: [], metrics: emptyMetrics },
    },
    divergence: emptyDivergence,
    asOf,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/greek-flow');
    const done = metrics.request('/api/greek-flow');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const parsed = greekFlowQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 400 });
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query',
      });
    }

    const requestedDate = parsed.data.date ?? null;
    const asOf = new Date().toISOString();

    try {
      const date = await resolveLatestGreekFlowDate(requestedDate);
      if (!date) {
        // Empty table — return shape-correct response so the UI doesn't
        // need a separate "no data" branch.
        setCacheHeaders(res, 60, 60);
        done({ status: 200 });
        return res.status(200).json(emptyResponse(asOf));
      }

      const allRows = await getGreekFlowSession(date);
      const split = splitByTicker(allRows);

      const spyMetrics = computeMetrics(split.SPY);
      const qqqMetrics = computeMetrics(split.QQQ);

      const divergenceByField = GREEK_FLOW_FIELDS.reduce<
        Record<GreekFlowField, DivergenceResult>
      >(
        (acc, field) => {
          acc[field] = divergence(
            lastCumulative(split.SPY, field),
            lastCumulative(split.QQQ, field),
          );
          return acc;
        },
        {} as Record<GreekFlowField, DivergenceResult>,
      );

      const response: GreekFlowResponse = {
        date,
        tickers: {
          SPY: { rows: split.SPY, metrics: spyMetrics },
          QQQ: { rows: split.QQQ, metrics: qqqMetrics },
        },
        divergence: divergenceByField,
        asOf,
      };

      // Live-ish during market hours, longer off-hours. Vary: Cookie via
      // setCacheHeaders so owner vs anon caches don't collide.
      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      done({ status: 200 });
      return res.status(200).json(response);
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err, requestedDate }, 'greek-flow fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
