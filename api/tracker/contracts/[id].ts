/**
 * PATCH  /api/tracker/contracts/:id
 *   Partial update of a tracker_contracts row. Body shape is
 *   `ContractUpdateBody` — every field optional. Two conditional rules
 *   the handler enforces beyond the Zod schema:
 *
 *     1. `status` is only user-settable to 'closed'. Setting it
 *        automatically writes `closed_at = NOW()` and requires
 *        `closed_price` to be present in the same body.
 *     2. Empty body (nothing to update) is rejected at the schema layer.
 *
 *   Threshold arrays may be cleared by sending an explicit `null`.
 *
 * DELETE /api/tracker/contracts/:id
 *   Hard-removes the row (cascade-deletes ticks + alerts via FK). Not
 *   currently exposed in the UI per spec, but kept here for cleanup.
 *
 * Both methods owner-or-guest gated.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { guardOwnerOrGuestEndpoint } from '../../_lib/api-helpers.js';
import { getDb } from '../../_lib/db.js';
import logger from '../../_lib/logger.js';
import { Sentry, metrics } from '../../_lib/sentry.js';
import {
  contractUpdateSchema,
  trackerIdParamSchema,
  type ContractUpdateBody,
} from '../../_lib/validation.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName(
      `${req.method ?? '??'} /api/tracker/contracts/[id]`,
    );
    const done = metrics.request('/api/tracker/contracts/[id]');

    if (req.method !== 'PATCH' && req.method !== 'DELETE') {
      done({ status: 405 });
      return res.status(405).json({ error: 'PATCH or DELETE only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const idParsed = trackerIdParamSchema.safeParse(req.query);
    if (!idParsed.success) {
      done({ status: 400 });
      return res.status(400).json({
        error: idParsed.error.issues[0]?.message ?? 'Invalid id',
      });
    }
    const { id } = idParsed.data;

    if (req.method === 'PATCH') {
      return handlePatch(req, res, id, done);
    }
    return handleDelete(res, id, done);
  });
}

// ============================================================
// PATCH — update one or more fields
// ============================================================

async function handlePatch(
  req: VercelRequest,
  res: VercelResponse,
  id: number,
  done: (opts: { status: number }) => void,
) {
  const parsed = contractUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    done({ status: 400 });
    return res.status(400).json({
      error: parsed.error.issues[0]?.message ?? 'Invalid request body',
      issues: parsed.error.issues,
    });
  }
  const data: ContractUpdateBody = parsed.data;

  // Close-flow guard: status='closed' requires closed_price.
  if (data.status === 'closed' && data.closed_price === undefined) {
    done({ status: 400 });
    return res.status(400).json({
      error: 'closed_price is required when setting status to closed',
    });
  }

  try {
    const sql = getDb();

    // For each updatable column we have three possible directives in
    // the request body:
    //   - field present, non-null → write new value
    //   - field present, null     → clear column (set NULL)
    //   - field absent (undefined) → preserve current via COALESCE
    //
    // Neon's tagged template doesn't support fragment composition, so
    // each column is encoded as a (clear?, value?) pair and a CASE
    // expression picks the right branch.

    const closeNow = data.status === 'closed';
    const spotAlertsJson =
      data.spot_alerts === undefined
        ? undefined
        : data.spot_alerts === null
          ? null
          : JSON.stringify(data.spot_alerts);

    const rows = await sql`
      UPDATE tracker_contracts
      SET
        notes = CASE
          WHEN ${data.notes === null}::boolean THEN NULL
          ELSE COALESCE(${data.notes ?? null}::text, notes)
        END,
        up_thresholds = CASE
          WHEN ${data.up_thresholds === null}::boolean THEN NULL
          ELSE COALESCE(
            ${data.up_thresholds ?? null}::numeric[],
            up_thresholds
          )
        END,
        down_thresholds = CASE
          WHEN ${data.down_thresholds === null}::boolean THEN NULL
          ELSE COALESCE(
            ${data.down_thresholds ?? null}::numeric[],
            down_thresholds
          )
        END,
        spot_alerts = CASE
          WHEN ${data.spot_alerts === null}::boolean THEN NULL
          ELSE COALESCE(${spotAlertsJson ?? null}::jsonb, spot_alerts)
        END,
        status = CASE
          WHEN ${closeNow}::boolean THEN 'closed'
          ELSE status
        END,
        closed_at = CASE
          WHEN ${closeNow}::boolean THEN NOW()
          ELSE closed_at
        END,
        closed_price = COALESCE(${data.closed_price ?? null}::numeric, closed_price),
        entry_price = COALESCE(${data.entry_price ?? null}::numeric, entry_price),
        quantity = COALESCE(${data.quantity ?? null}::int, quantity),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, occ_symbol, ticker,
                TO_CHAR(expiry, 'YYYY-MM-DD') AS expiry,
                strike, side, direction,
                entry_price, quantity, notes, status, closed_at, closed_price,
                up_thresholds, down_thresholds, spot_alerts,
                created_at, updated_at,
                NULL::numeric     AS latest_last,
                NULL::numeric     AS latest_bid,
                NULL::numeric     AS latest_ask,
                NULL::numeric     AS latest_underlying,
                NULL::timestamptz AS latest_fetched_at
    `;

    if (rows.length === 0) {
      done({ status: 404 });
      return res.status(404).json({ error: 'Contract not found' });
    }

    res.setHeader('Cache-Control', 'no-store');
    done({ status: 200 });
    return res.status(200).json({ contract: rows[0] });
  } catch (err) {
    done({ status: 500 });
    Sentry.captureException(err);
    logger.error({ err, id }, 'tracker-contracts patch error');
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ============================================================
// DELETE — hard-remove row (cascade ticks + alerts)
// ============================================================

async function handleDelete(
  res: VercelResponse,
  id: number,
  done: (opts: { status: number }) => void,
) {
  try {
    const sql = getDb();
    const rows = await sql`
      DELETE FROM tracker_contracts WHERE id = ${id} RETURNING id
    `;
    if (rows.length === 0) {
      done({ status: 404 });
      return res.status(404).json({ error: 'Contract not found' });
    }
    res.setHeader('Cache-Control', 'no-store');
    done({ status: 200 });
    return res.status(200).json({ deleted: id });
  } catch (err) {
    done({ status: 500 });
    Sentry.captureException(err);
    logger.error({ err, id }, 'tracker-contracts delete error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
