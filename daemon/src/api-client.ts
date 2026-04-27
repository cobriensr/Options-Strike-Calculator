/**
 * POST a TRACE Live capture batch to /api/trace-live-analyze.
 *
 * Owner-cookie authenticated. Retries on transient failures (network
 * errors, 5xx) with exponential backoff; does NOT retry on 4xx (client
 * error means the payload is wrong, not the network — re-running won't
 * fix it). 429 (rate limited) gets a single retry after a 30s wait.
 *
 * The endpoint can take 60s–9min server-side (Sonnet 4.6 + adaptive
 * thinking + effort:'high' on a 3-image structured-output call). The
 * fetch timeout matches the Vercel function ceiling (780s / 13min) so
 * we wait for the function to either complete or get killed by Vercel
 * — there's no value in the daemon disconnecting earlier; that just
 * orphans completed work (the function keeps running server-side and
 * persists the row, but the daemon never sees the response).
 */

import type { Logger } from 'pino';
import type { DaemonGexLandscape } from './gex.js';

const POST_TIMEOUT_MS = 780_000;
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 2_000;

export interface PostTraceLiveAnalyzeArgs {
  endpoint: string;
  ownerSecret: string;
  logger: Logger;
  capturedAt: string;
  spot: number;
  stabilityPct: number | null;
  etTimeLabel?: string;
  images: {
    gamma: string;
    charm: string;
    delta: string;
  };
  gex: DaemonGexLandscape;
}

interface PostResult {
  status: number;
  body: unknown;
}

function buildBody(args: PostTraceLiveAnalyzeArgs): unknown {
  const { capturedAt, spot, stabilityPct, etTimeLabel, images, gex } = args;
  return {
    capturedAt,
    spot,
    stabilityPct,
    etTimeLabel,
    images: [
      {
        chart: 'gamma',
        slot: 'now',
        capturedAt,
        mediaType: 'image/png',
        data: images.gamma,
      },
      {
        chart: 'charm',
        slot: 'now',
        capturedAt,
        mediaType: 'image/png',
        data: images.charm,
      },
      {
        chart: 'delta',
        slot: 'now',
        capturedAt,
        mediaType: 'image/png',
        data: images.delta,
      },
    ],
    gex: {
      regime: gex.regime,
      netGex: gex.netGex,
      totalPosGex: gex.totalPosGex,
      totalNegGex: gex.totalNegGex,
      atmStrike: gex.atmStrike,
      driftTargetsUp: gex.driftTargetsUp,
      driftTargetsDown: gex.driftTargetsDown,
      strikes: gex.strikes,
    },
  };
}

async function postOnce(
  url: string,
  cookie: string,
  body: unknown,
): Promise<PostResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    // Vercel BotID's edge enforcement (deepCheck mode) blocks all
    // automated traffic to ALL routes — even paths absent from the
    // initBotId({ protect }) array. Per Vercel's docs, the proper
    // mechanism is a Vercel Firewall (WAF) bypass rule that matches
    // a specific header value. The daemon sends the header here; the
    // WAF rule (configured in the Vercel dashboard) lets matching
    // traffic through. Without this token, requests get the
    // "Vercel Security Checkpoint" 429 in ~300ms at the edge.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Cookie: `sc-owner=${cookie}`,
    };
    const bypass = process.env.TRACE_LIVE_BYPASS_TOKEN;
    if (bypass) {
      headers['x-trace-live-bypass'] = bypass;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      /* response not JSON — leave parsed=null */
    }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function shouldRetry(status: number): boolean {
  // 429 once (rate limited), 5xx always (transient server error).
  // 4xx other than 429 = payload bug, no retry.
  return status === 429 || (status >= 500 && status < 600);
}

async function sleep(ms: number): Promise<void> {
  return await new Promise((r) => setTimeout(r, ms));
}

/**
 * Send the capture batch. Returns the parsed response body on success
 * (status 200), throws otherwise. Retries on 429 / 5xx / network errors
 * with exponential backoff (capped at MAX_RETRIES).
 */
export async function postTraceLiveAnalyze(
  args: PostTraceLiveAnalyzeArgs,
): Promise<unknown> {
  const { endpoint, ownerSecret, logger } = args;
  const body = buildBody(args);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const startedAt = Date.now();
      const result = await postOnce(endpoint, ownerSecret, body);
      const durationMs = Date.now() - startedAt;
      // Log response body on non-200 so we can SEE what's wrong.
      // 200 path doesn't need it (just the analysis JSON).
      const bodySnippet =
        result.status === 200
          ? undefined
          : typeof result.body === 'string'
            ? result.body.slice(0, 600)
            : JSON.stringify(result.body).slice(0, 600);
      logger.info(
        {
          attempt,
          status: result.status,
          durationMs,
          ...(bodySnippet ? { body: bodySnippet } : {}),
        },
        'POST /api/trace-live-analyze response',
      );

      if (result.status === 200) return result.body;

      if (!shouldRetry(result.status)) {
        // Non-retryable — bail with the body so the caller can log details.
        const summary =
          typeof result.body === 'object' && result.body
            ? JSON.stringify(result.body).slice(0, 500)
            : String(result.body);
        throw new Error(
          `POST returned ${result.status} (non-retryable): ${summary}`,
        );
      }
      lastErr = new Error(`POST returned ${result.status}`);
    } catch (err) {
      lastErr = err;
      logger.warn(
        { attempt, err: err instanceof Error ? err.message : String(err) },
        'POST /api/trace-live-analyze failed',
      );
    }

    if (attempt < MAX_RETRIES) {
      const backoff =
        lastErr instanceof Error && lastErr.message.includes('429')
          ? 30_000
          : BASE_BACKOFF_MS * Math.pow(2, attempt);
      await sleep(backoff);
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error('POST /api/trace-live-analyze failed after retries');
}
