// scripts/takeit-rollback.mjs
// Usage:
//   make takeit-rollback                                       (show current manifest)
//   make takeit-rollback FEED=lottery PATH_OVERRIDE=takeit/lottery-vYYYY-MM-DD.json
//   make takeit-rollback FEED=silentboom PATH_OVERRIDE=takeit/silentboom-vYYYY-MM-DD.json
//
// The bundle loader reads takeit/latest.json from Vercel Blob to discover
// the active bundle paths. This script reads-modifies-writes that manifest
// so the next cron tick (within 15 min — the loader's cache TTL) picks up
// the rollback target.
//
// Pre-flight: source .env.local so BLOB_READ_WRITE_TOKEN is exported.

import { list, put } from '@vercel/blob';

const MANIFEST_KEY = 'takeit/latest.json';

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error('BLOB_READ_WRITE_TOKEN not set — source .env.local first');
  process.exit(1);
}

const feed = process.env.FEED;
const newPath = process.env.PATH_OVERRIDE;
const dryRun = process.env.DRY_RUN === '1';

const listed = await list({ prefix: MANIFEST_KEY, token, limit: 1 });
const entry = listed.blobs.find((b) => b.pathname === MANIFEST_KEY);
if (!entry) {
  console.error(`Manifest not found at ${MANIFEST_KEY}`);
  process.exit(1);
}

const res = await fetch(entry.downloadUrl, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.error(`Failed to fetch manifest: ${res.status}`);
  process.exit(1);
}
const manifest = await res.json();

console.log('Current manifest:');
console.log(JSON.stringify(manifest, null, 2));

if (!feed && !newPath) {
  // Read-only mode: print and exit.
  process.exit(0);
}

if (!feed || !['lottery', 'silentboom'].includes(feed)) {
  console.error('FEED must be "lottery" or "silentboom"');
  process.exit(1);
}
if (!newPath) {
  console.error('PATH_OVERRIDE not set (the bundle path to flip to)');
  process.exit(1);
}

const updated = {
  ...manifest,
  [feed]: newPath,
  rolled_back_at: new Date().toISOString(),
};
console.log('\nUpdated manifest:');
console.log(JSON.stringify(updated, null, 2));

if (dryRun) {
  console.log('\nDRY_RUN=1 set — not writing.');
  process.exit(0);
}

const body = new Blob([JSON.stringify(updated, null, 2)], {
  type: 'application/json',
});
// Manifest is stored as a PRIVATE blob in the strike-calculator Vercel Blob
// store; bundle bodies are private too. Read paths use Authorization: Bearer
// on the downloadUrl; writes use access: 'private' on put().
const result = await put(MANIFEST_KEY, body, {
  access: 'private',
  contentType: 'application/json',
  addRandomSuffix: false,
  allowOverwrite: true,
  token,
});
console.log(`\nWrote new manifest to ${result.url}`);
console.log('New bundle picks up on next cron tick (cache TTL = 15 min).');
