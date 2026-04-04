/**
 * POST /api/ml/analyze-plots
 *
 * Runs Claude Sonnet vision analysis on every ML pipeline plot stored
 * in Vercel Blob. Called from GitHub Actions after the nightly pipeline
 * uploads plots. Authenticated via CRON_SECRET Bearer token.
 *
 * Flow:
 *   1. List blobs under ml-plots/latest/
 *   2. Load findings from ml_findings table
 *   3. Process plots in batches of 3 (Promise.allSettled)
 *   4. For each plot: fetch → base64 → Claude vision → upsert DB
 *   5. Return { analyzed, failed, duration_ms }
 *
 * Environment: ANTHROPIC_API_KEY, CRON_SECRET, BLOB_READ_WRITE_TOKEN
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { list, get } from '@vercel/blob';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

export const config = { maxDuration: 780 };

// Module-level Anthropic singleton — reused across requests
const anthropic = new Anthropic({
  timeout: 120_000,
  maxRetries: 2,
});

const MODEL = 'claude-sonnet-4-6';

/**
 * Strip markdown code fences from Claude response if present.
 */
function stripFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return trimmed;
}

/**
 * Derive the plot name from a blob pathname.
 * e.g. "ml-plots/latest/correlations.png" → "correlations"
 */
function plotNameFromPath(pathname: string): string {
  const filename = pathname.split('/').at(-1) ?? pathname;
  return filename.replace(/\.png$/i, '');
}

/**
 * Build the system prompt for plot analysis.
 * This is a static prompt cached across all 21 calls per run.
 */
function buildSystemPrompt(): string {
  return [
    'You are an ML pipeline analyst for a 0DTE SPX options trading system.',
    'You analyze visualization output from a Python ML pipeline that',
    'processes 100+ daily features spanning volatility, GEX, flow, dark',
    'pool, options volume, and IV dynamics.',
    '',
    'For each plot, provide analysis in these 5 sections:',
    '',
    '1. VISUALIZATION: What type of plot, axes, encodings, layout.',
    '2. DATA INPUTS: Tables, features, preprocessing, sample size.',
    '3. INTERPRETATION: Patterns, significance, anomalies, regime shifts.',
    '4. IMPLICATIONS: Trading system impact — structure selection,',
    '   confidence calibration, feature engineering.',
    '5. CAVEATS: Sample size concerns, confounders, limitations.',
    '',
    'If you cannot read a label or determine an encoding, say so explicitly.',
    'Every sentence should add information — no filler.',
    '',
    'Respond with a JSON object:',
    '{',
    '  "visualization": "...",',
    '  "data_inputs": "...",',
    '  "interpretation": "...",',
    '  "implications": "...",',
    '  "caveats": "..."',
    '}',
    'Each field should be 2-4 paragraphs of substantive analysis.',
  ].join('\n');
}

/**
 * Extract the relevant findings slice for a given plot name.
 */
function getPlotFindings(
  plotName: string,
  findings: Record<string, unknown> | null,
): string {
  if (!findings) return 'No findings data available.';

  // Map plot names to findings sections
  const sectionMap: Record<string, string[]> = {
    correlations: ['eda', 'dataset'],
    timeline: ['eda', 'dataset'],
    stationarity: ['health', 'dataset'],
    flow_reliability: ['eda', 'dataset'],
    dark_pool_vs_range: ['eda', 'dataset'],
    range_by_regime: ['eda', 'dataset'],
    gex_vs_range: ['eda', 'dataset'],
    day_of_week: ['eda', 'dataset'],
    structure_confidence: ['eda', 'phase2', 'dataset'],
    confidence_over_time: ['eda', 'phase2', 'dataset'],
    backtest_equity: ['backtest', 'dataset'],
    failure_heatmap: ['phase2', 'dataset'],
    clusters_pca: ['clustering', 'dataset'],
    clusters_heatmap: ['clustering', 'dataset'],
    feature_importance_comparison: ['clustering', 'phase2', 'dataset'],
    pin_settlement: ['pin_analysis', 'dataset'],
    pin_time_decay: ['pin_analysis', 'dataset'],
    pin_composite: ['pin_analysis', 'dataset'],
    prev_day_transition: ['eda', 'dataset'],
    cone_consumption: ['eda', 'dataset'],
  };

  const sections = sectionMap[plotName] ?? ['dataset'];
  const slice: Record<string, unknown> = {};
  for (const key of sections) {
    if (key in findings) {
      slice[key] = findings[key];
    }
  }

  return Object.keys(slice).length > 0
    ? JSON.stringify(slice, null, 2)
    : 'No relevant findings section for this plot.';
}

/**
 * Analyze a single plot with Claude vision.
 */
async function analyzePlot(
  plotName: string,
  findings: Record<string, unknown> | null,
  systemPrompt: string,
): Promise<{
  analysis: Record<string, string>;
  usage: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
  };
}> {
  // Fetch the plot image from private Blob store
  const blobPath = `ml-plots/latest/${plotName}.png`;
  const result = await get(blobPath, { access: 'private' });
  if (!result) {
    throw new Error(`Blob not found: ${blobPath}`);
  }
  const ab = await new Response(result.stream).arrayBuffer();
  const base64String = Buffer.from(ab).toString('base64');

  const findingsSlice = getPlotFindings(plotName, findings);

  const content: Anthropic.MessageCreateParams['messages'][0]['content'] = [
    {
      type: 'text',
      text: `Analyze the plot: ${plotName}\n\n<underlying_data>\n${findingsSlice}\n</underlying_data>`,
    },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: base64String,
      },
    },
  ];

  const response = await anthropic.messages
    .stream({
      model: MODEL,
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: [
        {
          type: 'text' as const,
          text: systemPrompt,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user' as const, content }],
    } as unknown as Parameters<typeof anthropic.messages.stream>[0])
    .finalMessage();

  // Log usage
  const u = response.usage;
  const usage = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheWrite:
      (u as unknown as Record<string, number>).cache_creation_input_tokens ?? 0,
    cacheRead:
      (u as unknown as Record<string, number>).cache_read_input_tokens ?? 0,
  };

  logger.info(
    {
      plot: plotName,
      model: MODEL,
      ...usage,
    },
    'plot analysis usage',
  );

  // Extract text from response
  const text =
    response.content
      ?.filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('') ?? '';

  // Parse JSON response
  const jsonStr = stripFences(text);
  const analysis = JSON.parse(jsonStr) as Record<string, string>;

  return { analysis, usage };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/ml/analyze-plots');
  const startTime = Date.now();

  // ── Method check ────────────────────────────────────────
  if (req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST only' });
  }

  // ── Auth: Bearer token check against CRON_SECRET ────────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    done({ status: 401 });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    done({ status: 500, error: 'missing_api_key' });
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Stream NDJSON progress — keepalive pings prevent Vercel's edge
  // proxy from killing the idle connection during the 10+ min run.
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const keepalive = setInterval(() => {
    try {
      res.write(JSON.stringify({ ping: true }) + '\n');
    } catch {
      // Response already closed
    }
  }, 25_000);

  try {
    // ── 1. List all blobs under ml-plots/latest/ ──────────
    const { blobs } = await list({ prefix: 'ml-plots/latest/' });
    const pngBlobs = blobs.filter((b) => b.pathname.endsWith('.png'));

    if (pngBlobs.length === 0) {
      clearInterval(keepalive);
      done({ status: 200 });
      res.write(
        JSON.stringify({
          analyzed: 0,
          failed: [],
          duration_ms: Date.now() - startTime,
          message: 'No plots found under ml-plots/latest/',
        }) + '\n',
      );
      return res.end();
    }

    logger.info({ plotCount: pngBlobs.length }, 'Starting plot analysis');

    // ── 2. Load findings from DB ──────────────────────────
    const sql = getDb();
    const findingsRows = await sql`
      SELECT findings FROM ml_findings WHERE id = 1
    `;
    const findings =
      findingsRows.length > 0
        ? (findingsRows[0]!.findings as Record<string, unknown>)
        : null;

    // ── 3. Build system prompt (cached across all calls) ──
    const systemPrompt = buildSystemPrompt();

    // ── 4. First plot sequential (writes cache), rest concurrent (read cache) ──
    // Per Anthropic docs: "send 1 request, await the first streamed token,
    // then fire the remaining N-1. They'll read the cache the first one wrote."
    // We await the full first response (simpler) since the cache is definitely
    // written by then — remaining 20 fire concurrently and all hit cache reads.
    const pipelineDate = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    const failed: string[] = [];
    let analyzed = 0;

    const processPlot = async (blob: (typeof pngBlobs)[0]) => {
      const plotName = plotNameFromPath(blob.pathname);
      const { analysis } = await analyzePlot(
        plotName,
        findings,
        systemPrompt,
      );

      await sql`
        INSERT INTO ml_plot_analyses
          (plot_name, blob_url, analysis, pipeline_date, model, updated_at)
        VALUES
          (${plotName}, ${blob.url}, ${JSON.stringify(analysis)}, ${pipelineDate}::date, ${MODEL}, NOW())
        ON CONFLICT (plot_name) DO UPDATE SET
          blob_url = EXCLUDED.blob_url,
          analysis = EXCLUDED.analysis,
          pipeline_date = EXCLUDED.pipeline_date,
          model = EXCLUDED.model,
          updated_at = NOW()
      `;

      analyzed++;
      res.write(
        JSON.stringify({ plot: plotName, status: 'done', progress: `${analyzed}/${pngBlobs.length}` }) + '\n',
      );
      return plotName;
    };

    // First plot: sequential — writes the prompt cache
    const [firstBlob, ...remainingBlobs] = pngBlobs;
    try {
      await processPlot(firstBlob!);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push(reason);
      logger.error({ err }, 'First plot analysis failed');
      Sentry.captureException(err);
    }

    // Remaining plots: all concurrent — read from prompt cache
    if (remainingBlobs.length > 0) {
      const results = await Promise.allSettled(
        remainingBlobs.map((blob) => processPlot(blob)),
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          const reason =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          failed.push(reason);
          logger.error({ err: result.reason }, 'Plot analysis failed');
          Sentry.captureException(result.reason);
        }
      }
    }

    clearInterval(keepalive);
    const durationMs = Date.now() - startTime;
    logger.info(
      { analyzed, failed: failed.length, durationMs },
      'Plot analysis complete',
    );

    done({ status: 200 });
    res.write(
      JSON.stringify({ analyzed, failed, duration_ms: durationMs }) + '\n',
    );
    return res.end();
  } catch (err) {
    clearInterval(keepalive);
    logger.error({ err }, 'Plot analysis endpoint error');
    Sentry.captureException(err);
    done({ status: 500 });
    res.write(
      JSON.stringify({
        error: 'Plot analysis failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      }) + '\n',
    );
    return res.end();
  }
}
