/**
 * Thin client for the multileg classifier service. Calls
 * POST /multileg-classify on the new standalone classifier service or
 * POST /takeit/multileg-classify on the legacy multi-purpose sidecar
 * (fallback for one deploy cycle during the Phase 1 service split).
 *
 * The matcher itself lives in `ml/src/multileg_assembler.py` and is
 * wrapped by `classifier/src/classifier_routes.py` (new) /
 * `sidecar/src/multileg_routes.py` (legacy). This module is the
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
 *     metric counter to climb.
 *
 * Env (rollout: Phase 1 task 5 of the classifier service split):
 *   CLASSIFIER_URL — preferred. Points at the new standalone
 *                    Railway classifier service. Path: /multileg-classify.
 *   SIDECAR_URL    — fallback for one deploy cycle. Same env var as
 *                    `archive-sidecar.ts`. Path: /takeit/multileg-classify.
 *                    Removed in a follow-up commit after the
 *                    one-trading-day soak completes.
 *   If both are unset, the client throws `MultilegClassifyError`
 *   with kind 'config_missing' on call.
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

export interface MultilegClassification {
  id: string;
  inferredStructure: MultilegStructure;
  isIsolatedLeg: boolean;
  /** [0, 1] confidence score from the matcher. */
  matchConfidence: number;
  patternGroupId: string;
}

export interface MultilegClassifyOptions {
  /** Default 90 (sidecar default). */
  windowSeconds?: number;
  /** Default 0.05 (sidecar default). */
  strikeTolerance?: number;
  /** Default 0.1 (sidecar default). */
  sizeTolerance?: number;
}

// ── Typed error ────────────────────────────────────────────────────────────

export type MultilegClassifyErrorKind =
  | 'config_missing'
  | 'http_4xx'
  | 'http_5xx'
  | 'network'
  | 'schema_mismatch'
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
  inferred_structure: z.enum(
    MULTILEG_STRUCTURES as unknown as [string, ...string[]],
  ),
  is_isolated_leg: z.boolean(),
  match_confidence: z.number().min(0).max(1),
  pattern_group_id: z.string().min(1),
});

const responseSchema = z.object({
  classifications: z.array(classificationRowSchema),
});

// ── Internals ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;

/** Path on the new standalone classifier service. */
const CLASSIFIER_PATH = '/multileg-classify';
/** Path on the legacy multi-purpose sidecar (one-deploy-cycle fallback). */
const SIDECAR_FALLBACK_PATH = '/takeit/multileg-classify';

/**
 * Tracks whether the fallback-in-effect warning has been logged in
 * the current process. Module-level so a single warm Vercel Function
 * instance logs once per cold start, not once per call.
 */
let sidecarFallbackWarned = false;

interface ResolvedClassifierTarget {
  /** Fully qualified URL the request will be POSTed to. */
  url: string;
  /** Which env var supplied the base, for observability / tests. */
  source: 'classifier' | 'sidecar-fallback';
}

/**
 * Resolve the classifier target. Prefers CLASSIFIER_URL; falls back
 * to SIDECAR_URL for one deploy cycle. Returns both the URL and the
 * source so callers (and tests) can verify which path was hit.
 *
 * Design note: path selection lives here next to env resolution so a
 * single function owns "where does the classifier live" — keeping
 * `classifyMultilegBatch` focused on request/response handling and
 * avoiding a second source-of-truth for the path mapping.
 */
function resolveClassifierBase(): ResolvedClassifierTarget {
  const classifierRaw = process.env.CLASSIFIER_URL?.trim();
  if (classifierRaw) {
    const base = classifierRaw.replace(/\/$/, '');
    return { url: `${base}${CLASSIFIER_PATH}`, source: 'classifier' };
  }
  const sidecarRaw = process.env.SIDECAR_URL?.trim();
  if (sidecarRaw) {
    if (!sidecarFallbackWarned) {
      sidecarFallbackWarned = true;
      logger.warn(
        {},
        'multileg-classify CLASSIFIER_URL unset; falling back to SIDECAR_URL',
      );
    }
    const base = sidecarRaw.replace(/\/$/, '');
    return {
      url: `${base}${SIDECAR_FALLBACK_PATH}`,
      source: 'sidecar-fallback',
    };
  }
  throw new MultilegClassifyError(
    'config_missing',
    'Neither CLASSIFIER_URL nor SIDECAR_URL is configured',
  );
}

interface SidecarRequestTrade {
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

interface SidecarRequestBody {
  trades: SidecarRequestTrade[];
  window_seconds?: number;
  strike_tolerance?: number;
  size_tolerance?: number;
}

function tradeToWire(t: MultilegTradeInput): SidecarRequestTrade {
  const row: SidecarRequestTrade = {
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
): SidecarRequestBody {
  const body: SidecarRequestBody = {
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

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Classify a batch of trades for multileg-structure membership. Calls
 * the classifier service (POST /multileg-classify on the standalone
 * classifier, or POST /takeit/multileg-classify on the legacy sidecar
 * during the fallback window) and returns one classification per
 * input trade.
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

  const { url } = resolveClassifierBase();
  const body = buildRequestBody(trades, options);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, count: trades.length, durationMs },
      'multileg-classify sidecar fetch failed',
    );
    Sentry.captureMessage('multileg.classify.sidecar_unreachable', {
      level: 'warning',
      extra: { error: message, count: trades.length, durationMs },
    });
    throw new MultilegClassifyError('network', `network error: ${message}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const durationMs = Date.now() - startedAt;
    const isServer = res.status >= 500;
    const kind: MultilegClassifyErrorKind = isServer ? 'http_5xx' : 'http_4xx';
    const sidecarStatus = res.status;
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      // ignore — body read failure is non-essential
    }
    logger.warn(
      {
        status: sidecarStatus,
        body: bodyText,
        count: trades.length,
        durationMs,
      },
      'multileg-classify sidecar non-2xx',
    );
    Sentry.captureMessage('multileg.classify.sidecar_non_2xx', {
      level: isServer ? 'warning' : 'error',
      extra: {
        status: sidecarStatus,
        body: bodyText,
        count: trades.length,
        durationMs,
      },
    });
    throw new MultilegClassifyError(kind, `sidecar returned ${sidecarStatus}`, {
      status: sidecarStatus,
    });
  }

  let rawJson: unknown;
  try {
    rawJson = await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Sentry.captureMessage('multileg.classify.invalid_json', {
      level: 'error',
      extra: { error: message, durationMs: Date.now() - startedAt },
    });
    throw new MultilegClassifyError(
      'schema_mismatch',
      `sidecar returned invalid JSON: ${message}`,
      { cause: err },
    );
  }

  const parsed = responseSchema.safeParse(rawJson);
  if (!parsed.success) {
    Sentry.captureMessage('multileg.classify.schema_mismatch', {
      level: 'error',
      extra: {
        issues: parsed.error.issues,
        durationMs: Date.now() - startedAt,
      },
    });
    throw new MultilegClassifyError(
      'schema_mismatch',
      `sidecar response failed schema validation: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }

  const { classifications } = parsed.data;
  if (classifications.length !== trades.length) {
    Sentry.captureMessage('multileg.classify.length_mismatch', {
      level: 'error',
      extra: {
        inputLength: trades.length,
        responseLength: classifications.length,
        durationMs: Date.now() - startedAt,
      },
    });
    throw new MultilegClassifyError(
      'length_mismatch',
      `expected ${trades.length} classifications, got ${classifications.length}`,
    );
  }

  const out = new Map<string, MultilegClassification>();
  for (const row of classifications) {
    out.set(row.id, {
      id: row.id,
      inferredStructure: row.inferred_structure as MultilegStructure,
      isIsolatedLeg: row.is_isolated_leg,
      matchConfidence: row.match_confidence,
      patternGroupId: row.pattern_group_id,
    });
  }
  logger.info(
    { count: trades.length, durationMs: Date.now() - startedAt },
    'multileg-classify sidecar ok',
  );
  return out;
}
