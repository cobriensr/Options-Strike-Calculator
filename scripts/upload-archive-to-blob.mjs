#!/usr/bin/env node

/**
 * Upload the Databento DBN→Parquet archive to Vercel Blob so the
 * Railway sidecar can seed its persistent volume from it.
 *
 * Source:  ml/data/archive/  (produced by ml/src/archive_convert.py
 *          and ml/src/tbbo_convert.py)
 * Target:  archive/v1/<relative-path> on Vercel Blob (private access;
 *          matches this project's Blob store configuration).
 * Output:  archive/v1/manifest.json listing every uploaded file with
 *          size, SHA-256, and Blob URL for the sidecar seeder.
 *
 * Subtrees uploaded (see `ARCHIVE_SUBTREES` below):
 *   - `ohlcv_1m/year=YYYY/part.parquet` (Phase 2 OHLCV archive)
 *   - `tbbo/year=YYYY/part.parquet` (Phase 4a TBBO archive, Phase 4b distribute)
 *   - `symbology.parquet` (instrument_id → symbol mapping)
 *   - `condition.json`, `tbbo_condition.json` (degraded-day flags)
 *   - `convert_summary.json`, `tbbo_convert_summary.json` (converter metadata)
 *
 * Why list subtrees explicitly: the seeder walks whatever the manifest
 * lists, so silent additions (e.g. a half-written partial conversion
 * left in `ml/data/archive/wip/`) would be uploaded without review.
 * Declaring the allowed subtrees makes additions an explicit choice.
 *
 * Why private access: the project's Blob store is configured as private,
 * so every put() must match. The sidecar reads with BLOB_READ_WRITE_TOKEN
 * passed through Railway env vars (same token this script uses to upload).
 *
 * Why SHA-256 per file: the sidecar seeder uses it to (1) resume partial
 * seeds and (2) verify integrity on every download. A mismatch fails
 * loud rather than silently corrupting the volume.
 *
 * Usage:
 *   source .env.local && node scripts/upload-archive-to-blob.mjs
 *
 * Optional env:
 *   ARCHIVE_SRC     — override source dir (default: ml/data/archive)
 *   CONCURRENCY     — parallel uploads (default: 3; Blob latency is
 *                     bytes-over-wire dominated, so little to gain > 3)
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import process from 'node:process';

import { put } from '@vercel/blob';

// ── Config ─────────────────────────────────────────────────────────

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const ARCHIVE_SRC = process.env.ARCHIVE_SRC ?? 'ml/data/archive';
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY ?? '3', 10);
const BLOB_PREFIX = 'archive/v1';
const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Subtrees / files under ARCHIVE_SRC that get uploaded. Directories
 * are walked recursively; single files are uploaded as-is. Anything
 * under ARCHIVE_SRC NOT listed here is skipped.
 *
 * Missing entries are tolerated (e.g. a laptop that only ran the OHLCV
 * converter won't have `tbbo/` yet). The script logs and moves on.
 */
const ARCHIVE_SUBTREES = [
  { name: 'ohlcv_1m', kind: 'dir' },
  { name: 'tbbo', kind: 'dir' },
  { name: 'symbology.parquet', kind: 'file' },
  { name: 'convert_summary.json', kind: 'file' },
  { name: 'tbbo_convert_summary.json', kind: 'file' },
  { name: 'condition.json', kind: 'file' },
  { name: 'tbbo_condition.json', kind: 'file' },
];

if (!BLOB_TOKEN) {
  console.error('Missing BLOB_READ_WRITE_TOKEN (source .env.local first)');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────

/** Walk a directory recursively, returning absolute file paths. */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/** Content-Type heuristic; Blob stores this for downstream tooling. */
function contentTypeFor(relPath) {
  if (relPath.endsWith('.parquet')) return 'application/vnd.apache.parquet';
  if (relPath.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

/** Human-readable byte count. */
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Upload a single file, returning its manifest entry. */
async function uploadFile(absPath, srcRoot) {
  const relPath = relative(srcRoot, absPath);
  const blobPath = `${BLOB_PREFIX}/${relPath}`;
  const bytes = await readFile(absPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const result = await put(blobPath, bytes, {
    access: 'private',
    allowOverwrite: true,
    contentType: contentTypeFor(relPath),
    token: BLOB_TOKEN,
  });

  return {
    path: relPath,
    size: bytes.length,
    sha256,
    blob_url: result.url,
    content_type: contentTypeFor(relPath),
  };
}

/** Run an async task per input with bounded concurrency. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function next() {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    await next();
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, next);
  await Promise.all(runners);
  return results;
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const srcStat = await stat(ARCHIVE_SRC).catch(() => null);
  if (!srcStat || !srcStat.isDirectory()) {
    console.error(`Source dir not found: ${ARCHIVE_SRC}`);
    process.exit(1);
  }

  console.log(
    `Scanning ${ARCHIVE_SRC} (subtrees: ${ARCHIVE_SUBTREES.map((s) => s.name).join(', ')})...`,
  );

  const files = [];
  for (const entry of ARCHIVE_SUBTREES) {
    const absPath = join(ARCHIVE_SRC, entry.name);
    const entryStat = await stat(absPath).catch(() => null);
    if (!entryStat) {
      console.log(`  (skipped — not present: ${entry.name})`);
      continue;
    }
    if (entry.kind === 'dir') {
      if (!entryStat.isDirectory()) {
        console.warn(`  Expected directory but got file: ${entry.name}`);
        continue;
      }
      files.push(...(await walk(absPath)));
    } else {
      if (!entryStat.isFile()) {
        console.warn(`  Expected file but got directory: ${entry.name}`);
        continue;
      }
      files.push(absPath);
    }
  }
  // Stable ordering makes the manifest diff-friendly across re-runs.
  files.sort();

  if (files.length === 0) {
    console.error('No files found in any configured subtree — aborting.');
    process.exit(1);
  }

  const totalBytes = (
    await Promise.all(files.map(async (f) => (await stat(f)).size))
  ).reduce((a, b) => a + b, 0);

  console.log(
    `Found ${files.length} files, ${formatBytes(totalBytes)} total. Uploading with concurrency=${CONCURRENCY}...\n`,
  );

  let completed = 0;
  let uploadedBytes = 0;
  const start = Date.now();

  const entries = await mapLimit(files, CONCURRENCY, async (absPath) => {
    const t0 = Date.now();
    const entry = await uploadFile(absPath, ARCHIVE_SRC);
    completed += 1;
    uploadedBytes += entry.size;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const pct = ((completed / files.length) * 100).toFixed(0);
    console.log(
      `  [${pct}%] ${entry.path} — ${formatBytes(entry.size)} in ${elapsed}s`,
    );
    return entry;
  });

  // Upload the manifest LAST so its presence implies a complete archive.
  const manifest = {
    schema: MANIFEST_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    total_bytes: uploadedBytes,
    file_count: entries.length,
    files: entries,
  };

  const manifestPath = `${BLOB_PREFIX}/manifest.json`;
  const manifestResult = await put(
    manifestPath,
    JSON.stringify(manifest, null, 2),
    {
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/json',
      token: BLOB_TOKEN,
    },
  );

  const totalElapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\n✓ Uploaded ${entries.length} files (${formatBytes(uploadedBytes)}) in ${totalElapsed}s`,
  );
  console.log(`\nManifest URL:\n  ${manifestResult.url}\n`);
  console.log('Next step — set this as ARCHIVE_MANIFEST_URL in Railway:');
  console.log(
    `  railway variables --set ARCHIVE_MANIFEST_URL=${manifestResult.url}`,
  );
}

try {
  await main();
} catch (err) {
  console.error('Upload failed:', err);
  process.exit(1);
}
