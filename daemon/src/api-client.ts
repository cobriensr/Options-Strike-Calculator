/**
 * POST a TRACE Live capture batch to /api/trace-live-analyze.
 *
 * Owner-cookie authenticated. Retries on transient failures (network
 * errors, 5xx) with exponential backoff; does NOT retry on 4xx (client
 * error means the payload is wrong, not the network — re-running won't
 * fix it). 429 (rate limited) gets a single retry after a 30s wait.
 *
 * The endpoint can take 30–90s server-side (Sonnet 4.6 + adaptive
 * thinking + structured output validation). We use a 120s fetch timeout
 * to give it headroom — the daemon's own scheduler-level timeout
 * (in capture.ts) governs the overall tick budget.
 */

import type { Logger } from 'pino';
import type { DaemonGexLandscape } from './gex.js';

const POST_TIMEOUT_MS = 120_000;
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
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `sc-owner=${cookie}`,
      },
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
      logger.info(
        { attempt, status: result.status, durationMs },
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
