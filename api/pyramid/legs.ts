/**
 * /api/pyramid/legs — pyramid trade tracker leg CRUD.
 *
 * Droppable experiment per docs/superpowers/specs/pyramid-tracker-2026-04-16.md.
 * Owner-only via `guardOwnerEndpoint`. Legs are listed by the parent chain
 * via `GET /api/pyramid/chains?id=<id>`; there is no GET here.
 *
 *   POST   /api/pyramid/legs            — create leg (Zod-validated body)
 *   PATCH  /api/pyramid/legs?id=<id>    — partial update; returns updated row
 *   DELETE /api/pyramid/legs?id=<id>    — delete single leg
 *
 * Inserting leg N>1 before leg 1 exists is rejected with HTTP 409 Conflict
 * `{ error: 'leg_1_missing' }` — db-pyramid throws `PyramidLegOrderError`
 * in that case to keep `stop_compression_ratio` from being permanently null.
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';
import {
  createLeg,
  deleteLeg,
  PyramidLegOrderError,
  updateLeg,
} from '../_lib/db-pyramid.js';
import { pyramidLegSchema } from '../_lib/validation.js';
import logger from '../_lib/logger.js';

function getIdParam(req: VercelRequest): string | null {
  const { id } = req.query;
  if (typeof id === 'string' && id.length > 0) return id;
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/pyramid/legs');

  const method = req.method ?? 'GET';
  if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST, PATCH, or DELETE only' });
  }

  const rejected = await guardOwnerEndpoint(req, res, done);
  if (rejected) return;

  try {
    if (method === 'POST') {
      const parsed = pyramidLegSchema.safeParse(req.body);
      if (!parsed.success) {
        done({ status: 400 });
        const firstError = parsed.error.issues[0];
        return res.status(400).json({
          error: firstError?.message ?? 'Invalid request body',
        });
      }
      try {
        const created = await createLeg(parsed.data);
        done({ status: 200 });
        return res.status(200).json(created);
      } catch (err) {
        if (err instanceof PyramidLegOrderError) {
          done({ status: 409 });
          return res.status(409).json({ error: 'leg_1_missing' });
        }
        throw err;
      }
    }

    if (method === 'PATCH') {
      const id = getIdParam(req);
      if (id === null) {
        done({ status: 400 });
        return res.status(400).json({ error: 'id query param required' });
      }
      const parsed = pyramidLegSchema.partial().safeParse(req.body ?? {});
      if (!parsed.success) {
        done({ status: 400 });
        const firstError = parsed.error.issues[0];
        return res.status(400).json({
          error: firstError?.message ?? 'Invalid request body',
        });
      }
      const updated = await updateLeg(id, parsed.data);
      if (updated === null) {
        done({ status: 404 });
        return res.status(404).json({ error: 'not_found' });
      }
      done({ status: 200 });
      return res.status(200).json(updated);
    }

    // DELETE
    const id = getIdParam(req);
    if (id === null) {
      done({ status: 400 });
      return res.status(400).json({ error: 'id query param required' });
    }
    const deleted = await deleteLeg(id);
    if (!deleted) {
      done({ status: 404 });
      return res.status(404).json({ error: 'not_found' });
    }
    done({ status: 200 });
    return res.status(200).json({ ok: true });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'pyramid legs endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
