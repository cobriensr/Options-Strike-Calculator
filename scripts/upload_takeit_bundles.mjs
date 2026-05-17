#!/usr/bin/env node
/**
 * One-shot script — upload the lottery + silentboom takeit bundles to
 * Vercel Blob and write the `takeit/latest.json` manifest that the
 * runtime loader reads first.
 *
 * Run from the repo root after `vercel env pull .env.local`:
 *
 *   set -a && source .env.local && set +a && \
 *   node scripts/upload_takeit_bundles.mjs
 *
 * Spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md
 *
 * Idempotent for the manifest (uses addRandomSuffix: false, replaces in
 * place). Versioned bundle paths embed the bundle.version string so an
 * older bundle can always be re-pinned by hand-editing the manifest.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { put } from '@vercel/blob';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_DIR = resolve(REPO_ROOT, 'ml/data/takeit');
const ALERT_TYPES = ['lottery', 'silentboom'];
const MANIFEST_PATH = 'takeit/latest.json';

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error(
    'ERROR: BLOB_READ_WRITE_TOKEN env var not set.\n' +
      '  Run: set -a && source .env.local && set +a',
  );
  process.exit(1);
}

async function uploadBundle(alertType) {
  const bundlePath = resolve(BUNDLE_DIR, `${alertType}_classifier.json`);
  if (!existsSync(bundlePath)) {
    throw new Error(
      `bundle missing at ${bundlePath}; regenerate with: ml/.venv/bin/python -m ml.src.takeit.train`,
    );
  }
  const raw = readFileSync(bundlePath, 'utf8');
  const bundle = JSON.parse(raw);
  const version = bundle.version;
  if (!version) {
    throw new Error(`bundle at ${bundlePath} missing version field`);
  }
  const remotePath = `takeit/${alertType}_classifier_${version}.json`;
  console.log(`uploading ${alertType} ${version} (${(raw.length / 1024 / 1024).toFixed(1)}MB) → ${remotePath}`);
  const result = await put(remotePath, raw, {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false, // deterministic path for rollback by manifest swap
    allowOverwrite: true,
  });
  console.log(`  ✓ ${result.url}`);

  // Phase 3d sidecar SHAP path: shap.TreeExplainer needs the live Python
  // objects (XGBClassifier + IsotonicRegression), which the JSON dump alone
  // can't reconstruct losslessly. We upload the joblib (Python pickle) so
  // the sidecar can re-hydrate them. Trust model is closed-loop: WE produce
  // the joblib in our own GH Actions workflow, push it to OUR private
  // Blob, and OUR sidecar code loads it — never accepting an external
  // joblib. Standard ML deploy pattern.
  const joblibPath = resolve(BUNDLE_DIR, `${alertType}_classifier.joblib`);
  if (existsSync(joblibPath)) {
    const joblibBytes = readFileSync(joblibPath);
    const joblibRemotePath = `takeit/${alertType}_joblib_${version}.joblib`;
    console.log(
      `uploading ${alertType} joblib ${version} (${(joblibBytes.length / 1024 / 1024).toFixed(1)}MB) → ${joblibRemotePath}`,
    );
    const joblibResult = await put(joblibRemotePath, joblibBytes, {
      access: 'private',
      contentType: 'application/octet-stream',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    console.log(`  ✓ ${joblibResult.url}`);
  } else {
    console.log(`  ⚠ ${alertType} joblib missing — SHAP sidecar will 503 until uploaded`);
  }

  return { alertType, remotePath, version, url: result.url };
}

async function uploadManifest(entries) {
  const manifest = {};
  for (const e of entries) {
    manifest[e.alertType] = e.remotePath;
  }
  const body = JSON.stringify(manifest, null, 2);
  console.log(`uploading manifest → ${MANIFEST_PATH}`);
  console.log(`  ${body.replace(/\n/g, '\n  ')}`);
  const result = await put(MANIFEST_PATH, body, {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  console.log(`  ✓ ${result.url}`);
  return result;
}

async function main() {
  const uploaded = [];
  for (const alertType of ALERT_TYPES) {
    uploaded.push(await uploadBundle(alertType));
  }
  await uploadManifest(uploaded);
  console.log('\ndone. Vercel functions will pick up the new bundle on next cold start.');
}

main().catch((err) => {
  console.error('upload failed:', err.message);
  process.exit(1);
});
