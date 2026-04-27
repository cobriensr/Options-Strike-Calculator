/**
 * GET /api/trace-live-image?id=N&chart=gamma|charm|delta
 *
 * Proxies a TRACE Live chart image stored in the private `strike-backups`
 * Vercel Blob store. The frontend can't render private blob URLs directly
 * (browser has no auth token), so this endpoint uses the server-side
 * BLOB_READ_WRITE_TOKEN to fetch the bytes and streams them back as
 * `image/png`.
 *
 * Why this exists: when trace-live-blob.ts switched from access:'public'
 * to access:'private' (commit 8a3211f, to match the strike-backups store
 * config), `<img src={blobUrl}>` stopped rendering. The blob URLs in
 * trace_live_analyses.image_urls are now only resolvable with the
 * blob-store auth token. This endpoint is the authenticated reader.
 *
 * Authorization: owner cookie + BotID via guardOwnerEndpoint. Rate
 * limited to 240/min — three images per analysis row × multiple rows
 * during normal browsing × revisits add up. Strong browser caching
 * (immutable, 1d) keeps the practical hit rate low.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerEndpoint, rejectIfRateLimited } from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';
import { Sentry, metrics } from './_lib/sentry.js';
import type { TraceLiveImageUrls, TraceChart } from './_lib/trace-live-blob.js';

const VALID_CHARTS: TraceChart[] = ['gamma', 'charm', 'delta'];

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
  const done = metrics.request('/api/trace-live-image');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'trace-live-image',
    240,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  const { id, chart } = req.query;
  const idStr = typeof id === 'string' ? id : null;
  const chartStr = typeof chart === 'string' ? chart : null;

  if (!idStr || !/^\d+$/.test(idStr)) {
    done({ status: 400 });
    return res.status(400).json({ error: 'Provide ?id=N (integer)' });
  }
  if (!chartStr || !VALID_CHARTS.includes(chartStr as TraceChart)) {
    done({ status: 400 });
    return res.status(400).json({
      error: 'Provide ?chart=gamma|charm|delta',
    });
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
      FROM trace_live_analyses
      WHERE id = ${idStr}
      LIMIT 1
    `;

    if (rows.length === 0) {
      done({ status: 404 });
      return res.status(404).json({ error: 'Analysis not found' });
    }

    const imageUrls =
      parseJsonbField<TraceLiveImageUrls>(rows[0]!.image_urls) ?? {};
    const url = imageUrls[chartStr as TraceChart];

    if (!url) {
      done({ status: 404 });
      return res
        .status(404)
        .json({ error: `No ${chartStr} image stored for this analysis` });
    }

    // Fetch the private blob with the read-write token. Vercel Blob
    // accepts the token via Authorization: Bearer for private-store reads.
    const blobResp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!blobResp.ok || !blobResp.body) {
      done({ status: 502, error: 'blob_fetch' });
      logger.error(
        { status: blobResp.status, url: url.slice(0, 100) },
        'Failed to fetch blob from store',
      );
      return res.status(502).json({ error: 'Failed to fetch image' });
    }

    // Stream the bytes back. The blob is immutable once written — random
    // suffix on the path means the same id+chart always resolves to the
    // same blob — so we can cache aggressively. 1 day is conservative;
    // could push to a year with `immutable`.
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    const contentLength = blobResp.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const buf = Buffer.from(await blobResp.arrayBuffer());
    res.status(200).end(buf);
    done({ status: 200 });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'trace-live-image endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
