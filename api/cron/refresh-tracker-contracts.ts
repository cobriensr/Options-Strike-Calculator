/**
 * GET /api/cron/refresh-tracker-contracts
 *
 * Refreshes tracked option contracts every 5 min during market hours.
 * For each active row in `tracker_contracts`:
 *
 *   1. Auto-expire any row whose expiry is in the past (status='expired',
 *      closed_at=NOW(), closed_price=last known tick or entry_price fallback).
 *   2. Fetch spot for each unique ticker via UW `/stock/{ticker}/stock-state`.
 *   3. Fetch latest option contract snapshots via UW
 *      `/stock/{ticker}/option-contracts?option_symbol[]=...` — one call per
 *      ticker, filtered to that ticker's tracked OCC symbols. (The previous
 *      `/option-contract/{occ_symbol}` path returns 404; this endpoint
 *      replaces it, see SENTRY-EMERALD-DESERT-8T.)
 *   4. Insert a fresh row into `tracker_contract_ticks` (batched 500/insert).
 *   5. Evaluate threshold alerts:
 *        - up_pct  / down_pct (% return vs entry)
 *        - spot_level         (underlying breached configured operator)
 *        - dte_7              (one-shot at exactly 7 days to expiry)
 *      ON CONFLICT DO NOTHING against tracker_alerts_dedup_idx so each
 *      threshold fires at most once per contract over its lifetime.
 *
 * Per-fetch failures are caught and surfaced to Sentry tagged with
 * { contract_id, occ_symbol, ticker }. One failed UW call never aborts
 * the batch — `Promise.allSettled` is used for all parallel fetches.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 *
 * Spec: docs/superpowers/specs/contract-tracker-2026-05-17.md
 */

import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import { uwFetch, withRetry } from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

// ── Types ──────────────────────────────────────────────────────────

interface SpotAlertSpec {
  op: '>=' | '<=' | '>' | '<' | '=';
  level: number;
}

interface ActiveContractRow {
  id: number;
  occ_symbol: string;
  ticker: string;
  // Neon driver returns DATE columns as Date objects (per memory
  // feedback_neon_date_columns).
  expiry: Date | string;
  entry_price: string | number;
  up_thresholds: unknown;
  down_thresholds: unknown;
  spot_alerts: unknown;
}

interface NormalizedContract {
  id: number;
  occ_symbol: string;
  ticker: string;
  expiryDate: string; // YYYY-MM-DD
  entryPrice: number;
  upThresholds: number[];
  downThresholds: number[];
  spotAlerts: SpotAlertSpec[];
}

/** UW returns numeric fields as either a JSON number or a string. */
type UwNum = string | number | null;

interface UwStockState {
  // UW spec drifts vs. live (per memory feedback_uw_spec_vs_live). We
  // accept multiple candidate fields and pick the first finite one.
  close?: UwNum;
  last?: UwNum;
  price?: UwNum;
  underlying_price?: UwNum;
}

interface UwOptionContract {
  // Identifier we match against the tracker's OCC symbol. UW returns
  // the un-padded ISO form (e.g. "NVDA260522P00225000"); we normalize
  // both sides before lookup.
  option_symbol?: string;
  // `/stock/{ticker}/option-contracts` returns `last_price`, `nbbo_bid`,
  // `nbbo_ask`, `volume`, `open_interest`. We also accept the shorter
  // field names just in case the live envelope drifts from the spec.
  last_price?: UwNum;
  last?: UwNum;
  nbbo_bid?: UwNum;
  nbbo_ask?: UwNum;
  bid?: UwNum;
  ask?: UwNum;
  volume?: UwNum;
  open_interest?: UwNum;
  open_int?: UwNum;
  oi?: UwNum;
  underlying_price?: UwNum;
}

interface ContractTick {
  contract_id: number;
  fetched_at: string; // ISO timestamp
  last: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  open_int: number | null;
  underlying: number | null;
}

interface AlertCandidate {
  contract_id: number;
  alert_type: 'up_pct' | 'down_pct' | 'spot_level' | 'dte_7';
  threshold: number;
  price_at_fire: number | null;
  underlying_at_fire: number | null;
}

// ── Defaults ───────────────────────────────────────────────────────

const DEFAULT_UP_THRESHOLDS: readonly number[] = [50, 100, 200];
const DEFAULT_DOWN_THRESHOLDS: readonly number[] = [-30, -50];
const TICK_INSERT_BATCH_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Normalization helpers ──────────────────────────────────────────

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function asInt(v: unknown): number | null {
  const n = parseNum(v);
  if (n == null) return null;
  return Math.trunc(n);
}

function expiryToIsoDate(expiry: Date | string): string {
  if (expiry instanceof Date) {
    return expiry.toISOString().slice(0, 10);
  }
  // Strings come in as 'YYYY-MM-DD' from Postgres' DATE column when the
  // driver doesn't coerce. Truncate defensively in case a timestamp form
  // sneaks through.
  return expiry.slice(0, 10);
}

function normalizeThresholdArray(
  raw: unknown,
  fallback: readonly number[],
): number[] {
  if (raw == null) return [...fallback];
  if (!Array.isArray(raw)) return [...fallback];
  const out: number[] = [];
  for (const v of raw) {
    const n = parseNum(v);
    if (n != null) out.push(n);
  }
  return out.length > 0 ? out : [...fallback];
}

function normalizeSpotAlerts(raw: unknown): SpotAlertSpec[] {
  if (raw == null) return [];
  // JSONB returns a parsed array/object from the Neon driver. Defensively
  // accept stringified JSON too in case a future code path stores it
  // pre-serialized.
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: SpotAlertSpec[] = [];
  for (const entry of value) {
    if (entry == null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const op = typeof e.op === 'string' ? e.op : null;
    const level = parseNum(e.level);
    if (op == null || level == null) continue;
    if (op === '>=' || op === '<=' || op === '>' || op === '<' || op === '=') {
      out.push({ op, level });
    }
  }
  return out;
}

function normalizeRow(r: ActiveContractRow): NormalizedContract {
  return {
    id: r.id,
    occ_symbol: r.occ_symbol,
    ticker: r.ticker,
    expiryDate: expiryToIsoDate(r.expiry),
    entryPrice: parseNum(r.entry_price) ?? 0,
    upThresholds: normalizeThresholdArray(
      r.up_thresholds,
      DEFAULT_UP_THRESHOLDS,
    ),
    downThresholds: normalizeThresholdArray(
      r.down_thresholds,
      DEFAULT_DOWN_THRESHOLDS,
    ),
    spotAlerts: normalizeSpotAlerts(r.spot_alerts),
  };
}

// ── UW helpers ─────────────────────────────────────────────────────

async function fetchStockState(
  apiKey: string,
  ticker: string,
): Promise<number | null> {
  // UW's stock-state endpoint returns a single object (not an array) so
  // we use the extract callback to surface it as a one-element list, then
  // pick the first finite price-like field.
  const rows = await uwFetch<UwStockState>(
    apiKey,
    `/stock/${encodeURIComponent(ticker)}/stock-state`,
    (body) => {
      // The standard UW shape is `{ data: { ...row } }` for single-object
      // endpoints. Accept either an object or a one-element array under
      // `data` so we tolerate spec drift.
      const data = (body as { data?: unknown }).data;
      if (Array.isArray(data)) return data as UwStockState[];
      if (data && typeof data === 'object') return [data as UwStockState];
      return [];
    },
  );
  const row = rows[0];
  if (!row) return null;
  return (
    parseNum(row.close) ??
    parseNum(row.last) ??
    parseNum(row.price) ??
    parseNum(row.underlying_price)
  );
}

/**
 * OCC symbols come from the DB space-padded (`'NVDA  260522P00225000'`).
 * UW's response uses the un-padded ISO form. Normalize before comparing.
 */
function normalizeOcc(symbol: string): string {
  return symbol.replace(/\s+/g, '').toUpperCase();
}

/**
 * Fetch the latest option-contract snapshots for one ticker, scoped to
 * the OCC symbols the tracker holds. One UW call replaces N per-contract
 * calls and uses an endpoint that actually exists (see
 * SENTRY-EMERALD-DESERT-8T for the previous 404 path).
 *
 * Returns a Map keyed by the normalized OCC symbol so callers can look
 * up each tracked contract regardless of whether the DB row was
 * space-padded.
 */
async function fetchOptionContractsForTicker(
  apiKey: string,
  ticker: string,
  occSymbols: readonly string[],
): Promise<Map<string, UwOptionContract>> {
  if (occSymbols.length === 0) return new Map();
  // option_symbol[] is a PHP/Rails-style array param. URL-encode the
  // brackets so they survive both the wrapper's URL parser and any
  // intermediate proxies.
  const qs = occSymbols
    .map((s) => `option_symbol%5B%5D=${encodeURIComponent(normalizeOcc(s))}`)
    .join('&');
  const rows = await uwFetch<UwOptionContract>(
    apiKey,
    `/stock/${encodeURIComponent(ticker)}/option-contracts?${qs}`,
  );

  const out = new Map<string, UwOptionContract>();
  for (const row of rows) {
    if (row?.option_symbol) {
      out.set(normalizeOcc(row.option_symbol), row);
    }
  }
  return out;
}

// ── Auto-expiry ────────────────────────────────────────────────────

interface ExpiryResult {
  expired: number;
}

async function autoExpirePastDue(
  contracts: readonly NormalizedContract[],
  todayIso: string,
): Promise<{ expired: ExpiryResult; live: NormalizedContract[] }> {
  const sql = getDb();
  const live: NormalizedContract[] = [];
  let expired = 0;

  for (const c of contracts) {
    if (c.expiryDate < todayIso) {
      // Use COALESCE of (latest tick last, entry_price) so the archive
      // panel can render a closed_price even when no tick has ever been
      // recorded for the contract.
      await sql`
        UPDATE tracker_contracts
        SET status = 'expired',
            closed_at = NOW(),
            closed_price = COALESCE(
              (
                SELECT last
                FROM tracker_contract_ticks
                WHERE contract_id = ${c.id}
                ORDER BY fetched_at DESC
                LIMIT 1
              ),
              ${c.entryPrice}
            ),
            updated_at = NOW()
        WHERE id = ${c.id}
      `;
      expired += 1;
    } else {
      live.push(c);
    }
  }

  return { expired: { expired }, live };
}

// ── Tick batch insert (500 rows / query — per feedback_batched_inserts) ─

async function insertTicksBatched(
  ticks: readonly ContractTick[],
): Promise<number> {
  if (ticks.length === 0) return 0;
  const sql = getDb();
  let inserted = 0;

  for (let i = 0; i < ticks.length; i += TICK_INSERT_BATCH_SIZE) {
    const chunk = ticks.slice(i, i + TICK_INSERT_BATCH_SIZE);
    const contractIds = chunk.map((t) => t.contract_id);
    const fetchedAts = chunk.map((t) => t.fetched_at);
    const lasts = chunk.map((t) => t.last);
    const bids = chunk.map((t) => t.bid);
    const asks = chunk.map((t) => t.ask);
    const volumes = chunk.map((t) => t.volume);
    const openInts = chunk.map((t) => t.open_int);
    const underlyings = chunk.map((t) => t.underlying);

    await sql`
      INSERT INTO tracker_contract_ticks (
        contract_id, fetched_at, last, bid, ask, volume, open_int, underlying
      )
      SELECT t.contract_id, t.fetched_at::timestamptz,
             t.last, t.bid, t.ask, t.volume, t.open_int, t.underlying
      FROM unnest(
        ${contractIds}::int[],
        ${fetchedAts}::text[],
        ${lasts}::numeric[],
        ${bids}::numeric[],
        ${asks}::numeric[],
        ${volumes}::int[],
        ${openInts}::int[],
        ${underlyings}::numeric[]
      ) AS t(
        contract_id, fetched_at,
        last, bid, ask, volume, open_int, underlying
      )
    `;
    inserted += chunk.length;
  }

  return inserted;
}

// ── Alert evaluation ──────────────────────────────────────────────

function evalSpotOp(
  underlying: number,
  op: SpotAlertSpec['op'],
  level: number,
): boolean {
  switch (op) {
    case '>=':
      return underlying >= level;
    case '<=':
      return underlying <= level;
    case '>':
      return underlying > level;
    case '<':
      return underlying < level;
    case '=':
      return underlying === level;
    default:
      return false;
  }
}

/**
 * Build the full set of alert candidates for one (contract, tick) pair.
 *
 * Pure function so the alert-evaluation rules can be unit-tested
 * independently of DB / UW. The cron handler runs the candidate list
 * through INSERT ... ON CONFLICT DO NOTHING — duplicates are silently
 * dedup'd by the (contract_id, alert_type, threshold) unique index.
 */
export function evaluateAlerts(
  contract: NormalizedContract,
  last: number | null,
  underlying: number | null,
  todayIso: string,
): AlertCandidate[] {
  const out: AlertCandidate[] = [];

  // Up / down percentage alerts (require both entry_price and a fresh
  // last price; a zero entry_price is treated as invalid).
  if (last != null && contract.entryPrice > 0) {
    const pct = ((last - contract.entryPrice) / contract.entryPrice) * 100;

    for (const t of contract.upThresholds) {
      if (pct >= t) {
        out.push({
          contract_id: contract.id,
          alert_type: 'up_pct',
          threshold: t,
          price_at_fire: last,
          underlying_at_fire: underlying,
        });
      }
    }

    for (const t of contract.downThresholds) {
      if (pct <= t) {
        out.push({
          contract_id: contract.id,
          alert_type: 'down_pct',
          threshold: t,
          price_at_fire: last,
          underlying_at_fire: underlying,
        });
      }
    }
  }

  // Spot-level alerts — fire when the underlying side of the inequality
  // is satisfied. Independent of the option's last price.
  if (underlying != null) {
    for (const spec of contract.spotAlerts) {
      if (evalSpotOp(underlying, spec.op, spec.level)) {
        out.push({
          contract_id: contract.id,
          alert_type: 'spot_level',
          threshold: spec.level,
          price_at_fire: last,
          underlying_at_fire: underlying,
        });
      }
    }
  }

  // DTE === 7 (one-shot, deduped by the unique index at threshold=7).
  // Compute days strictly off the calendar date difference so DST and
  // wall-clock noise don't perturb the count.
  const today = new Date(`${todayIso}T00:00:00.000Z`);
  const exp = new Date(`${contract.expiryDate}T00:00:00.000Z`);
  if (Number.isFinite(today.getTime()) && Number.isFinite(exp.getTime())) {
    const dte = Math.floor((exp.getTime() - today.getTime()) / DAY_MS);
    if (dte === 7) {
      out.push({
        contract_id: contract.id,
        alert_type: 'dte_7',
        threshold: 7,
        price_at_fire: last,
        underlying_at_fire: underlying,
      });
    }
  }

  return out;
}

async function insertAlerts(
  candidates: readonly AlertCandidate[],
): Promise<number> {
  if (candidates.length === 0) return 0;
  const sql = getDb();
  let fired = 0;
  for (const c of candidates) {
    // The unique index (contract_id, alert_type, threshold) makes this
    // idempotent — second-and-subsequent calls for the same (contract,
    // alert, threshold) silently noop. RETURNING id gives us a precise
    // "did this row actually fire?" signal for the response payload.
    const result = await sql`
      INSERT INTO tracker_alerts (
        contract_id, alert_type, threshold,
        price_at_fire, underlying_at_fire
      ) VALUES (
        ${c.contract_id}, ${c.alert_type}, ${c.threshold},
        ${c.price_at_fire}, ${c.underlying_at_fire}
      )
      ON CONFLICT (contract_id, alert_type, threshold) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) fired += 1;
  }
  return fired;
}

// ── Per-ticker spot map ───────────────────────────────────────────

async function fetchSpotMap(
  apiKey: string,
  tickers: readonly string[],
  log: { warn: (obj: object, msg: string) => void },
): Promise<Map<string, number | null>> {
  const unique = Array.from(new Set(tickers));
  const settled = await Promise.allSettled(
    unique.map((t) => withRetry(() => fetchStockState(apiKey, t))),
  );

  const spotMap = new Map<string, number | null>();
  settled.forEach((res, idx) => {
    const ticker = unique[idx]!;
    if (res.status === 'fulfilled') {
      spotMap.set(ticker, res.value);
    } else {
      spotMap.set(ticker, null);
      const err = res.reason;
      log.warn({ err, ticker }, 'tracker spot fetch failed');
      Sentry.captureException(err, {
        tags: { cron: 'refresh-tracker-contracts', ticker },
      });
    }
  });
  return spotMap;
}

// ── Per-contract fetch + tick build ───────────────────────────────

interface FetchedTick {
  contract: NormalizedContract;
  tick: ContractTick;
}

async function fetchContractTicks(
  apiKey: string,
  contracts: readonly NormalizedContract[],
  spotMap: ReadonlyMap<string, number | null>,
  log: { warn: (obj: object, msg: string) => void },
): Promise<FetchedTick[]> {
  if (contracts.length === 0) return [];
  const fetchedAt = new Date().toISOString();

  // Group contracts by ticker so we can issue one UW call per ticker
  // (`/stock/{ticker}/option-contracts?option_symbol[]=…`) instead of
  // one per contract. Order is preserved so the per-ticker Sentry tag
  // on failure remains accurate.
  const byTicker = new Map<string, NormalizedContract[]>();
  for (const c of contracts) {
    const bucket = byTicker.get(c.ticker);
    if (bucket) {
      bucket.push(c);
    } else {
      byTicker.set(c.ticker, [c]);
    }
  }

  const tickers = Array.from(byTicker.keys());
  const settled = await Promise.allSettled(
    tickers.map((t) =>
      withRetry(() =>
        fetchOptionContractsForTicker(
          apiKey,
          t,
          byTicker.get(t)!.map((c) => c.occ_symbol),
        ),
      ),
    ),
  );

  const out: FetchedTick[] = [];
  settled.forEach((res, idx) => {
    const ticker = tickers[idx]!;
    const bucket = byTicker.get(ticker)!;

    if (res.status !== 'fulfilled') {
      // The whole ticker batch failed — capture one Sentry event per
      // contract in the batch so per-contract triage tags survive.
      const err = res.reason;
      for (const contract of bucket) {
        log.warn(
          { err, contract_id: contract.id, occ_symbol: contract.occ_symbol },
          'tracker contract fetch failed',
        );
        Sentry.captureException(err, {
          tags: {
            cron: 'refresh-tracker-contracts',
            contract_id: String(contract.id),
            occ_symbol: contract.occ_symbol,
            ticker: contract.ticker,
          },
        });
      }
      return;
    }

    const lookup = res.value;
    for (const contract of bucket) {
      const data = lookup.get(normalizeOcc(contract.occ_symbol));
      if (!data) {
        // Contract not present in UW's response (delisted, mid-roll, or
        // simply not in this minute's chain snapshot). Skip silently —
        // next cron run retries.
        continue;
      }
      // Prefer per-contract underlying if UW returned one; fall back to
      // the per-ticker spot snapshot so spot-level alerts still trigger.
      const contractUnderlying = parseNum(data.underlying_price);
      const tickerSpot = spotMap.get(contract.ticker) ?? null;
      const underlying = contractUnderlying ?? tickerSpot;

      const last = parseNum(data.last_price) ?? parseNum(data.last);

      const tick: ContractTick = {
        contract_id: contract.id,
        fetched_at: fetchedAt,
        last,
        bid: parseNum(data.nbbo_bid) ?? parseNum(data.bid),
        ask: parseNum(data.nbbo_ask) ?? parseNum(data.ask),
        volume: asInt(data.volume),
        open_int:
          asInt(data.open_interest) ?? asInt(data.open_int) ?? asInt(data.oi),
        underlying,
      };
      out.push({ contract, tick });
    }
  });

  return out;
}

// ── Handler ────────────────────────────────────────────────────────

export default withCronInstrumentation(
  'refresh-tracker-contracts',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today, logger: log } = ctx;
    const sql = getDb();

    // 1. Load active rows. Read fields needed for both expiry sweep and
    // alert evaluation in a single round trip.
    const rawRows = (await sql`
      SELECT id, occ_symbol, ticker, expiry,
             entry_price, up_thresholds, down_thresholds, spot_alerts
      FROM tracker_contracts
      WHERE status = 'active'
    `) as ActiveContractRow[];

    if (rawRows.length === 0) {
      return {
        status: 'success',
        message: 'no active contracts',
        metadata: {
          processed: 0,
          expired: 0,
          ticks_inserted: 0,
          alerts_fired: 0,
        },
      };
    }

    const contracts = rawRows.map(normalizeRow);

    // Breadcrumb: top-of-run state. Visible in Sentry on any subsequent
    // captureException for this invocation.
    Sentry.addBreadcrumb?.({
      category: 'cron',
      message: 'refresh-tracker-contracts: start',
      level: 'info',
      data: {
        active_count: contracts.length,
        unique_tickers: new Set(contracts.map((c) => c.ticker)).size,
      },
    });

    // 2. Auto-expire any rows whose expiry has passed.
    const { expired, live } = await autoExpirePastDue(contracts, today);
    if (expired.expired > 0) {
      Sentry.addBreadcrumb?.({
        category: 'cron',
        message: 'refresh-tracker-contracts: auto-expired',
        level: 'info',
        data: { auto_expired: expired.expired },
      });
    }

    // 3. Fan out spot fetches per unique ticker.
    const spotMap = await fetchSpotMap(
      apiKey,
      live.map((c) => c.ticker),
      log,
    );

    // 4. Fan out per-contract fetches.
    const fetched = await fetchContractTicks(apiKey, live, spotMap, log);

    // 5. Persist ticks (batched 500/INSERT).
    const ticksInserted = await insertTicksBatched(fetched.map((f) => f.tick));

    // 6. Evaluate alerts against each fresh tick.
    const candidates: AlertCandidate[] = [];
    for (const { contract, tick } of fetched) {
      candidates.push(
        ...evaluateAlerts(contract, tick.last, tick.underlying, today),
      );
    }
    const alertsFired = await insertAlerts(candidates);

    log.info(
      {
        processed: live.length,
        expired: expired.expired,
        ticks_inserted: ticksInserted,
        alerts_fired: alertsFired,
        candidates: candidates.length,
      },
      'refresh-tracker-contracts completed',
    );

    return {
      status: 'success',
      metadata: {
        processed: live.length,
        expired: expired.expired,
        ticks_inserted: ticksInserted,
        alerts_fired: alertsFired,
      },
    };
  },
);
