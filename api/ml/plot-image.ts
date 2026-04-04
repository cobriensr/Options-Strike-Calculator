/**
 * GET /api/ml/plot-image?name=correlations
 *
 * Proxy for private Vercel Blob plot images. Fetches the PNG
 * from the private store and streams it to the client with
 * ETag-based caching.
 *
 * Public read — no auth required (plot images are not sensitive).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { get } from '@vercel/blob';
import logger from '../_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const name = req.query.name;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Missing ?name= parameter' });
  }

  // Sanitize: only allow alphanumeric, underscore, hyphen
  if (!/^[\w-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid plot name' });
  }

  const blobPath = `ml-plots/latest/${name}.png`;

  try {
    const ifNoneMatch = req.headers['if-none-match'] ?? undefined;
    const result = await get(blobPath, {
      access: 'private',
      ifNoneMatch: typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined,
    });

    if (!result) {
      return res.status(404).json({ error: 'Plot not found' });
    }

    if (result.statusCode === 304) {
      res.setHeader('ETag', result.blob.etag);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(304).end();
    }

    res.setHeader('Content-Type', result.blob.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('ETag', result.blob.etag);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Pipe the stream to the response
    const reader = result.stream.getReader();
    const pump = async (): Promise<void> => {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        return;
      }
      res.write(value);
      return pump();
    };
    await pump();
  } catch (err) {
    logger.error({ err, blobPath }, 'Plot image proxy failed');
    return res.status(500).json({ error: 'Failed to fetch plot image' });
  }
}
