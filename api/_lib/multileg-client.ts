/**
 * Thin client for the multileg classifier service. Calls
 * POST /multileg-classify on the standalone `classifier/` Railway
 * service.
 *
 * The matcher itself lives in `ml/src/multileg_assembler.py` and is
 * wrapped by `classifier/src/multileg_routes.py`. This module is the
 * Vercel-side wrapper that the detect crons (lottery / silent-boom)
 * use to label each Full Tape print with its inferred multileg
 * structure (vertical / strangle / risk_reversal / butterfly /
 * isolated_leg).
 *
 * Policy:
 *   - Empty input → empty Map (no fetch round-trip).
 *   - The classifier response array MUST match the input array in
 *     length and order; we validate both at the boundary so a
 *     drifted contract fails loudly here, not silently downstream
 *     in scoring code.
 *   - Failures throw a typed `MultilegClassifyError` so callers
 *     can choose fail-loud (default everything to isolated_leg)
 *     vs. fail-open (skip the structure flag).
 *   - Sentry captures the error category as a message so the
 *     first 5xx pages immediately rather than waiting for the
 *     metric counter to climb. The `multileg.classify.sidecar_*`
 *     event names predate the classifier service split; they are kept
 *     so existing Sentry issues and alert rules keep matching, but
 *     they describe the classifier service.
 *
 * Env:
 *   CLASSIFIER_URL — required. Base URL of the standalone Railway
 *                    classifier service. There is no fallback: the
 *                    sidecar's /takeit/multileg-classify route was
 *                    removed on 2026-10-02.
 *   CLASSIFIER_SHARED_SECRET — required. Sent as
 *                    `Authorization: Bearer <secret>` on the classify
 *                    POST and the /version probe; the classifier
 *                    requires it on both. Never logged.
 *
 *   When either is unset (or whitespace-only), every call throws
 *   `MultilegClassifyError` with kind 'config_missing' (and emits the
 *   throttled `multileg.classify.config_missing` Sentry event naming the
 *   variable) without making a request.
 */

import { z } from 'zod';

import logger from './logger.js';
import { Sentry } from './sentry.js';

// ── Public input / output types ────────────────────────────────────────────

export interface MultilegTradeInput {
  id: string;
  underlyingSymbol: string;
  /** ISO8601 timestamp; microsecond precision preserved, UTC. */
  executedAt: string;
  optionChainId: string;
  strike: number;
  /** ISO date 'YYYY-MM-DD'. */
  expiry: string;
  optionType: 'call' | 'put';
  /** Contracts (integer). */
  size: number;
  price: number;
  nbboBid: number;
  nbboAsk: number;
  premium: number;
  /** Optional — matcher tolerates absence. */
  delta?: number | null;
}

export type MultilegStructure =
  | 'vertical'
  | 'strangle'
  | 'risk_reversal'
  | 'butterfly'
  | 'isolated_leg';

/**
 * One classification row. The structure fields are nullable because
 * the matcher's overload-skip path (and other graceful-skip branches
 * on the classifier service) returns `null` for inferred_structure /
 * is_isolated_leg / match_confidence / pattern_group_id when it can't
 * commit to a confident answer. The `id` is always present — every
 * input row gets a row back, in input order.
 */
export interface MultilegClassification {
  id: string;
  inferredStructure: MultilegStructure | null;
  isIsolatedLeg: boolean | null;
  /** [0, 1] confidence score from the matcher, or null when skipped. */
  matchConfidence: number | null;
  patternGroupId: string | null;
}

export interface MultilegClassifyOptions {
  /** Default 90 (matcher default). */
  windowSeconds?: number;
  /** Default 0.05 (matcher default). */
  strikeTolerance?: number;
  /** Default 0.1 (matcher default). */
  sizeTolerance?: number;
}

// ── Typed error ────────────────────────────────────────────────────────────

export type MultilegClassifyErrorKind =
  | 'config_missing'
  | 'http_4xx'
  | 'http_5xx'
  | 'http_503'
  | 'network'
  | 'schema_mismatch'
  | 'schema_drift'
  | 'length_mismatch';

/** Thrown for every failure mode of `classifyMultilegBatch`. */
export class MultilegClassifyError extends Error {
  readonly kind: MultilegClassifyErrorKind;
  readonly status: number | undefined;

  constructor(
    kind: MultilegClassifyErrorKind,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'MultilegClassifyError';
    this.kind = kind;
    this.status = options.status;
  }
}

// ── Response Zod schema ────────────────────────────────────────────────────

const MULTILEG_STRUCTURES: readonly MultilegStructure[] = [
  'vertical',
  'strangle',
  'risk_reversal',
  'butterfly',
  'isolated_leg',
] as const;

const classificationRowSchema = z.object({
  id: z.string().min(1),
  inferred_structure: z
    .enum(MULTILEG_STRUCTURES as unknown as [string, ...string[]])
    .nullable(),
  is_isolated_leg: z.boolean().nullable(),
  match_confidence: z.number().min(0).max(1).nullable(),
  pattern_group_id: z.string().min(1).nullable(),
});

const responseSchema = z.object({
  classifications: z.array(classificationRowSchema),
});

/** Shape of GET /version on the classifier service (Task 1 Fix 7). */
const versionResponseSchema = z.object({
  matcher_sha: z.string().optional(),
  release: z.string().optional(),
  patterns: z.array(z.string()),
});

// ── Internals ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 3_000;
const SENTRY_THROTTLE_MS = 60_000;

/** Classify path on the classifier service. */
const CLASSIFIER_PATH = '/multileg-classify';
/** Cold-start version probe path on the classifier service. */
const VERSION_PATH = '/version';

/** Whether the cold-start /version probe has run in this process. */
let versionChecked = false;

/**
 * Per-process throttle for `Sentry.captureMessage('multileg.classify.*')`
 * (Fix 5 / Finding 2.5). Tracks last-emit-ms per message name; we suppress
 * subsequent captures within `SENTRY_THROTTLE_MS` to prevent quota burn
 * during sustained outages (detect-crons run every minute, so without
 * throttling a sustained 5xx storm can fan out into thousands of events
 * per hour). Local logger.warn / logger.info calls are NOT throttled —
 * those still flow to Vercel logs for debugging.
 */
const classifySentryLastEmit = new Map<string, number>();

function shouldEmitSentry(name: string): boolean {
  const now = Date.now();
  const last = classifySentryLastEmit.get(name) ?? 0;
  if (now - last < SENTRY_THROTTLE_MS) return false;
  classifySentryLastEmit.set(name, now);
  return true;
}

interface ResolvedClassifierTarget {
  /** Fully qualified URL the request will be POSTed to. */
  url: string;
  /** Base URL (no trailing slash) for ancillary probes like /version. */
  base: string;
  /** `Bearer <CLASSIFIER_SHARED_SECRET>`. Never log it. */
  authorization: string;
}

/**
 * Surface a missing classifier env var by name: a warn log on every call
 * plus a throttled `multileg.classify.config_missing` Sentry event, then
 * a typed `config_missing` throw that the detect crons fail open on.
 */
function failConfigMissing(
  envVar: 'CLASSIFIER_URL' | 'CLASSIFIER_SHARED_SECRET',
): never {
  logger.warn({}, `multileg-classify ${envVar} unset; skipping classification`);
  if (shouldEmitSentry('multileg.classify.config_missing')) {
    Sentry.captureMessage('multileg.classify.config_missing', {
      level: 'error',
      extra: { envVar },
    });
  }
  throw new MultilegClassifyError(
    'config_missing',
    `${envVar} is not configured`,
  );
}

/**
 * Resolve the classifier target from CLASSIFIER_URL and
 * CLASSIFIER_SHARED_SECRET.
 *
 * Either one missing is a deploy misconfiguration that silently blanks
 * the multileg columns on every lottery / silent-boom fire, so it fails
 * via `failConfigMissing` before any request is made. It never falls
 * back to SIDECAR_URL — that service no longer serves the route.
 */
function resolveClassifierTarget(): ResolvedClassifierTarget {
  const classifierRaw = process.env.CLASSIFIER_URL?.trim();
  if (!classifierRaw) failConfigMissing('CLASSIFIER_URL');
  const secret = process.env.CLASSIFIER_SHARED_SECRET?.trim();
  if (!secret) failConfigMissing('CLASSIFIER_SHARED_SECRET');
  const base = classifierRaw.replace(/\/$/, '');
  return {
    url: `${base}${CLASSIFIER_PATH}`,
    base,
    authorization: `Bearer ${secret}`,
  };
}

interface ClassifierRequestTrade {
  id: string;
  underlying_symbol: string;
  executed_at: string;
  option_chain_id: string;
  strike: number;
  expiry: string;
  option_type: 'call' | 'put';
  size: number;
  price: number;
  nbbo_bid: number;
  nbbo_ask: number;
  premium: number;
  delta?: number | null;
}

interface ClassifierRequestBody {
  trades: ClassifierRequestTrade[];
  window_seconds?: number;
  strike_tolerance?: number;
  size_tolerance?: number;
}

function tradeToWire(t: MultilegTradeInput): ClassifierRequestTrade {
  const row: ClassifierRequestTrade = {
    id: t.id,
    underlying_symbol: t.underlyingSymbol,
    executed_at: t.executedAt,
    option_chain_id: t.optionChainId,
    strike: t.strike,
    expiry: t.expiry,
    option_type: t.optionType,
    size: t.size,
    price: t.price,
    nbbo_bid: t.nbboBid,
    nbbo_ask: t.nbboAsk,
    premium: t.premium,
  };
  if (t.delta !== undefined) {
    row.delta = t.delta;
  }
  return row;
}

function buildRequestBody(
  trades: readonly MultilegTradeInput[],
  options: MultilegClassifyOptions,
): ClassifierRequestBody {
  const body: ClassifierRequestBody = {
    trades: trades.map(tradeToWire),
  };
  if (options.windowSeconds !== undefined) {
    body.window_seconds = options.windowSeconds;
  }
  if (options.strikeTolerance !== undefined) {
    body.strike_tolerance = options.strikeTolerance;
  }
  if (options.sizeTolerance !== undefined) {
    body.size_tolerance = options.sizeTolerance;
  }
  return body;
}

/**
 * Cold-start `/version` probe (Fix 6 / Finding 2.2). Runs at most once
 * per process. Compares the classifier's pattern list against the TS-side
 * `MULTILEG_STRUCTURES`; any client-known pattern missing from the server
 * advertised list is a wire-contract drift signal (Vercel commit A vs
 * Railway commit B).
 *
 * Failure modes are intentionally non-fatal: a missing /version endpoint
 * (older classifier deploy) logs a warn but does NOT throw, so the main
 * classify request still flows. Only `pattern_set_drift` is an error-level
 * Sentry event — that's the actionable diagnostic.
 */
async function probeVersionOnce({
  base,
  authorization,
}: ResolvedClassifierTarget): Promise<void> {
  if (versionChecked) return;
  versionChecked = true;

  const url = `${base}${VERSION_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERSION_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authorization },
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { url, err: message },
      'multileg-classify /version probe failed (non-fatal)',
    );
    return;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    logger.warn(
      { url, status: res.status },
      'multileg-classify /version returned non-2xx (non-fatal)',
    );
    return;
  }

  let rawJson: unknown;
  try {
    rawJson = await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { url, err: message },
      'multileg-classify /version returned invalid JSON (non-fatal)',
    );
    return;
  }

  const parsed = versionResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    logger.warn(
      { url, issues: parsed.error.issues },
      'multileg-classify /version body failed schema (non-fatal)',
    );
    return;
  }

  const serverPatterns = parsed.data.patterns;
  const missingOnServer = MULTILEG_STRUCTURES.filter(
    (p) => !serverPatterns.includes(p),
  );
  if (missingOnServer.length > 0) {
    if (shouldEmitSentry('multileg.classify.pattern_set_drift')) {
      Sentry.captureMessage('multileg.classify.pattern_set_drift', {
        level: 'error',
        extra: {
          server_patterns: serverPatterns,
          client_patterns: [...MULTILEG_STRUCTURES],
          missing_on_server: missingOnServer,
        },
      });
    }
    logger.warn(
      {
        serverPatterns,
        clientPatterns: MULTILEG_STRUCTURES,
        missingOnServer,
      },
      'multileg-classify /version pattern set drift detected',
    );
  } else {
    logger.info(
      { matcherSha: parsed.data.matcher_sha, release: parsed.data.release },
      'multileg-classify /version probe ok',
    );
  }
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Classify a batch of trades for multileg-structure membership. Calls
 * POST /multileg-classify on the classifier service and returns one
 * classification per input trade.
 *
 * Returns a Map keyed by trade id for O(1) lookups in caller code.
 *
 * @throws {MultilegClassifyError} On any failure (config missing, HTTP
 *   error, network error, response schema mismatch, length mismatch).
 *   Callers can switch on `err.kind` to choose fail-loud vs. fail-open
 *   behavior — e.g. detect-cron may treat config_missing + network as
 *   "skip the structure flag this tick" while still surfacing 4xx (bad
 *   payload bug).
 */
export async function classifyMultilegBatch(
  trades: readonly MultilegTradeInput[],
  options: MultilegClassifyOptions = {},
): Promise<Map<string, MultilegClassification>> {
  if (trades.length === 0) {
    return new Map();
  }

  const target = resolveClassifierTarget();
  const { url, authorization } = target;

  // Cold-start /version probe (once per process). Failure is non-fatal
  // — we don't want a slow or missing /version to block real classifies.
  await probeVersionOnce(target);

  const body = buildRequestBody(trades, options);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, count: trades.length, durationMs },
      'multileg-classify classifier fetch failed',
    );
    if (shouldEmitSentry('multileg.classify.sidecar_unreachable')) {
      Sentry.captureMessage('multileg.classify.sidecar_unreachable', {
        level: 'warning',
        extra: {
          error: message,
          count: trades.length,
          durationMs,
        },
      });
    }
    throw new MultilegClassifyError('network', `network error: ${message}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const durationMs = Date.now() - startedAt;
    const status = res.status;
    const isServer = status >= 500;
    const isQueueSaturation = status === 503;
    const isSchemaDrift = status === 422;
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      // ignore — body read failure is non-essential
    }

    // ── Queue saturation (Task 4 Fix 1 — BoundedSemaphore). Different
    //    operational signal than "the service broke" — operators need
    //    to see "we hit the cap" distinctly, so it gets its own event
    //    name and is NOT funneled through sidecar_non_2xx.
    if (isQueueSaturation) {
      // Prefer the response body's retry_after_sec (matches the
      // classifier's structured 503 contract) and fall back to the
      // Retry-After header if the body isn't parseable.
      let retryAfterSec: number | string | null = null;
      try {
        const parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
        const fromBody = parsedBody.retry_after_sec;
        if (typeof fromBody === 'number' || typeof fromBody === 'string') {
          retryAfterSec = fromBody;
        }
      } catch {
        // ignore — body may be empty or non-JSON
      }
      if (retryAfterSec === null) {
        retryAfterSec = res.headers.get('Retry-After');
      }
      logger.warn(
        {
          status,
          body: bodyText,
          count: trades.length,
          durationMs,
          retryAfterSec,
        },
        'multileg-classify classifier queue saturated (503)',
      );
      if (shouldEmitSentry('multileg.classify.queue_saturation')) {
        Sentry.captureMessage('multileg.classify.queue_saturation', {
          level: 'warning',
          extra: {
            status,
            durationMs,
            count: trades.length,
            retryAfterSec,
          },
        });
      }
      throw new MultilegClassifyError(
        'http_503',
        `classifier queue saturated`,
        { status },
      );
    }

    // ── 422 = wire-contract drift (Pydantic schema rejection). Distinct
    //    from a generic 400 because it almost always means TS and server
    //    are on mismatched commits — the alert is much more actionable
    //    when it's tagged contract_drift instead of being lumped in with
    //    every random 4xx.
    if (isSchemaDrift) {
      let details: unknown = null;
      try {
        const parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
        details = parsedBody.details ?? null;
      } catch {
        // ignore — body may be empty or non-JSON
      }
      logger.warn(
        {
          status,
          body: bodyText,
          count: trades.length,
          durationMs,
          details,
        },
        'multileg-classify contract drift (422)',
      );
      if (shouldEmitSentry('multileg.classify.contract_drift')) {
        Sentry.captureMessage('multileg.classify.contract_drift', {
          level: 'error',
          extra: {
            status,
            body: bodyText,
            details,
            durationMs,
            count: trades.length,
          },
        });
      }
      throw new MultilegClassifyError(
        'schema_drift',
        `classifier returned 422 (contract drift): ${bodyText.slice(0, 200)}`,
        { status },
      );
    }

    const kind: MultilegClassifyErrorKind = isServer ? 'http_5xx' : 'http_4xx';
    logger.warn(
      {
        status,
        body: bodyText,
        count: trades.length,
        durationMs,
      },
      'multileg-classify classifier non-2xx',
    );
    if (shouldEmitSentry('multileg.classify.sidecar_non_2xx')) {
      Sentry.captureMessage('multileg.classify.sidecar_non_2xx', {
        level: isServer ? 'warning' : 'error',
        extra: {
          status,
          body: bodyText,
          count: trades.length,
          durationMs,
        },
      });
    }
    throw new MultilegClassifyError(kind, `classifier returned ${status}`, {
      status,
    });
  }

  let rawJson: unknown;
  try {
    rawJson = await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (shouldEmitSentry('multileg.classify.invalid_json')) {
      Sentry.captureMessage('multileg.classify.invalid_json', {
        level: 'error',
        extra: {
          error: message,
          durationMs: Date.now() - startedAt,
        },
      });
    }
    throw new MultilegClassifyError(
      'schema_mismatch',
      `classifier returned invalid JSON: ${message}`,
      { cause: err },
    );
  }

  const parsed = responseSchema.safeParse(rawJson);
  if (!parsed.success) {
    if (shouldEmitSentry('multileg.classify.schema_mismatch')) {
      Sentry.captureMessage('multileg.classify.schema_mismatch', {
        level: 'error',
        extra: {
          issues: parsed.error.issues,
          durationMs: Date.now() - startedAt,
        },
      });
    }
    throw new MultilegClassifyError(
      'schema_mismatch',
      `classifier response failed schema validation: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }

  const { classifications } = parsed.data;
  if (classifications.length !== trades.length) {
    if (shouldEmitSentry('multileg.classify.length_mismatch')) {
      Sentry.captureMessage('multileg.classify.length_mismatch', {
        level: 'error',
        extra: {
          inputLength: trades.length,
          responseLength: classifications.length,
          durationMs: Date.now() - startedAt,
        },
      });
    }
    throw new MultilegClassifyError(
      'length_mismatch',
      `expected ${trades.length} classifications, got ${classifications.length}`,
    );
  }

  const out = new Map<string, MultilegClassification>();
  for (const row of classifications) {
    out.set(row.id, {
      id: row.id,
      inferredStructure:
        row.inferred_structure === null
          ? null
          : (row.inferred_structure as MultilegStructure),
      isIsolatedLeg: row.is_isolated_leg,
      matchConfidence: row.match_confidence,
      patternGroupId: row.pattern_group_id,
    });
  }
  logger.info(
    {
      count: trades.length,
      durationMs: Date.now() - startedAt,
    },
    'multileg-classify classifier ok',
  );
  return out;
}
