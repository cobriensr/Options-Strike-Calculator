/**
 * GET /api/tracker/contracts?status=active|closed|expired
 *   Returns all tracker_contracts rows matching the status filter.
 *   `status` defaults to 'active' — the most common UI tab.
 *
 * POST /api/tracker/contracts
 *   Creates a new tracked contract. Accepts two body shapes:
 *
 *     1. Free-text input:
 *        { input: "NVDA 225P 05/22/26 @ 4.30 x 5 long", notes?, up_thresholds?, ... }
 *        Routed through parseFreeText() and toOccSymbol() server-side.
 *
 *     2. Structured form:
 *        { ticker, expiry, strike, side, direction, entry_price, quantity,
 *          notes?, up_thresholds?, down_thresholds?, spot_alerts? }
 *
 *   The shape is detected by the presence of `input`. Unique constraint
 *   on `occ_symbol` is leveraged via ON CONFLICT DO NOTHING — duplicate
 *   inserts return 409 Conflict.
 *
 * Both endpoints owner-or-guest. Single-tenant — tracker rows are shared
 * across every valid auth cookie. See
 * docs/superpowers/specs/contract-tracker-2026-05-17.md.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { parseFreeText, toOccSymbol } from '../_lib/occ.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import {
  contractCreateSchema,
  freeTextContractSchema,
  trackerContractsListQuerySchema,
  type ContractCreateBody,
  type FreeTextContractBody,
} from '../_lib/validation.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName(`${req.method ?? '??'} /api/tracker/contracts`);
    const done = metrics.request('/api/tracker/contracts');

    if (req.method !== 'GET' && req.method !== 'POST') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET or POST only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    if (req.method === 'GET') {
      return handleList(req, res, done);
    }
    return handleCreate(req, res, done);
  });
}

// ============================================================
// GET — list contracts by status
// ============================================================

async function handleList(
  req: VercelRequest,
  res: VercelResponse,
  done: (opts: { status: number }) => void,
) {
  const parsed = trackerContractsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    done({ status: 400 });
    return res.status(400).json({
      error: parsed.error.issues[0]?.message ?? 'Invalid query',
      issues: parsed.error.issues,
    });
  }
  const { status } = parsed.data;

  try {
    const sql = getDb();
    // LEFT JOIN LATERAL picks the most-recent tick per contract so the
    // frontend renders Current/Δ$/Δ% without a second round-trip. Active
    // rows usually have a tick (cron fills every 5 min); freshly-created
    // contracts and archived rows may have none, so the LEFT join keeps
    // them in the result set with NULL `latest_*` columns.
    // `expiry` is cast to text via TO_CHAR so the frontend receives a
    // stable YYYY-MM-DD string. The Neon driver hydrates DATE columns
    // as JS Date objects which then JSON-serialize to an ISO timestamp
    // ("2026-05-22T00:00:00.000Z") — that breaks helpers.dteFromExpiry
    // which splits on '-'. Bind the format at the SQL boundary so every
    // consumer (REST, ML export, tests) gets the same shape.
    const rows = await sql`
      SELECT
        c.id, c.occ_symbol, c.ticker,
        TO_CHAR(c.expiry, 'YYYY-MM-DD') AS expiry,
        c.strike, c.side,
        c.direction, c.entry_price, c.quantity, c.notes, c.status,
        c.closed_at, c.closed_price, c.up_thresholds, c.down_thresholds,
        c.spot_alerts, c.uw_url, c.created_at, c.updated_at,
        t.last         AS latest_last,
        t.bid          AS latest_bid,
        t.ask          AS latest_ask,
        t.underlying   AS latest_underlying,
        t.fetched_at   AS latest_fetched_at
      FROM tracker_contracts c
      LEFT JOIN LATERAL (
        SELECT last, bid, ask, underlying, fetched_at
        FROM tracker_contract_ticks
        WHERE contract_id = c.id
        ORDER BY fetched_at DESC
        LIMIT 1
      ) t ON true
      WHERE c.status = ${status}
      ORDER BY c.expiry ASC, c.ticker ASC, c.id ASC
    `;
    res.setHeader('Cache-Control', 'no-store');
    done({ status: 200 });
    return res.status(200).json({ contracts: rows, count: rows.length });
  } catch (err) {
    done({ status: 500 });
    Sentry.captureException(err);
    logger.error({ err }, 'tracker-contracts list error');
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ============================================================
// POST — create new contract (structured OR free-text body)
// ============================================================

async function handleCreate(
  req: VercelRequest,
  res: VercelResponse,
  done: (opts: { status: number }) => void,
) {
  // Discriminate body shape via presence of `input`. Both schemas
  // safeParse independently — we don't use a discriminatedUnion because
  // the two shapes overlap on `notes` / `up_thresholds` / etc.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const isFreeText = typeof body.input === 'string';

  let occSymbol: string;
  let resolved: {
    ticker: string;
    expiry: string;
    strike: number;
    side: 'C' | 'P';
    direction: 'long' | 'short';
    entry_price: number;
    quantity: number;
  };
  let extras: {
    notes?: string | undefined;
    up_thresholds?: number[] | undefined;
    down_thresholds?: number[] | undefined;
    spot_alerts?: { op: string; level: number }[] | undefined;
    uw_url?: string | undefined;
  };

  if (isFreeText) {
    const parsed = freeTextContractSchema.safeParse(req.body);
    if (!parsed.success) {
      done({ status: 400 });
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid request body',
        issues: parsed.error.issues,
      });
    }
    const data: FreeTextContractBody = parsed.data;

    let freeParsed;
    try {
      freeParsed = parseFreeText(data.input);
    } catch (err) {
      done({ status: 400 });
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Could not parse input',
      });
    }
    // entry_price + quantity are optional in the free-text grammar; the
    // tracker requires them so we 400 when missing rather than write a
    // NULL into a NOT NULL column.
    if (freeParsed.entry_price === undefined) {
      done({ status: 400 });
      return res.status(400).json({
        error: 'Free-text input must include entry price (e.g. "@ 4.30")',
      });
    }
    if (freeParsed.quantity === undefined) {
      done({ status: 400 });
      return res.status(400).json({
        error: 'Free-text input must include quantity (e.g. "x 5")',
      });
    }

    try {
      occSymbol = toOccSymbol({
        ticker: freeParsed.ticker,
        expiry: freeParsed.expiry,
        side: freeParsed.side,
        strike: freeParsed.strike,
      });
    } catch (err) {
      done({ status: 400 });
      return res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Could not build OCC symbol',
      });
    }

    resolved = {
      ticker: freeParsed.ticker,
      expiry: isoDateFromDate(freeParsed.expiry),
      strike: freeParsed.strike,
      side: freeParsed.side,
      direction: freeParsed.direction,
      entry_price: freeParsed.entry_price,
      quantity: freeParsed.quantity,
    };
    extras = {
      notes: data.notes,
      up_thresholds: data.up_thresholds,
      down_thresholds: data.down_thresholds,
      spot_alerts: data.spot_alerts,
      uw_url: data.uw_url,
    };
  } else {
    const parsed = contractCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      done({ status: 400 });
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid request body',
        issues: parsed.error.issues,
      });
    }
    const data: ContractCreateBody = parsed.data;
    try {
      occSymbol = toOccSymbol({
        ticker: data.ticker,
        expiry: data.expiry,
        side: data.side,
        strike: data.strike,
      });
    } catch (err) {
      done({ status: 400 });
      return res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Could not build OCC symbol',
      });
    }
    resolved = {
      ticker: data.ticker,
      expiry: data.expiry,
      strike: data.strike,
      side: data.side,
      direction: data.direction,
      entry_price: data.entry_price,
      quantity: data.quantity,
    };
    extras = {
      notes: data.notes,
      up_thresholds: data.up_thresholds,
      down_thresholds: data.down_thresholds,
      spot_alerts: data.spot_alerts,
      uw_url: data.uw_url,
    };
  }

  try {
    const sql = getDb();
    // ON CONFLICT DO NOTHING on occ_symbol unique constraint — if a row
    // already exists for this contract, RETURNING produces an empty
    // result set and we 409 from the empty length check.
    const spotAlertsJson =
      extras.spot_alerts !== undefined
        ? JSON.stringify(extras.spot_alerts)
        : null;
    const rows = await sql`
      INSERT INTO tracker_contracts (
        occ_symbol, ticker, expiry, strike, side, direction,
        entry_price, quantity, notes,
        up_thresholds, down_thresholds, spot_alerts, uw_url
      )
      VALUES (
        ${occSymbol}, ${resolved.ticker}, ${resolved.expiry},
        ${resolved.strike}, ${resolved.side}, ${resolved.direction},
        ${resolved.entry_price}, ${resolved.quantity},
        ${extras.notes ?? null},
        ${extras.up_thresholds ?? null},
        ${extras.down_thresholds ?? null},
        ${spotAlertsJson}::jsonb,
        ${extras.uw_url ?? null}
      )
      ON CONFLICT (occ_symbol) DO NOTHING
      RETURNING id, occ_symbol, ticker,
                TO_CHAR(expiry, 'YYYY-MM-DD') AS expiry,
                strike, side, direction,
                entry_price, quantity, notes, status, closed_at, closed_price,
                up_thresholds, down_thresholds, spot_alerts, uw_url,
                created_at, updated_at,
                NULL::numeric     AS latest_last,
                NULL::numeric     AS latest_bid,
                NULL::numeric     AS latest_ask,
                NULL::numeric     AS latest_underlying,
                NULL::timestamptz AS latest_fetched_at
    `;

    if (rows.length === 0) {
      done({ status: 409 });
      return res.status(409).json({
        error: 'A contract with this OCC symbol already exists',
        occ_symbol: occSymbol,
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    done({ status: 201 });
    return res.status(201).json({ contract: rows[0] });
  } catch (err) {
    done({ status: 500 });
    Sentry.captureException(err);
    logger.error({ err, occSymbol }, 'tracker-contracts create error');
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ============================================================
// helpers
// ============================================================

/** Format a Date (UTC components) as YYYY-MM-DD. */
function isoDateFromDate(d: Date): string {
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
