/**
 * Vercel Blob upload helper for /api/periscope-chat.
 *
 * Each Periscope read or debrief captures up to 3 PNGs:
 *   - chart  — the Periscope per-strike Gamma/Charm/Positions histogram
 *   - gex    — the Net GEX numeric heat map
 *   - charm  — the Net Charm numeric heat map
 *
 * Images are sent to Claude as base64 in the request body, but we also
 * persist them to Blob so the history viewer can render the actual chart
 * the model saw — not just the structured analysis.
 *
 * Best-effort by design: a failed upload is logged + Sentry-captured but
 * never throws. The endpoint's load-bearing artifact is the analysis row;
 * the images are nice-to-have for going back to a past read and seeing
 * what the chart looked like.
 *
 * Path shape: `periscope/{YYYY-MM-DD}/{HHmmss}/{kind}.png` (UTC throughout
 * — capturedAt is ISO/UTC, and the dashboard converts to ET at display
 * time). We pass `addRandomSuffix: true` to `put()` so Vercel Blob appends
 * a random hash to the stored key, which makes retries within the same
 * second idempotent (no "blob already exists" error on replay).
 *
 * Access mode: `'private'`. The strike-backups store is configured
 * private at the store level; mismatching access modes per-blob throws
 * BlobError. Dashboard rendering will need authenticated/signed-URL reads
 * via the existing list/get endpoints rather than direct `<img>` tags.
 *
 * Mirrors api/_lib/trace-live-blob.ts; kept separate because the path
 * prefix and the `kind` enum are domain-specific to Periscope.
 */

import { put } from '@vercel/blob';
import logger from './logger.js';
import { Sentry } from './sentry.js';

export type PeriscopeImageKind = 'chart' | 'gex' | 'charm';

export interface PeriscopeImage {
  /** Which view this is. */
  kind: PeriscopeImageKind;
  /** Base64 PNG bytes (no `data:` prefix). */
  base64: string;
}

/** Sparse result map — only successful uploads have URLs. */
export type PeriscopeImageUrls = Partial<Record<PeriscopeImageKind, string>>;

/**
 * Upload up to 3 Periscope chart/heat-map images to Vercel Blob in
 * parallel. Returns a sparse `{kind: url}` map for whichever uploads
 * succeeded. Per-image failures don't fail the batch — the caller still
 * gets the URLs that did succeed and can write them to the DB row.
 */
export async function uploadPeriscopeImages(args: {
  capturedAt: string;
  images: PeriscopeImage[];
}): Promise<PeriscopeImageUrls> {
  const { capturedAt, images } = args;

  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) {
    logger.error(
      { capturedAt },
      'uploadPeriscopeImages: invalid capturedAt — skipping all uploads',
    );
    return {};
  }
  const yyyymmdd = date.toISOString().slice(0, 10);
  const hh = date.getUTCHours().toString().padStart(2, '0');
  const mm = date.getUTCMinutes().toString().padStart(2, '0');
  const ss = date.getUTCSeconds().toString().padStart(2, '0');
  const prefix = `periscope/${yyyymmdd}/${hh}${mm}${ss}`;

  const results = await Promise.allSettled(
    images.map(async (img) => {
      const path = `${prefix}/${img.kind}.png`;
      const buffer = Buffer.from(img.base64, 'base64');
      const result = await put(path, buffer, {
        access: 'private',
        contentType: 'image/png',
        addRandomSuffix: true,
      });
      return { kind: img.kind, url: result.url };
    }),
  );

  const urls: PeriscopeImageUrls = {};
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const kind = images[i]!.kind;
    if (r.status === 'fulfilled') {
      urls[kind] = r.value.url;
    } else {
      logger.error(
        { kind, err: r.reason },
        'Periscope blob upload failed (best-effort, continuing)',
      );
      Sentry.captureException(r.reason);
    }
  }
  return urls;
}
