/**
 * Read helpers for the GEXBot capture tables (`gexbot_snapshots`,
 * `gexbot_api_capture`). Each helper returns a typed view shape
 * consumed by `api/gexbot.ts`.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 *
 * All helpers return `[]` when the source tables are empty — the
 * frontend renders empty-state for that case. They do NOT throw.
 */

import { getDb, withDbRetry } from './db.js';

// Per-attempt timeout for read queries — same budget the rest of the
// codebase uses. 3 attempts × 10s = 30s fail-fast, before Vercel's
// 300s gateway timeout surfaces as HTTP 504 in the browser.
const READ_RETRIES = 2;
const READ_TIMEOUT_MS = 10_000;

// ────────────────────────────────────────────────────────────
// Types — shared with src/components/Gexbot/types.ts via JSON
// ────────────────────────────────────────────────────────────

export interface SnapshotsLatestRow {
  ticker: string;
  capturedAt: string;
  spot: number | null;
  zeroGamma: number | null;
  zMlgamma: number | null;
  zMsgamma: number | null;
  zcvr: number | null;
  zgr: number | null;
  zvanna: number | null;
  zcharm: number | null;
  oMlgamma: number | null;
  oMsgamma: number | null;
  ocvr: number | null;
  ogr: number | null;
  ovanna: number | null;
  ocharm: number | null;
  dexoflow: number | null;
  gexoflow: number | null;
  cvroflow: number | null;
  oneDexoflow: number | null;
  oneGexoflow: number | null;
  oneCvroflow: number | null;
  deltaRiskReversal: number | null;
}

export interface MaxchangeWinnerRow {
  ticker: string;
  endpoint: string;
  category: string;
  capturedAt: string;
  /** `[strike, change]` tuples per lookback window. */
  windows: {
    current: [number, number] | null;
    one: [number, number] | null;
    five: [number, number] | null;
    ten: [number, number] | null;
    fifteen: [number, number] | null;
    thirty: [number, number] | null;
  };
}

export interface ConvexityTrendRow {
  ticker: string;
  /** Time-ordered `[isoTimestamp, zcvr]` points, oldest first. */
  series: Array<[string, number]>;
}

export interface SiblingConfirmRow {
  ticker: string;
  zcvr: number | null;
  deltaRiskReversal: number | null;
  /** 'confirm' / 'contradict' / 'neutral' relative to the calling row's side. */
  verdict: 'confirm' | 'contradict' | 'neutral';
}

// ────────────────────────────────────────────────────────────
// Sibling-asset grouping — see spec for rationale
// ────────────────────────────────────────────────────────────

/**
 * Const-typed grouping so `SIBLING_GROUPS.broad` is a readonly tuple
 * (not `T | undefined` under noUncheckedIndexedAccess). Single-stock
 * alerts default to `broad` siblings since most large-caps move with
 * SPY/QQQ.
 */
export const SIBLING_GROUPS = {
  broad: ['SPX', 'SPY', 'QQQ', 'IWM', 'NDX'] as const,
  vol: ['VIX', 'UVXY'] as const,
  bonds: ['TLT', 'HYG'] as const,
  metals: ['GLD', 'SLV'] as const,
  energy: ['USO'] as const,
} as const;

function siblingsFor(ticker: string): readonly string[] {
  for (const group of Object.values(SIBLING_GROUPS)) {
    if ((group as readonly string[]).includes(ticker)) {
      return group.filter((t) => t !== ticker);
    }
  }
  return SIBLING_GROUPS.broad.filter((t) => t !== ticker);
}

// ────────────────────────────────────────────────────────────
// Numeric coercion (Neon serverless driver returns NUMERIC as string)
// ────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// ────────────────────────────────────────────────────────────
// Query: latest snapshots (one row per ticker)
// ────────────────────────────────────────────────────────────

interface RawSnapshotsRow {
  ticker: string;
  captured_at: string | Date;
  spot: unknown;
  zero_gamma: unknown;
  z_mlgamma: unknown;
  z_msgamma: unknown;
  zcvr: unknown;
  zgr: unknown;
  zvanna: unknown;
  zcharm: unknown;
  o_mlgamma: unknown;
  o_msgamma: unknown;
  ocvr: unknown;
  ogr: unknown;
  ovanna: unknown;
  ocharm: unknown;
  dexoflow: unknown;
  gexoflow: unknown;
  cvroflow: unknown;
  one_dexoflow: unknown;
  one_gexoflow: unknown;
  one_cvroflow: unknown;
  delta_risk_reversal: unknown;
}

export async function getLatestSnapshots(): Promise<SnapshotsLatestRow[]> {
  const sql = getDb();
  // 15-min freshness window: fetch crons run 1/min, so anything older
  // is stale (cron-down, ticker decommissioned, weekend) and shouldn't
  // appear in "latest" results. Also bounds the DISTINCT ON scan to
  // recent rows in the (ticker, captured_at DESC) index.
  const rows = (await withDbRetry(
    () => sql`
      SELECT DISTINCT ON (ticker)
        ticker, captured_at,
        spot, zero_gamma,
        z_mlgamma, z_msgamma, zcvr, zgr, zvanna, zcharm,
        o_mlgamma, o_msgamma, ocvr, ogr, ovanna, ocharm,
        dexoflow, gexoflow, cvroflow,
        one_dexoflow, one_gexoflow, one_cvroflow,
        delta_risk_reversal
      FROM gexbot_snapshots
      WHERE captured_at >= now() - INTERVAL '15 minutes'
      ORDER BY ticker, captured_at DESC
    `,
    READ_RETRIES,
    READ_TIMEOUT_MS,
  )) as RawSnapshotsRow[];

  return rows.map((r) => ({
    ticker: r.ticker,
    capturedAt: toIso(r.captured_at),
    spot: toNum(r.spot),
    zeroGamma: toNum(r.zero_gamma),
    zMlgamma: toNum(r.z_mlgamma),
    zMsgamma: toNum(r.z_msgamma),
    zcvr: toNum(r.zcvr),
    zgr: toNum(r.zgr),
    zvanna: toNum(r.zvanna),
    zcharm: toNum(r.zcharm),
    oMlgamma: toNum(r.o_mlgamma),
    oMsgamma: toNum(r.o_msgamma),
    ocvr: toNum(r.ocvr),
    ogr: toNum(r.ogr),
    ovanna: toNum(r.ovanna),
    ocharm: toNum(r.ocharm),
    dexoflow: toNum(r.dexoflow),
    gexoflow: toNum(r.gexoflow),
    cvroflow: toNum(r.cvroflow),
    oneDexoflow: toNum(r.one_dexoflow),
    oneGexoflow: toNum(r.one_gexoflow),
    oneCvroflow: toNum(r.one_cvroflow),
    deltaRiskReversal: toNum(r.delta_risk_reversal),
  }));
}

// ────────────────────────────────────────────────────────────
// Query: convexity trend (last 60 min per ticker)
// ────────────────────────────────────────────────────────────

interface RawConvexityPoint {
  ticker: string;
  captured_at: string | Date;
  zcvr: unknown;
}

export async function getConvexityTrend(
  windowMinutes = 60,
): Promise<ConvexityTrendRow[]> {
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT ticker, captured_at, zcvr
      FROM gexbot_snapshots
      WHERE captured_at >= now() - (${windowMinutes}::int * INTERVAL '1 minute')
        AND zcvr IS NOT NULL
      ORDER BY ticker, captured_at ASC
    `,
    READ_RETRIES,
    READ_TIMEOUT_MS,
  )) as RawConvexityPoint[];

  const byTicker = new Map<string, Array<[string, number]>>();
  for (const r of rows) {
    const value = toNum(r.zcvr);
    if (value === null) continue;
    const list = byTicker.get(r.ticker) ?? [];
    list.push([toIso(r.captured_at), value]);
    byTicker.set(r.ticker, list);
  }
  return Array.from(byTicker, ([ticker, series]) => ({ ticker, series }));
}

// ────────────────────────────────────────────────────────────
// Query: latest maxchange winners
// ────────────────────────────────────────────────────────────

interface RawCaptureRow {
  ticker: string;
  endpoint: string;
  category: string;
  captured_at: string | Date;
  raw_response: unknown;
}

function pickWindowTuple(raw: unknown, key: string): [number, number] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as Record<string, unknown>)[key];
  if (!Array.isArray(value) || value.length < 2) return null;
  const strike = toNum(value[0]);
  const change = toNum(value[1]);
  return strike !== null && change !== null ? [strike, change] : null;
}

export async function getMaxchangeWinners(): Promise<MaxchangeWinnerRow[]> {
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT DISTINCT ON (ticker, endpoint, category)
        ticker, endpoint, category, captured_at, raw_response
      FROM gexbot_api_capture
      WHERE category LIKE '%/maxchange'
      ORDER BY ticker, endpoint, category, captured_at DESC
    `,
    READ_RETRIES,
    READ_TIMEOUT_MS,
  )) as RawCaptureRow[];

  return rows.map((r) => ({
    ticker: r.ticker,
    endpoint: r.endpoint,
    category: r.category,
    capturedAt: toIso(r.captured_at),
    windows: {
      current: pickWindowTuple(r.raw_response, 'current'),
      one: pickWindowTuple(r.raw_response, 'one'),
      five: pickWindowTuple(r.raw_response, 'five'),
      ten: pickWindowTuple(r.raw_response, 'ten'),
      fifteen: pickWindowTuple(r.raw_response, 'fifteen'),
      thirty: pickWindowTuple(r.raw_response, 'thirty'),
    },
  }));
}

// ────────────────────────────────────────────────────────────
// Query: sibling confirmation
// ────────────────────────────────────────────────────────────

/**
 * For an alert on `ticker` going `side` (call or put), pull the latest
 * `zcvr` + `delta_risk_reversal` for each sibling and label whether
 * the sibling confirms or contradicts the alert's direction.
 *
 * Heuristic verdict (v0; spec calls out this needs validation):
 *   - call alerts: sibling zcvr > 1 OR delta_risk_reversal > 0 → confirm
 *   - put alerts:  sibling zcvr < 1 OR delta_risk_reversal < 0 → confirm
 *   - else neutral
 */
export async function getSiblingConfirmation(
  ticker: string,
  side: 'call' | 'put',
): Promise<SiblingConfirmRow[]> {
  const siblings = siblingsFor(ticker);
  if (siblings.length === 0) return [];

  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT DISTINCT ON (ticker)
        ticker, zcvr, delta_risk_reversal
      FROM gexbot_snapshots
      WHERE ticker = ANY(${siblings as readonly string[]}::text[])
        AND captured_at >= now() - INTERVAL '5 minutes'
      ORDER BY ticker, captured_at DESC
    `,
    READ_RETRIES,
    READ_TIMEOUT_MS,
  )) as Array<{ ticker: string; zcvr: unknown; delta_risk_reversal: unknown }>;

  return rows.map((r) => {
    const zcvr = toNum(r.zcvr);
    const drr = toNum(r.delta_risk_reversal);
    const callBias = (zcvr !== null && zcvr > 1) || (drr !== null && drr > 0);
    const putBias = (zcvr !== null && zcvr < 1) || (drr !== null && drr < 0);
    let verdict: 'confirm' | 'contradict' | 'neutral' = 'neutral';
    if (side === 'call') {
      if (callBias) verdict = 'confirm';
      else if (putBias) verdict = 'contradict';
    } else {
      if (putBias) verdict = 'confirm';
      else if (callBias) verdict = 'contradict';
    }
    return { ticker: r.ticker, zcvr, deltaRiskReversal: drr, verdict };
  });
}
