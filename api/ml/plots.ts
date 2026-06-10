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
 *     plots: Array<{ name, imageUrl, analysis, model, pipelineDate, updatedAt }>,
 *     findings: Record<string, unknown> | null,
 *     pipelineDate: string | null
 *   }
 *
 * Cache: public, s-maxage=3600, stale-while-revalidate=86400
 *        (data only changes once nightly)
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { DB_RETRY_ATTEMPTS, DB_RETRY_TIMEOUT_MS } from '../_lib/constants.js';
import { withDbReader } from '../_lib/request-scope.js';

interface PlotAnalysis {
  what_it_means: string;
  how_to_apply: string;
  watch_out_for: string;
}

interface PlotRow {
  plot_name: string;
  blob_url: string;
  analysis: PlotAnalysis | null;
  model: string;
  pipeline_date: Date | string;
  updated_at: Date | string;
}

export default withDbReader(
  '/api/ml/plots',
  'ml_plots',
  'public',
  async (_req, res, done) => {
    const sql = getDb();

    // Fetch plot analyses and findings in parallel. Each query gets its
    // OWN withDbRetry so a transient failure of one retries only that
    // query — wrapping the whole Promise.all would retry both reads when
    // either blips.
    const [plotRows, findingsRows] = await Promise.all([
      withDbRetry(
        () => sql`
          SELECT plot_name, blob_url, analysis, model,
                 pipeline_date, updated_at
          FROM ml_plot_analyses
          ORDER BY plot_name
        `,
        DB_RETRY_ATTEMPTS,
        DB_RETRY_TIMEOUT_MS,
      ) as unknown as Promise<PlotRow[]>,
      withDbRetry(
        () => sql`
          SELECT findings FROM ml_findings WHERE id = 1
        `,
        DB_RETRY_ATTEMPTS,
        DB_RETRY_TIMEOUT_MS,
      ),
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
      imageUrl: `/api/ml/plot-image?name=${encodeURIComponent(r.plot_name)}`,
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
  },
  { serverErrorBody: { error: 'Failed to fetch plot data' } },
);
