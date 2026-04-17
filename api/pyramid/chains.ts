/**
 * /api/pyramid/chains — pyramid trade tracker chain CRUD.
 *
 * Droppable experiment per docs/superpowers/specs/pyramid-tracker-2026-04-16.md.
 * Single-owner endpoint; every method is gated by `isOwner` via
 * `guardOwnerEndpoint`. Non-owner requests receive 401.
 *
 *   GET    /api/pyramid/chains            — list all chains (no legs)
 *   GET    /api/pyramid/chains?id=<id>    — single chain with its legs
 *   POST   /api/pyramid/chains            — create chain (Zod-validated body)
 *   PATCH  /api/pyramid/chains?id=<id>    — partial update; returns updated row
 *   DELETE /api/pyramid/chains?id=<id>    — delete chain; legs cascade via FK
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';
import {
  createChain,
  deleteChain,
  getChainWithLegs,
  getChains,
  updateChain,
} from '../_lib/db-pyramid.js';
import { pyramidChainSchema } from '../_lib/validation.js';
import logger from '../_lib/logger.js';

function getIdParam(req: VercelRequest): string | null {
  const { id } = req.query;
  if (typeof id === 'string' && id.length > 0) return id;
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/pyramid/chains');

  const method = req.method ?? 'GET';
  if (
    method !== 'GET' &&
    method !== 'POST' &&
    method !== 'PATCH' &&
    method !== 'DELETE'
  ) {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET, POST, PATCH, or DELETE only' });
  }

  const rejected = await guardOwnerEndpoint(req, res, done);
  if (rejected) return;

  try {
    if (method === 'GET') {
      const id = getIdParam(req);
      if (id !== null) {
        const row = await getChainWithLegs(id);
        if (row === null) {
          done({ status: 404 });
          return res.status(404).json({ error: 'not_found' });
        }
        done({ status: 200 });
        return res.status(200).json(row);
      }
      const chains = await getChains();
      done({ status: 200 });
      return res.status(200).json({ chains });
    }

    if (method === 'POST') {
      const parsed = pyramidChainSchema.safeParse(req.body);
      if (!parsed.success) {
        done({ status: 400 });
        const firstError = parsed.error.issues[0];
        return res.status(400).json({
          error: firstError?.message ?? 'Invalid request body',
        });
      }
      const created = await createChain(parsed.data);
      done({ status: 200 });
      return res.status(200).json(created);
    }

    if (method === 'PATCH') {
      const id = getIdParam(req);
      if (id === null) {
        done({ status: 400 });
        return res.status(400).json({ error: 'id query param required' });
      }
      // Accept any partial chain body. We can't use pyramidChainSchema directly
      // because it requires `id`; build a partial-variant here.
      const parsed = pyramidChainSchema.partial().safeParse(req.body ?? {});
      if (!parsed.success) {
        done({ status: 400 });
        const firstError = parsed.error.issues[0];
        return res.status(400).json({
          error: firstError?.message ?? 'Invalid request body',
        });
      }
      const updated = await updateChain(id, parsed.data);
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
    const deleted = await deleteChain(id);
    if (!deleted) {
      done({ status: 404 });
      return res.status(404).json({ error: 'not_found' });
    }
    done({ status: 200 });
    return res.status(200).json({ ok: true });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'pyramid chains endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
