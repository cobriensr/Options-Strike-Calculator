/**
 * GET /api/ml/plots
 *
 * Returns all ML pipeline plot analyses and findings data for
 * the frontend carousel. Public read — no auth required (matches
 * existing data endpoint pattern: only Claude API calls are
 * owner-gated, all data reads are public for guests).
 *
 * Response shape:
 *   {
 *     plots: Array<{ name, blobUrl, analysis, model, pipelineDate, updatedAt }>,
 *     findings: Record<string, unknown> | null,
 *     pipelineDate: string | null
 *   }
 *
 * Cache: public, s-maxage=3600, stale-while-revalidate=86400
 *        (data only changes once nightly)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

interface PlotAnalysis {
  visualization: string;
  data_inputs: string;
  interpretation: string;
  implications: string;
  caveats: string;
}

interface PlotRow {
  plot_name: string;
  blob_url: string;
  analysis: PlotAnalysis | null;
  model: string;
  pipeline_date: Date | string;
  updated_at: Date | string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/ml/plots');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  try {
    const sql = getDb();

    // Fetch plot analyses and findings in parallel
    const [plotRows, findingsRows] = await Promise.all([
      sql`
        SELECT plot_name, blob_url, analysis, model,
               pipeline_date, updated_at
        FROM ml_plot_analyses
        ORDER BY plot_name
      ` as unknown as Promise<PlotRow[]>,
      sql`
        SELECT findings FROM ml_findings WHERE id = 1
      `,
    ]);

    const findings =
      findingsRows.length > 0
        ? (findingsRows[0]!.findings as Record<string, unknown>)
        : null;

    // Derive pipeline date from the most recent plot analysis
    const latestDate = plotRows.length > 0 ? plotRows[0]!.pipeline_date : null;
    const pipelineDate = latestDate
      ? latestDate instanceof Date
        ? latestDate.toISOString().split('T')[0]!
        : String(latestDate)
      : null;

    const plots = plotRows.map((r) => ({
      name: r.plot_name,
      blobUrl: r.blob_url,
      analysis: r.analysis ?? null,
      model: r.model,
      pipelineDate:
        r.pipeline_date instanceof Date
          ? r.pipeline_date.toISOString().split('T')[0]!
          : String(r.pipeline_date),
      updatedAt:
        r.updated_at instanceof Date
          ? r.updated_at.toISOString()
          : String(r.updated_at),
    }));

    // Cache headers — data only changes once nightly
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=3600, stale-while-revalidate=86400',
    );

    done({ status: 200 });
    return res.status(200).json({
      plots,
      findings,
      pipelineDate,
    });
  } catch (err) {
    logger.error({ err }, 'ML plots query failed');
    Sentry.captureException(err);
    done({ status: 500 });
    return res.status(500).json({ error: 'Failed to fetch plot data' });
  }
}
