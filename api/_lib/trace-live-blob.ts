/**
 * Vercel Blob upload helper for /api/trace-live-analyze.
 *
 * Each tick captures three PNGs (gamma, charm, delta heatmaps). They're
 * sent to Claude as base64 in the request body, but we also persist them
 * to Blob so the dashboard's historical mode can render the actual chart
 * the model saw — not just the structured analysis.
 *
 * Best-effort by design: a failed upload is logged + Sentry-captured but
 * never throws. The endpoint's load-bearing artifact is the analysis row;
 * the images are nice-to-have for going back to last Tuesday and seeing
 * what the chart looked like.
 *
 * Path shape: `trace-live/{YYYY-MM-DD}/{HHmm}/{chart}.png` (UTC throughout
 * — capturedAt is ISO/UTC, and the dashboard converts to ET at display
 * time). We pass `addRandomSuffix: true` to `put()` so Vercel Blob appends
 * a random hash to the stored key — that gives owner-only-data privacy via
 * unguessable URLs (we use `access: 'public'` so the dashboard can render
 * via a plain `<img>` without signing roundtrips) AND makes retries for
 * the same minute idempotent (no "blob already exists" error on replay).
 *
 * Note: as of @vercel/blob@2.x, `put()` defaults `addRandomSuffix` to
 * false — the inverse of `putUploadStream` and other helpers in the same
 * package. We must opt in explicitly.
 */

import { put } from '@vercel/blob';
import logger from './logger.js';
import { Sentry } from './sentry.js';

export type TraceChart = 'gamma' | 'charm' | 'delta';

export interface TraceLiveImage {
  /** Which chart this is. */
  chart: TraceChart;
  /** Base64 PNG bytes (no `data:` prefix). */
  base64: string;
}

/** Sparse result map — only successful uploads have URLs. */
export type TraceLiveImageUrls = Partial<Record<TraceChart, string>>;

/**
 * Upload up to 3 TRACE chart images to Vercel Blob in parallel.
 * Returns a sparse `{chart: url}` map for whichever uploads succeeded.
 * Per-chart failures don't fail the batch — the caller still gets the
 * URLs that did succeed and can write them to the DB row.
 */
export async function uploadTraceLiveImages(args: {
  capturedAt: string;
  images: TraceLiveImage[];
}): Promise<TraceLiveImageUrls> {
  const { capturedAt, images } = args;

  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) {
    logger.error(
      { capturedAt },
      'uploadTraceLiveImages: invalid capturedAt — skipping all uploads',
    );
    return {};
  }
  const yyyymmdd = date.toISOString().slice(0, 10);
  const hh = date.getUTCHours().toString().padStart(2, '0');
  const mm = date.getUTCMinutes().toString().padStart(2, '0');
  const prefix = `trace-live/${yyyymmdd}/${hh}${mm}`;

  const results = await Promise.allSettled(
    images.map(async (img) => {
      const path = `${prefix}/${img.chart}.png`;
      const buffer = Buffer.from(img.base64, 'base64');
      const result = await put(path, buffer, {
        access: 'public',
        contentType: 'image/png',
        addRandomSuffix: true,
      });
      return { chart: img.chart, url: result.url };
    }),
  );

  const urls: TraceLiveImageUrls = {};
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const chart = images[i]!.chart;
    if (r.status === 'fulfilled') {
      urls[chart] = r.value.url;
    } else {
      logger.error(
        { chart, err: r.reason },
        'TRACE-live blob upload failed (best-effort, continuing)',
      );
      Sentry.captureException(r.reason);
    }
  }
  return urls;
}
