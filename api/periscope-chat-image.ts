/**
 * GET /api/periscope-chat-image?id=N&kind=chart|gex|charm
 *
 * Proxies a Periscope chart screenshot stored in the private
 * `strike-backups` Vercel Blob store. Frontend can't render private
 * blob URLs directly (browser has no auth token), so this endpoint
 * uses the server-side BLOB_READ_WRITE_TOKEN to fetch the bytes and
 * streams them back as image/png.
 *
 * Mirrors api/trace-live-image.ts. The Periscope image_urls column
 * stores an array of {kind, url} objects (rather than the trace-live
 * sparse object), so the lookup is `find by kind` instead of
 * `index by chart`.
 *
 * Authorization: owner-only. Same posture as the rest of the
 * periscope-chat-* family.
 *
 * Rate limit: 240/min — three images per row times rapid history
 * browsing adds up. Strong browser caching (private, immutable, 1d)
 * keeps the practical hit rate low.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerEndpoint, rejectIfRateLimited } from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';
import { Sentry, metrics } from './_lib/sentry.js';

interface PeriscopeImageEntry {
  kind: string;
  url: string;
}

const VALID_KINDS = ['chart', 'gex', 'charm'] as const;
type PeriscopeImageKind = (typeof VALID_KINDS)[number];

function isValidKind(v: string): v is PeriscopeImageKind {
  return (VALID_KINDS as readonly string[]).includes(v);
}

function parseJsonbField<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/periscope-chat-image');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'periscope-chat-image',
    240,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  const { id, kind } = req.query;
  const idStr = typeof id === 'string' ? id : null;
  const kindStr = typeof kind === 'string' ? kind : null;

  if (!idStr || !/^\d+$/.test(idStr)) {
    done({ status: 400 });
    return res.status(400).json({ error: 'Provide ?id=N (integer)' });
  }
  if (!kindStr || !isValidKind(kindStr)) {
    done({ status: 400 });
    return res.status(400).json({ error: 'Provide ?kind=chart|gex|charm' });
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    done({ status: 500, error: 'missing_token' });
    logger.error('BLOB_READ_WRITE_TOKEN not set — cannot proxy blob');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT image_urls
      FROM periscope_analyses
      WHERE id = ${idStr}
      LIMIT 1
    `;

    if (rows.length === 0) {
      done({ status: 404 });
      return res.status(404).json({ error: 'Read not found' });
    }

    const images =
      parseJsonbField<PeriscopeImageEntry[]>(rows[0]!.image_urls) ?? [];
    const entry = images.find((e) => e.kind === kindStr);

    if (!entry) {
      done({ status: 404 });
      return res
        .status(404)
        .json({ error: `No ${kindStr} image stored for this row` });
    }

    // Fetch the private blob with the read-write token. Vercel Blob
    // accepts the token via Authorization: Bearer on private reads.
    const blobResp = await fetch(entry.url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!blobResp.ok || !blobResp.body) {
      done({ status: 502, error: 'blob_fetch' });
      logger.error(
        { status: blobResp.status, url: entry.url.slice(0, 100) },
        'Failed to fetch periscope blob from store',
      );
      return res.status(502).json({ error: 'Failed to fetch image' });
    }

    // The blob path includes a random suffix (set at upload time), so
    // the same id+kind always resolves to the same immutable bytes —
    // safe to cache aggressively at the browser.
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    const contentLength = blobResp.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const buf = Buffer.from(await blobResp.arrayBuffer());
    res.status(200).end(buf);
    done({ status: 200 });
    return;
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'periscope-chat-image endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
