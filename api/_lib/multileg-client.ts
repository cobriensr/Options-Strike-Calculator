/**
 * Thin client for the Railway sidecar's POST /takeit/multileg-classify
 * endpoint.
 *
 * The matcher itself lives in `ml/src/multileg_assembler.py` and is
 * wrapped by `sidecar/src/multileg_routes.py`. This module is the
 * Vercel-side wrapper that the detect crons (lottery / silent-boom)
 * use to label each Full Tape print with its inferred multileg
 * structure (vertical / strangle / risk_reversal / butterfly /
 * isolated_leg).
 *
 * Policy:
 *   - Empty input → empty Map (no fetch round-trip).
 *   - The sidecar response array MUST match the input array in
 *     length and order; we validate both at the boundary so a
 *     drifted sidecar contract fails loudly here, not silently
 *     downstream in scoring code.
 *   - Failures throw a typed `MultilegClassifyError` so callers
 *     can choose fail-loud (default everything to isolated_leg)
 *     vs. fail-open (skip the structure flag).
 *   - Sentry captures the error category as a message so the
 *     sidecar's first 5xx pages immediately rather than waiting
 *     for the metric counter to climb.
 *
 * Env:
 *   SIDECAR_URL — required. Same env var as `archive-sidecar.ts`.
 *                 When unset, the client throws on call (callers
 *                 should gate on the env var if they want
 *                 fail-open behavior for missing config).
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
  inferred_structure: z.enum(MULTILEG_STRUCTURES as unknown as [string, ...string[]]),
  is_isolated_leg: z.boolean(),
  match_confidence: z.number().min(0).max(1),
  pattern_group_id: z.string().min(1),
});

const responseSchema = z.object({
  classifications: z.array(classificationRowSchema),
});

// ── Internals ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const ENDPOINT_PATH = '/takeit/multileg-classify';

function resolveSidecarBase(): string {
  const raw = process.env.SIDECAR_URL?.trim();
  if (!raw) {
    throw new MultilegClassifyError(
      'config_missing',
      'SIDECAR_URL is not configured',
    );
  }
  return raw.replace(/\/$/, '');
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
 * the Railway sidecar's POST /takeit/multileg-classify endpoint and
 * returns one classification per input trade.
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

  const base = resolveSidecarBase();
  const url = `${base}${ENDPOINT_PATH}`;
  const body = buildRequestBody(trades, options);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

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
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, count: trades.length },
      'multileg-classify sidecar fetch failed',
    );
    Sentry.captureMessage('multileg.classify.sidecar_unreachable', {
      level: 'warning',
      extra: { error: message, count: trades.length },
    });
    throw new MultilegClassifyError('network', `network error: ${message}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
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
      { status: sidecarStatus, body: bodyText, count: trades.length },
      'multileg-classify sidecar non-2xx',
    );
    Sentry.captureMessage('multileg.classify.sidecar_non_2xx', {
      level: isServer ? 'warning' : 'error',
      extra: { status: sidecarStatus, body: bodyText, count: trades.length },
    });
    throw new MultilegClassifyError(
      kind,
      `sidecar returned ${sidecarStatus}`,
      { status: sidecarStatus },
    );
  }

  let rawJson: unknown;
  try {
    rawJson = await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Sentry.captureMessage('multileg.classify.invalid_json', {
      level: 'error',
      extra: { error: message },
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
      extra: { issues: parsed.error.issues },
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
  return out;
}
