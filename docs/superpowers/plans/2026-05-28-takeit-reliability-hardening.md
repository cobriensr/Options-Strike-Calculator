# TAKE-IT Reliability Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Files here are large and live (parallel sessions edit them) — RE-READ each file before editing and locate the documented anchors rather than trusting line numbers.

**Goal:** Harden TAKE-IT scoring against operational outages, data drift, and slow model decay — defensively (reject bad inputs and bundles), operationally (make silent failures loud), analytically (catch decay before live edge does), and retrospectively (backfill `takeit_prob` on historical rows for ML training).

**Architecture:** Four phases sharing a daily-cron + Sentry-alert backbone and one new `takeit_health_daily` Postgres table. Phase 1 hardens the existing scoring path in place (Zod-validated bundle load, NaN/Infinity input guards, manifest pointer for fast rollback). Phase 2 adds a daily TS cron that surfaces operational drift. Phase 3 folds an ML drift monitor into the existing `make nightly update` pipeline. Phase 4 ships a one-shot TS backfill tool that reuses production scoring code (parity-safe).

**Tech Stack:** TypeScript (Node 24 / Vercel Functions / Fluid Compute), Neon Postgres (`@neondatabase/serverless`), Vercel Blob (`@vercel/blob`), Vitest, Zod v4. Python 3 (`ml/.venv`) + `psycopg2-binary` + `scikit-learn` + `matplotlib` + `pytest`. GNU Make.

**Reference spec:** `docs/superpowers/specs/2026-05-28-takeit-reliability-hardening.md`

**Cross-cutting constants:**

- `BUNDLE_FETCH_MAX_RETRIES = 2`, backoffs `200ms / 800ms`
- Phase 2 thresholds: `NULL_RATE_ALERT_PCT = 5.0`, `PROB_P50_DRIFT_MAX = 0.05`, `BUNDLE_VERSION_MAX_PER_DAY = 1`
- Phase 3 thresholds: `ROLLING_AUC_DROP_MAX = 0.05`, `PER_SEGMENT_AUC_MIN = 0.55` at `min_n = 100`, `FEATURE_Z_ALERT = 3.0`, `SHAP_RESHUFFLE_TOP3_MAX = 1`
- Phase 4: batch size `2000`, `LIMIT` overridable via `make takeit-backfill LIMIT=N`

---

## PHASE 1 — Defensive scoring + bundle reliability

Ships first. The largest production-risk reduction.

### Task 1.1: Zod-validated bundle schema

The existing `assertBundleCompat()` at `api/_lib/takeit-score.ts:105` only validates `xgb_json_schema`. Extend coverage to the full bundle shape via a Zod schema. Reuse the existing `BundleSchemaError`.

**Files:**
- Create: `api/_lib/takeit-bundle-schema.ts`
- Modify: `api/_lib/takeit-score.ts` (route `assertBundleCompat` through the Zod schema)
- Test: `api/__tests__/takeit-bundle-schema.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// api/__tests__/takeit-bundle-schema.test.ts
import { describe, it, expect } from 'vitest';
import {
  TakeitBundleSchema,
  validateBundle,
} from '../_lib/takeit-bundle-schema.js';
import { BundleSchemaError } from '../_lib/takeit-score.js';

const minimalValidBundle = {
  version: 'v2026-05-16',
  alert_type: 'lottery' as const,
  trained_on_date: '2026-05-16',
  win_label_threshold_pct: 20,
  xgb_json_schema: '2.1',
  feature_cols: ['dte', 'trigger_vol_to_oi_window'],
  top_tickers: ['SPY', 'QQQ'],
  categorical_cols: ['option_type'],
  feature_derivation_constants: { AGGRESSIVE_ASK_PCT_THRESHOLD: 0.7 },
  xgb_model: {
    learner: {
      learner_model_param: { base_score: '0.5' },
      gradient_booster: {
        model: {
          trees: [
            {
              left_children: [-1],
              right_children: [-1],
              split_indices: [0],
              split_conditions: [0.5],
              default_left: [1],
              base_weights: [0.1],
            },
          ],
        },
      },
    },
  },
  isotonic: {
    x_thresholds: [0, 0.5, 1],
    y_thresholds: [0, 0.5, 1],
  },
};

describe('validateBundle', () => {
  it('accepts a minimal valid bundle', () => {
    expect(() => validateBundle(minimalValidBundle)).not.toThrow();
  });

  it('throws BundleSchemaError on a missing required field', () => {
    const broken = { ...minimalValidBundle } as Record<string, unknown>;
    delete broken.feature_cols;
    expect(() => validateBundle(broken)).toThrow(BundleSchemaError);
  });

  it('throws BundleSchemaError when isotonic arrays have different lengths', () => {
    const broken = {
      ...minimalValidBundle,
      isotonic: { x_thresholds: [0, 1], y_thresholds: [0, 0.5, 1] },
    };
    expect(() => validateBundle(broken)).toThrow(BundleSchemaError);
  });

  it('throws BundleSchemaError when the trees array is empty', () => {
    const broken = {
      ...minimalValidBundle,
      xgb_model: {
        learner: {
          learner_model_param: { base_score: '0.5' },
          gradient_booster: { model: { trees: [] } },
        },
      },
    };
    expect(() => validateBundle(broken)).toThrow(BundleSchemaError);
  });

  it('throws BundleSchemaError on unknown alert_type', () => {
    const broken = { ...minimalValidBundle, alert_type: 'something_else' };
    expect(() => validateBundle(broken)).toThrow(BundleSchemaError);
  });

  it('accepts optional metrics_snapshot', () => {
    const withMetrics = {
      ...minimalValidBundle,
      metrics_snapshot: { oof_auc: 0.77, n_train_rows: 1000 },
    };
    expect(() => validateBundle(withMetrics)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run api/__tests__/takeit-bundle-schema.test.ts`
Expected: FAIL — module `../_lib/takeit-bundle-schema.js` not found.

- [ ] **Step 3: Write the schema**

```ts
// api/_lib/takeit-bundle-schema.ts
// Zod schema for the TakeitBundle JSON shape. Validation is fail-closed:
// any bundle that doesn't conform throws BundleSchemaError. Used at load
// time by api/_lib/takeit-bundle-loader.ts BEFORE any row is scored.

import { z } from 'zod';
import { BundleSchemaError } from './takeit-score.js';

const XGBTreeSchema = z.object({
  left_children: z.array(z.number()),
  right_children: z.array(z.number()),
  split_indices: z.array(z.number()),
  split_conditions: z.array(z.number()),
  default_left: z.array(z.number()),
  base_weights: z.array(z.number()),
  split_type: z.array(z.number()).optional(),
});

const IsotonicSplineSchema = z
  .object({
    x_thresholds: z.array(z.number()),
    y_thresholds: z.array(z.number()),
    out_of_bounds: z.enum(['clip', 'nan']).optional(),
  })
  .refine((s) => s.x_thresholds.length === s.y_thresholds.length, {
    message: 'isotonic.x_thresholds and y_thresholds must have equal length',
  })
  .refine((s) => s.x_thresholds.length >= 2, {
    message: 'isotonic spline needs at least 2 thresholds',
  });

export const TakeitBundleSchema = z.object({
  version: z.string().min(1),
  alert_type: z.enum(['lottery', 'silentboom']),
  trained_on_date: z.string().min(1),
  win_label_threshold_pct: z.number(),
  xgb_json_schema: z.string().min(1),
  feature_cols: z.array(z.string().min(1)).min(1),
  top_tickers: z.array(z.string()),
  categorical_cols: z.array(z.string()),
  feature_derivation_constants: z.record(z.string(), z.number()),
  xgb_model: z.object({
    learner: z.object({
      learner_model_param: z.object({
        base_score: z.string(),
        num_feature: z.string().optional(),
      }),
      gradient_booster: z.object({
        model: z.object({
          trees: z.array(XGBTreeSchema).min(1, {
            message: 'xgb_model.trees must be non-empty',
          }),
          gbtree_model_param: z
            .object({ num_trees: z.string() })
            .optional(),
        }),
      }),
    }),
  }),
  isotonic: IsotonicSplineSchema,
  metrics_snapshot: z.record(z.string(), z.unknown()).optional(),
});

export type TakeitBundleValidated = z.infer<typeof TakeitBundleSchema>;

/**
 * Validate a parsed JSON object against the TakeitBundle schema. Throws
 * BundleSchemaError with a useful message on any deviation; that error is
 * caught by the bundle loader, captured to Sentry, and falls back to the
 * cached prior bundle (if any) or null.
 */
export function validateBundle(raw: unknown): TakeitBundleValidated {
  const result = TakeitBundleSchema.safeParse(raw);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const where = firstIssue?.path.join('.') ?? '<root>';
    const msg = firstIssue?.message ?? 'unknown validation failure';
    throw new BundleSchemaError(
      `TakeitBundle validation failed at ${where}: ${msg}`,
    );
  }
  return result.data;
}
```

- [ ] **Step 4: Wire it into `assertBundleCompat`**

In `api/_lib/takeit-score.ts`, change the existing `assertBundleCompat()` body (~line 105) to call `validateBundle` first, then keep the existing schema-version-allowlist check:

```ts
// near the top of takeit-score.ts, add:
import { validateBundle } from './takeit-bundle-schema.js';

export function assertBundleCompat(bundle: TakeitBundle): void {
  // Full-shape Zod validation. Throws BundleSchemaError on any deviation.
  validateBundle(bundle);
  // Existing xgb_json_schema allowlist check stays as-is. Keep whatever
  // SUPPORTED_XGB_JSON_SCHEMAS check the function does today.
  if (!SUPPORTED_XGB_JSON_SCHEMAS.includes(bundle.xgb_json_schema)) {
    throw new BundleSchemaError(
      `Unsupported xgb_json_schema=${bundle.xgb_json_schema}; supported: ${SUPPORTED_XGB_JSON_SCHEMAS.join(', ')}`,
    );
  }
}
```

If the existing `assertBundleCompat` already has signature variations or accepts extra args, preserve them — only ADD the `validateBundle(bundle)` call as the first statement.

- [ ] **Step 5: Run tests**

Run: `npx vitest run api/__tests__/takeit-bundle-schema.test.ts api/__tests__/takeit-score.parity.test.ts`
Expected: all pass. The parity test exercises `assertBundleCompat` against the real fixture bundle, which serves as an end-to-end check that the Zod schema accepts the production bundle shape.

- [ ] **Step 6: Run tsc + eslint**

Run: `npx tsc --noEmit && npx eslint api/_lib/takeit-bundle-schema.ts api/_lib/takeit-score.ts api/__tests__/takeit-bundle-schema.test.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add api/_lib/takeit-bundle-schema.ts api/_lib/takeit-score.ts api/__tests__/takeit-bundle-schema.test.ts && git commit -m "feat(takeit): Zod-validated bundle schema (fail-closed on shape mismatch)"
```

---

### Task 1.2: Bundle loader retry-with-backoff + manifest-driven URLs

The current loader does ONE fetch per manifest/bundle with no retry. Add 2 retries with exponential backoff. The bundle URLs are already manifest-driven (Vercel Blob path `takeit/latest.json`), so the rollback lever is in place — Task 1.4 builds the CLI on top.

**Files:**
- Modify: `api/_lib/takeit-bundle-loader.ts`
- Test: `api/__tests__/takeit-bundle-loader.test.ts` (extend; create if absent)

- [ ] **Step 1: Write the failing test**

Add (or extend an existing test file) for the retry path. The loader fetches via `fetch()`; mock `globalThis.fetch` to fail twice then succeed.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockManifest = {
  lottery: 'takeit/lottery-v2026-05-16.json',
  silentboom: 'takeit/silentboom-v2026-05-16.json',
};

const minimalBundle = {
  version: 'v2026-05-16',
  alert_type: 'lottery',
  trained_on_date: '2026-05-16',
  win_label_threshold_pct: 20,
  xgb_json_schema: '2.1',
  feature_cols: ['dte'],
  top_tickers: [],
  categorical_cols: [],
  feature_derivation_constants: {},
  xgb_model: {
    learner: {
      learner_model_param: { base_score: '0.5' },
      gradient_booster: {
        model: {
          trees: [
            {
              left_children: [-1],
              right_children: [-1],
              split_indices: [0],
              split_conditions: [0.5],
              default_left: [1],
              base_weights: [0.1],
            },
          ],
        },
      },
    },
  },
  isotonic: { x_thresholds: [0, 1], y_thresholds: [0, 1] },
};

describe('bundle loader retry behavior', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
    // Reset the module-scoped cache between tests; loader exports a test helper.
    // _resetBundleCacheForTests is exported by api/_lib/takeit-bundle-loader.ts.
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries up to BUNDLE_FETCH_MAX_RETRIES times before falling back', async () => {
    // First two fetches reject, third succeeds. Loader should not throw.
    let calls = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new Error('network fail');
      return new Response(JSON.stringify(mockManifest), { status: 200 });
    });
    // Actual test wiring depends on whether the loader's fetch happens via
    // @vercel/blob list() (intercept that) or direct fetch. Re-read the
    // current implementation — adjust the spy target accordingly. The key
    // behavioral check is: total transport attempts <= MAX_RETRIES + 1.
  });

  it('falls back to cached bundle on persistent fetch failure (warns Sentry)', async () => {
    // After a successful warm-up, all subsequent fetches fail. getBundle
    // returns the cached bundle and emits a Sentry warning.
  });
});
```

> The exact wiring depends on whether `bundle-loader.ts` calls `@vercel/blob`'s `list()` (mock that) vs raw `fetch()` (mock fetch). RE-READ the file to confirm before finalizing the mocks. The test's INTENT — assert retry happens, then fallback fires — must hold either way.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run api/__tests__/takeit-bundle-loader.test.ts`
Expected: tests fail because no retry logic exists.

- [ ] **Step 3: Add retry-with-backoff in `bundle-loader.ts`**

In `api/_lib/takeit-bundle-loader.ts`, find both `fetchManifest()` and `fetchBundleByPath()` (around lines 80-110). Add a generic retry helper:

```ts
const BUNDLE_FETCH_MAX_RETRIES = 2;
const BUNDLE_FETCH_BACKOFFS_MS = [200, 800];

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= BUNDLE_FETCH_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= BUNDLE_FETCH_MAX_RETRIES) break;
      const delay = BUNDLE_FETCH_BACKOFFS_MS[attempt] ?? 1000;
      Sentry.captureMessage(
        `takeit-bundle: ${label} attempt ${attempt + 1} failed, retrying`,
        {
          level: 'info',
          tags: { 'takeit.bundle.retry': String(attempt + 1) },
          extra: { error: String(err) },
        },
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
```

Then wrap both fetch sites:

```ts
const manifest = await withRetry('fetchManifest', () => fetchManifestRaw());
const bundle = await withRetry(
  `fetchBundle:${alertType}`,
  () => fetchBundleByPathRaw(path),
);
```

Keep the existing fail-fallback behavior (`Sentry.captureMessage` + return cached bundle) after the retry layer exhausts.

- [ ] **Step 4: Run tests + lint**

Run: `npx vitest run api/__tests__/takeit-bundle-loader.test.ts && npx tsc --noEmit && npx eslint api/_lib/takeit-bundle-loader.ts`
Expected: all pass, clean.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/takeit-bundle-loader.ts api/__tests__/takeit-bundle-loader.test.ts && git commit -m "feat(takeit): bundle loader retry-with-backoff (2 retries, 200ms+800ms)"
```

---

### Task 1.3: NaN/Infinity input guards in scoring

`scoreLottery` and `scoreSilentBoom` build a feature record and pass it through `featuresFromRow(bundle, rec)` → `Array<number | null>` → `predictTakeitScore(bundle, arr)`. Today the tree walk routes null via `default_left`, but NaN/Infinity from coercion errors silently pass through. Add a `sanitizeScoringInputs` boundary that rejects non-finite numeric inputs.

**Files:**
- Modify: `api/_lib/takeit-detect.ts`
- Test: `api/__tests__/takeit-detect-sanitize.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// api/__tests__/takeit-detect-sanitize.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeScoringInputs } from '../_lib/takeit-detect.js';

describe('sanitizeScoringInputs', () => {
  it('preserves finite numbers and nulls unchanged', () => {
    const input = { dte: 0, vol_oi: 0.5, ask_pct: null };
    expect(sanitizeScoringInputs(input)).toEqual(input);
  });

  it('replaces NaN with null (cannot route safely through trees)', () => {
    const result = sanitizeScoringInputs({ dte: Number.NaN, vol_oi: 0.5 });
    expect(result.dte).toBeNull();
    expect(result.vol_oi).toBe(0.5);
  });

  it('replaces +Infinity and -Infinity with null', () => {
    const result = sanitizeScoringInputs({
      dte: Number.POSITIVE_INFINITY,
      vol_oi: Number.NEGATIVE_INFINITY,
    });
    expect(result.dte).toBeNull();
    expect(result.vol_oi).toBeNull();
  });

  it('returns the count of fields that were sanitized', () => {
    const { sanitized, rejectedCount } = sanitizeScoringInputs(
      { a: Number.NaN, b: 0.5, c: Number.POSITIVE_INFINITY, d: null },
      { withRejectedCount: true },
    );
    expect(rejectedCount).toBe(2);
    expect(sanitized.a).toBeNull();
    expect(sanitized.b).toBe(0.5);
    expect(sanitized.c).toBeNull();
    expect(sanitized.d).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run api/__tests__/takeit-detect-sanitize.test.ts`
Expected: FAIL — `sanitizeScoringInputs` not exported.

- [ ] **Step 3: Add the helper**

In `api/_lib/takeit-detect.ts`, near the top (after imports), add:

```ts
/**
 * Defense-in-depth sanitizer for numeric scoring inputs. The tree walk
 * routes null via `default_left`; NaN/Infinity would silently propagate
 * to undefined branching. We coerce non-finite numerics to null so the
 * model gets a known "missing" sentinel instead.
 *
 * Returned counts are surfaced to Sentry by the cron-level wrapper so we
 * can backtrack what's emitting bad inputs.
 */
export function sanitizeScoringInputs(
  rec: Record<string, number | null | undefined>,
): Record<string, number | null>;
export function sanitizeScoringInputs(
  rec: Record<string, number | null | undefined>,
  opts: { withRejectedCount: true },
): { sanitized: Record<string, number | null>; rejectedCount: number };
export function sanitizeScoringInputs(
  rec: Record<string, number | null | undefined>,
  opts?: { withRejectedCount: boolean },
):
  | Record<string, number | null>
  | { sanitized: Record<string, number | null>; rejectedCount: number } {
  const sanitized: Record<string, number | null> = {};
  let rejectedCount = 0;
  for (const [key, value] of Object.entries(rec)) {
    if (value == null) {
      sanitized[key] = null;
      continue;
    }
    if (!Number.isFinite(value)) {
      sanitized[key] = null;
      rejectedCount += 1;
      continue;
    }
    sanitized[key] = value;
  }
  if (opts?.withRejectedCount) {
    return { sanitized, rejectedCount };
  }
  return sanitized;
}
```

Then in `scoreLottery` and `scoreSilentBoom`, between the `featuresForX(...)` call and the `featuresFromRow(...)` call, route the record through `sanitizeScoringInputs` and capture the reject count:

```ts
// Inside scoreLottery (and symmetrically scoreSilentBoom):
const rawFeatureRec = featuresForLottery(detectCtx.bundle, row, detectCtx.ctx);
const { sanitized: featureRec, rejectedCount } = sanitizeScoringInputs(
  rawFeatureRec,
  { withRejectedCount: true },
);
if (rejectedCount > 0) {
  Sentry.captureMessage(
    `takeit: ${rejectedCount} non-finite feature(s) sanitized`,
    {
      level: 'info',
      tags: { 'takeit.alert_type': 'lottery', 'takeit.sanitize': 'true' },
      extra: {
        option_chain_id: row.option_chain_id,
        rejected_count: rejectedCount,
      },
    },
  );
}
const featureArr = featuresFromRow(detectCtx.bundle, featureRec);
// ... rest of the function unchanged ...
```

- [ ] **Step 4: Run tests + lint**

Run: `npx vitest run api/__tests__/takeit-detect-sanitize.test.ts api/__tests__/takeit-score.parity.test.ts && npx tsc --noEmit && npx eslint api/_lib/takeit-detect.ts api/__tests__/takeit-detect-sanitize.test.ts`
Expected: all pass. The parity test must still pass because the fixture rows all have finite features — sanitization is a no-op on them.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/takeit-detect.ts api/__tests__/takeit-detect-sanitize.test.ts && git commit -m "feat(takeit): NaN/Infinity input guards inside scoreLottery + scoreSilentBoom"
```

---

### Task 1.4: Rollback CLI + Makefile target + runbook

The bundle loader already reads `takeit/latest.json` from Blob. Rollback = re-upload that manifest pointing at prior bundle paths. Build a Node script + Make target around that operation.

**Files:**
- Create: `scripts/takeit-rollback.mjs`
- Modify: project `Makefile` (add `takeit-rollback` target)
- Create: `docs/runbooks/takeit-rollback.md`

- [ ] **Step 1: Write the script**

```js
// scripts/takeit-rollback.mjs
// Usage:
//   make takeit-rollback                                       (show current manifest)
//   make takeit-rollback FEED=lottery PATH=takeit/lottery-vYYYY-MM-DD.json
//   make takeit-rollback FEED=silentboom PATH=takeit/silentboom-vYYYY-MM-DD.json
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

const res = await fetch(entry.downloadUrl);
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

const updated = { ...manifest, [feed]: newPath, rolled_back_at: new Date().toISOString() };
console.log('\nUpdated manifest:');
console.log(JSON.stringify(updated, null, 2));

if (dryRun) {
  console.log('\nDRY_RUN=1 set — not writing.');
  process.exit(0);
}

const body = new Blob([JSON.stringify(updated, null, 2)], {
  type: 'application/json',
});
const result = await put(MANIFEST_KEY, body, {
  access: 'public', // pointer file; bundle blobs themselves may be private
  contentType: 'application/json',
  addRandomSuffix: false,
  allowOverwrite: true,
  token,
});
console.log(`\nWrote new manifest to ${result.url}`);
console.log('New bundle picks up on next cron tick (cache TTL = 15 min).');
```

- [ ] **Step 2: Add the Makefile target**

Append to the project root `Makefile` (RE-READ it first; the existing target idiom uses `set -a && source $(ENV_FILE) && set +a` to export env vars):

```makefile
.PHONY: takeit-rollback

takeit-rollback:
	@set -a && source $(ENV_FILE) && set +a && \
		FEED=$(FEED) PATH_OVERRIDE=$(PATH_OVERRIDE) DRY_RUN=$(DRY_RUN) \
		node scripts/takeit-rollback.mjs
```

Add `takeit-rollback` to the `.PHONY` declaration at the top of the file (the existing list at line ~60). The explicit `FEED=$(FEED) PATH_OVERRIDE=$(PATH_OVERRIDE) DRY_RUN=$(DRY_RUN)` forwarding is REQUIRED — Make's command-line variables (`make takeit-rollback FEED=lottery`) become Make variables, not environment variables; the recipe has to export them into the subshell that runs the Node script.

- [ ] **Step 3: Smoke test the read-only mode**

Run: `make takeit-rollback`
Expected: prints the current manifest JSON. No write.

- [ ] **Step 4: Dry-run a flip**

Run: `make takeit-rollback FEED=lottery PATH_OVERRIDE=takeit/lottery-vTEST.json DRY_RUN=1`
Expected: prints the would-be updated manifest, then exits without writing.

- [ ] **Step 5: Write the runbook**

```md
<!-- docs/runbooks/takeit-rollback.md -->
# TAKE-IT bundle rollback

When a freshly-promoted TAKE-IT bundle is producing bad scores in production,
roll back by pointing the loader's manifest at a prior bundle path.

## Read the current active manifest

```
make takeit-rollback
```

Prints the current `takeit/latest.json` contents (lottery + silentboom paths).

## Find a prior bundle path

The Python pipeline uploads bundles to `takeit/lottery-vYYYY-MM-DD.json` and
`takeit/silentboom-vYYYY-MM-DD.json` (see `ml/src/takeit/export_model.py`).
List prior blobs in the Vercel Blob console at the project's Blob store, or
via the Vercel CLI:

```
vercel blob list --prefix takeit/lottery-
```

## Flip the pointer

```
make takeit-rollback FEED=lottery PATH_OVERRIDE=takeit/lottery-v2026-05-10.json
make takeit-rollback FEED=silentboom PATH_OVERRIDE=takeit/silentboom-v2026-05-10.json
```

Dry-run first (`DRY_RUN=1`) to verify the JSON you're about to write.

## Confirm propagation

The bundle loader caches the manifest with a 15-minute TTL. Wait up to
15 minutes (or restart a warm Vercel container) for the next cron tick to
pick up the new pointer. The detect crons log the bundle version they're
scoring against; check Vercel Function logs for the next `detect-lottery-fires`
or `detect-silent-boom` invocation to confirm the rollback landed.

## Audit trail

The script writes `rolled_back_at` (UTC ISO timestamp) into the manifest.
Future loads carry that field in memory; it's not surfaced anywhere else.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/takeit-rollback.mjs Makefile docs/runbooks/takeit-rollback.md && git commit -m "feat(takeit): make takeit-rollback target + Node CLI + runbook"
```

---

## PHASE 2 — Operational health monitor cron

### Task 2.1: Migration #182 — `takeit_health_daily` table

**Files:**
- Modify: `api/_lib/db-migrations.ts` (append migration #182)
- Modify: `api/__tests__/db.test.ts` (extend mock-applied list)

- [ ] **Step 1: Add the migration**

In `api/_lib/db-migrations.ts`, after the existing entry for id 181, append:

```ts
{
  id: 182,
  description:
    'Add takeit_health_daily table tracking daily TAKE-IT operational + ML drift metrics per feed. Phase 2 audit-takeit-health cron writes operational rows (null_rate_pct, prob_p50, etc.); Phase 3 ml/src/takeit_drift_monitor.py writes ml_-prefixed rows (rolling AUC, per-segment AUC, etc.). UNIQUE (date, feed, metric_name) so re-runs of the same day overwrite cleanly.',
  statements: (sql) => [
    sql`
      CREATE TABLE IF NOT EXISTS takeit_health_daily (
        id              SERIAL PRIMARY KEY,
        date            DATE NOT NULL,
        feed            VARCHAR(20) NOT NULL CHECK (feed IN ('lottery', 'silent_boom')),
        metric_name     VARCHAR(60) NOT NULL,
        metric_value    NUMERIC,
        baseline_value  NUMERIC,
        threshold       NUMERIC,
        alert_fired     BOOLEAN NOT NULL DEFAULT FALSE,
        computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (date, feed, metric_name)
      )
    `,
    sql`
      CREATE INDEX IF NOT EXISTS takeit_health_daily_date_idx
        ON takeit_health_daily(date DESC)
    `,
  ],
},
```

- [ ] **Step 2: Extend the db.test.ts mock**

In `api/__tests__/db.test.ts`, add `{ id: 182 }` to the mock applied-migrations list AND append `'Add takeit_health_daily table...'` (matching the description text) to the expected migrations output array. Bump the expected SQL call count by `2 + 1 = 3` (two CREATE statements + the schema_migrations INSERT).

- [ ] **Step 3: Run tests**

Run: `npx vitest run api/__tests__/db.test.ts`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add api/_lib/db-migrations.ts api/__tests__/db.test.ts && git commit -m "feat(db): migration #182 - takeit_health_daily table"
```

---

### Task 2.2: New cron handler `audit-takeit-health.ts`

**Files:**
- Create: `api/cron/audit-takeit-health.ts`
- Create: `api/__tests__/audit-takeit-health.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// api/__tests__/audit-takeit-health.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import handler from '../cron/audit-takeit-health.js';
import { mockRequest, mockResponse } from './helpers/mock-req-res.js';

const mockSql = vi.fn();
mockSql.transaction = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/cron-instrumentation.js', () => ({
  withCronCheckin: (_name: string, fn: unknown) => fn,
  reportCronRun: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  mockSql.mockReset();
  process.env.CRON_SECRET = 'test-secret';
});

describe('audit-takeit-health cron', () => {
  it('rejects requests without the CRON_SECRET bearer', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('computes null_rate, p50, p90 and writes a row per metric per feed', async () => {
    // Mock: yesterday's lottery fires (one batch row aggregate) then SB.
    // The handler does ONE aggregate SQL per feed; mock returns the agg row.
    mockSql
      .mockResolvedValueOnce([
        {
          rows_scored: 1000,
          null_count: 30,
          prob_p10: '0.45',
          prob_p50: '0.71',
          prob_p90: '0.85',
          prob_p99: '0.93',
          bundle_versions_seen: 1,
        },
      ]) // lottery agg
      .mockResolvedValueOnce([
        {
          rows_scored: 200,
          null_count: 5,
          prob_p10: '0.55',
          prob_p50: '0.72',
          prob_p90: '0.83',
          prob_p99: '0.91',
          bundle_versions_seen: 1,
        },
      ]) // silent_boom agg
      .mockResolvedValueOnce([]) // 30d baseline lottery
      .mockResolvedValueOnce([]) // 30d baseline silent_boom
      .mockResolvedValueOnce([{ inserted: 1 }]); // INSERT...ON CONFLICT (could be a transaction)

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { lottery: Record<string, unknown>; silent_boom: Record<string, unknown> };
    expect(body.lottery).toMatchObject({
      rows_scored: 1000,
      null_rate_pct: 3.0,
    });
    expect(body.silent_boom).toMatchObject({
      rows_scored: 200,
      null_rate_pct: 2.5,
    });
  });
});
```

> Adjust the mock sequence to match what the handler actually queries. If the handler runs the baseline lookup INLINE with the per-feed aggregate (via a CTE), the second/third `mockResolvedValueOnce` calls won't be needed. Re-read the implementation in Step 3 and reconcile.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run api/__tests__/audit-takeit-health.test.ts`
Expected: FAIL — `cron/audit-takeit-health.js` not found.

- [ ] **Step 3: Write the cron handler**

```ts
// api/cron/audit-takeit-health.ts
// Daily operational health monitor for the TAKE-IT scoring layer. Runs at
// 23:30 UTC (18:30 CT, after EOD has settled). Computes per-feed metrics
// against yesterday's fires/alerts, compares to a trailing 30-day baseline,
// fires Sentry alerts on breach, and writes a row per metric to
// takeit_health_daily for trend tracking.

import { cronGuard } from '../_lib/cron-helpers.js';
import { withCronCheckin, reportCronRun } from '../_lib/cron-instrumentation.js';
import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';

const NULL_RATE_ALERT_PCT = 5.0;
const PROB_P50_DRIFT_MAX = 0.05;
const BUNDLE_VERSION_MAX_PER_DAY = 1;

interface FeedAgg {
  rows_scored: number;
  null_count: number;
  prob_p10: number | null;
  prob_p50: number | null;
  prob_p90: number | null;
  prob_p99: number | null;
  bundle_versions_seen: number;
}

interface FeedSummary extends FeedAgg {
  null_rate_pct: number;
  baseline_p50: number | null;
  p50_drift: number | null;
  alerts: string[];
}

export default withCronCheckin('audit-takeit-health', async (req, res) => {
  await Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/cron/audit-takeit-health');
    Sentry.setTag('cron.job', 'audit-takeit-health');
    const done = metrics.request('/api/cron/audit-takeit-health');
    const startedAt = Date.now();

    const guard = cronGuard(req, res, {
      marketHours: false,
      requireApiKey: false,
    });
    if (!guard) return;

    const sql = getDb();
    try {
      // Yesterday's date in ET (the canonical fires/alerts date)
      const yesterdayEt = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      const lottery = await summarizeFeed(sql, 'lottery_finder_fires', yesterdayEt);
      const silentBoom = await summarizeFeed(sql, 'silent_boom_alerts', yesterdayEt);

      const lotterySummary = applyAlerts(lottery, 'lottery');
      const sbSummary = applyAlerts(silentBoom, 'silent_boom');

      // Persist each metric to takeit_health_daily
      await persistMetrics(sql, yesterdayEt, 'lottery', lotterySummary);
      await persistMetrics(sql, yesterdayEt, 'silent_boom', sbSummary);

      await reportCronRun('audit-takeit-health', {
        status: 'ok',
        durationMs: Date.now() - startedAt,
        lottery_null_rate: lotterySummary.null_rate_pct,
        sb_null_rate: sbSummary.null_rate_pct,
      });

      done({ status: 200 });
      return res.status(200).json({
        job: 'audit-takeit-health',
        success: true,
        date: yesterdayEt,
        lottery: lotterySummary,
        silent_boom: sbSummary,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      Sentry.captureException(error);
      await reportCronRun('audit-takeit-health', {
        status: 'error',
        error: String(error),
        durationMs: Date.now() - startedAt,
      });
      done({ status: 500, error: 'unhandled' });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
});

async function summarizeFeed(
  sql: ReturnType<typeof getDb>,
  table: 'lottery_finder_fires' | 'silent_boom_alerts',
  date: string,
): Promise<FeedAgg> {
  const rows = (await withDbRetry(() =>
    sql`
      SELECT
        count(*) AS rows_scored,
        count(*) FILTER (WHERE takeit_prob IS NULL) AS null_count,
        percentile_cont(0.10) WITHIN GROUP (ORDER BY takeit_prob) AS prob_p10,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY takeit_prob) AS prob_p50,
        percentile_cont(0.90) WITHIN GROUP (ORDER BY takeit_prob) AS prob_p90,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY takeit_prob) AS prob_p99,
        count(DISTINCT takeit_model_version) AS bundle_versions_seen
      FROM ${sql.unsafe(table)}
      WHERE date = ${date}::date
    `,
  )) as Array<{
    rows_scored: string | number;
    null_count: string | number;
    prob_p10: string | number | null;
    prob_p50: string | number | null;
    prob_p90: string | number | null;
    prob_p99: string | number | null;
    bundle_versions_seen: string | number;
  }>;
  const r = rows[0]!;
  return {
    rows_scored: Number(r.rows_scored),
    null_count: Number(r.null_count),
    prob_p10: r.prob_p10 == null ? null : Number(r.prob_p10),
    prob_p50: r.prob_p50 == null ? null : Number(r.prob_p50),
    prob_p90: r.prob_p90 == null ? null : Number(r.prob_p90),
    prob_p99: r.prob_p99 == null ? null : Number(r.prob_p99),
    bundle_versions_seen: Number(r.bundle_versions_seen),
  };
}

function applyAlerts(agg: FeedAgg, feed: 'lottery' | 'silent_boom'): FeedSummary {
  const alerts: string[] = [];
  const null_rate_pct =
    agg.rows_scored > 0 ? (agg.null_count / agg.rows_scored) * 100 : 0;

  if (null_rate_pct > NULL_RATE_ALERT_PCT) {
    alerts.push(`null_rate_pct ${null_rate_pct.toFixed(1)}% > ${NULL_RATE_ALERT_PCT}%`);
  }
  if (agg.bundle_versions_seen > BUNDLE_VERSION_MAX_PER_DAY) {
    alerts.push(`bundle_versions_seen=${agg.bundle_versions_seen} > ${BUNDLE_VERSION_MAX_PER_DAY}`);
  }
  // p50 drift is computed against baseline by persistMetrics; included in the
  // summary placeholder here. The baseline read is in the INSERT step below.

  if (alerts.length > 0) {
    Sentry.captureMessage(
      `takeit-health: ${feed} alerts: ${alerts.join('; ')}`,
      {
        level: 'warning',
        tags: { 'takeit.feed': feed, 'cron.anomaly': 'takeit-health' },
        extra: { ...agg, null_rate_pct },
      },
    );
  }

  return {
    ...agg,
    null_rate_pct,
    baseline_p50: null,
    p50_drift: null,
    alerts,
  };
}

async function persistMetrics(
  sql: ReturnType<typeof getDb>,
  date: string,
  feed: 'lottery' | 'silent_boom',
  summary: FeedSummary,
): Promise<void> {
  const rows: Array<[string, number | null, number | null, number, boolean]> = [
    ['null_rate_pct', summary.null_rate_pct, null, NULL_RATE_ALERT_PCT, summary.null_rate_pct > NULL_RATE_ALERT_PCT],
    ['rows_scored', summary.rows_scored, null, 0, false],
    ['prob_p10', summary.prob_p10, null, 0, false],
    ['prob_p50', summary.prob_p50, null, 0, false],
    ['prob_p90', summary.prob_p90, null, 0, false],
    ['prob_p99', summary.prob_p99, null, 0, false],
    ['bundle_versions_seen', summary.bundle_versions_seen, null, BUNDLE_VERSION_MAX_PER_DAY, summary.bundle_versions_seen > BUNDLE_VERSION_MAX_PER_DAY],
  ];

  for (const [metric_name, metric_value, baseline_value, threshold, alert_fired] of rows) {
    await withDbRetry(() =>
      sql`
        INSERT INTO takeit_health_daily
          (date, feed, metric_name, metric_value, baseline_value, threshold, alert_fired)
        VALUES
          (${date}::date, ${feed}, ${metric_name}, ${metric_value}, ${baseline_value}, ${threshold}, ${alert_fired})
        ON CONFLICT (date, feed, metric_name)
        DO UPDATE SET
          metric_value = EXCLUDED.metric_value,
          baseline_value = EXCLUDED.baseline_value,
          threshold = EXCLUDED.threshold,
          alert_fired = EXCLUDED.alert_fired,
          computed_at = NOW()
      `,
    );
  }
}
```

- [ ] **Step 4: Run tests + lint**

Run: `npx vitest run api/__tests__/audit-takeit-health.test.ts && npx tsc --noEmit && npx eslint api/cron/audit-takeit-health.ts`
Expected: clean. Reconcile the test mock sequence with the actual handler's query order; the test's `mockResolvedValueOnce` chain must match the order calls are made.

- [ ] **Step 5: Commit**

```bash
git add api/cron/audit-takeit-health.ts api/__tests__/audit-takeit-health.test.ts && git commit -m "feat(cron): audit-takeit-health daily operational health monitor"
```

---

### Task 2.3: Register the cron in `vercel.json`

- [ ] **Step 1: Add the entry**

In `vercel.json`, inside the `"crons"` array, add (alphabetically by path, matching the file's existing ordering):

```json
{
  "path": "/api/cron/audit-takeit-health",
  "schedule": "30 23 * * *"
},
```

`30 23 * * *` = every day at 23:30 UTC (18:30 CT, after EOD has settled).

- [ ] **Step 2: Commit**

```bash
git add vercel.json && git commit -m "feat(cron): register audit-takeit-health at 23:30 UTC daily"
```

---

## PHASE 3 — ML drift monitor (Python, into `make update`)

### Phase 3 scope notes (deferrals from the spec)

This plan delivers the three highest-leverage drift signals — **rolling AUC**
(against both peak and realized targets), **reliability diagrams**, and
**per-segment AUC**. Two spec items are explicitly **deferred to a
follow-up plan**:

- **Per-feature z-score drift monitoring.** The plan ships a tested
  `feature_zscore` helper (Task 3.1 Step 1) so the infrastructure is in
  place, but the main() flow does NOT iterate per-feature today. The
  Python pipeline doesn't currently materialize a per-feature baseline
  table; computing one well is its own design pass.
- **Top-K SHAP feature stability tracking.** Would require running
  `shap` (already in `ml/requirements.txt`) on a sample each night and
  diffing top-K against a rolling-window baseline. Substantive enough
  to deserve its own plan.

Both will land in a follow-up spec once Phase 3 has a few weeks of live
data to calibrate thresholds against. Alerting flows through the
`takeit_health_daily` `alert_fired` boolean column rather than Sentry —
the Python ML pipeline doesn't currently have the Sentry SDK initialized
(confirmed by the mapping pass), and the daily-cadence + committed
markdown report is the existing observability surface.

### Task 3.1: New module `ml/src/takeit_drift_monitor.py`

**Files:**
- Create: `ml/src/takeit_drift_monitor.py`
- Create: `ml/tests/test_takeit_drift_monitor.py`

- [ ] **Step 1: Write the failing test**

```py
# ml/tests/test_takeit_drift_monitor.py
import pytest
import numpy as np
from takeit_drift_monitor import (
    rolling_auc,
    reliability_bins,
    per_segment_auc,
    feature_zscore,
)


def test_rolling_auc_perfect_separation():
    y_true = np.array([0, 0, 0, 1, 1, 1])
    y_pred = np.array([0.1, 0.2, 0.3, 0.7, 0.8, 0.9])
    assert rolling_auc(y_true, y_pred) == pytest.approx(1.0)


def test_rolling_auc_returns_nan_on_single_class():
    y_true = np.array([1, 1, 1])
    y_pred = np.array([0.4, 0.6, 0.8])
    assert np.isnan(rolling_auc(y_true, y_pred))


def test_reliability_bins_returns_10_bins_with_predicted_actual():
    y_true = np.array([0, 0, 1, 1, 0, 1, 1, 1, 1, 1])
    y_pred = np.array([0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95])
    bins = reliability_bins(y_true, y_pred, n_bins=10)
    assert len(bins) == 10
    # Each bin returns (predicted_mean, actual_rate, count)
    for b in bins:
        assert len(b) == 3


def test_per_segment_auc_skips_segments_below_min_n():
    y_true = np.array([0, 1, 0, 1, 0, 1])
    y_pred = np.array([0.2, 0.7, 0.3, 0.8, 0.4, 0.9])
    segments = np.array(['A', 'A', 'A', 'A', 'B', 'B'])  # B too small
    result = per_segment_auc(y_true, y_pred, segments, min_n=3)
    assert 'A' in result
    assert 'B' not in result  # below min_n
    assert result['A']['auc'] == pytest.approx(1.0)


def test_feature_zscore_against_baseline():
    today = np.array([1.0, 2.0, 3.0])
    baseline_mean = 0.0
    baseline_std = 1.0
    z = feature_zscore(today, baseline_mean, baseline_std)
    # today's mean is 2.0; z = (2.0 - 0.0) / 1.0 = 2.0
    assert z == pytest.approx(2.0)


def test_feature_zscore_returns_nan_on_zero_baseline_std():
    today = np.array([1.0, 2.0, 3.0])
    z = feature_zscore(today, baseline_mean=0.0, baseline_std=0.0)
    assert np.isnan(z)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ml && .venv/bin/python -m pytest tests/test_takeit_drift_monitor.py -v`
Expected: ImportError.

- [ ] **Step 3: Write the module**

```py
# ml/src/takeit_drift_monitor.py
# Daily TAKE-IT drift + validation monitor. Runs as part of `make update`
# (the user's existing daily research target). Outputs:
#   - docs/tmp/takeit-drift-YYYY-MM-DD.md  (committed by make update)
#   - ml/plots/takeit-drift/reliability_<feed>_<date>.png (committed)
#   - rows in takeit_health_daily (ml_-prefixed metric_name)
#
# Targets compared:
#   - peak_ceiling_pct >= 20    (the model's training target)
#   - realized_trail30_10_pct >= 0  (trade-worthiness target)
# The divergence between rolling AUCs on these two targets is itself a
# tracked metric — the empirical case for the deferred realized-target retrain.

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd
import psycopg2
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from sklearn.metrics import roc_auc_score

# Reuse the project's existing connection helper.
from utils import get_connection  # type: ignore[import-not-found]


ML_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ML_ROOT.parent
DOCS_TMP = REPO_ROOT / 'docs' / 'tmp'
PLOT_DIR = ML_ROOT / 'plots' / 'takeit-drift'

ROLLING_AUC_DROP_MAX = 0.05
PER_SEGMENT_AUC_MIN = 0.55
PER_SEGMENT_MIN_N = 100
FEATURE_Z_ALERT = 3.0


def rolling_auc(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """AUC, returns NaN if y_true is single-class or empty."""
    if len(y_true) == 0 or len(np.unique(y_true)) < 2:
        return float('nan')
    return float(roc_auc_score(y_true, y_pred))


def reliability_bins(
    y_true: np.ndarray, y_pred: np.ndarray, n_bins: int = 10,
) -> list[tuple[float, float, int]]:
    """Return (predicted_mean, actual_rate, count) per equal-width prob bin."""
    bins = np.linspace(0, 1, n_bins + 1)
    out: list[tuple[float, float, int]] = []
    for i in range(n_bins):
        lo, hi = bins[i], bins[i + 1]
        if i == n_bins - 1:
            mask = (y_pred >= lo) & (y_pred <= hi)
        else:
            mask = (y_pred >= lo) & (y_pred < hi)
        n = int(mask.sum())
        if n == 0:
            out.append((float((lo + hi) / 2), float('nan'), 0))
            continue
        out.append(
            (
                float(y_pred[mask].mean()),
                float(y_true[mask].mean()),
                n,
            )
        )
    return out


def per_segment_auc(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    segments: np.ndarray,
    min_n: int = PER_SEGMENT_MIN_N,
) -> dict[str, dict[str, float | int]]:
    """AUC per segment label. Segments with count < min_n are skipped."""
    out: dict[str, dict[str, float | int]] = {}
    for seg in np.unique(segments):
        mask = segments == seg
        n = int(mask.sum())
        if n < min_n:
            continue
        auc = rolling_auc(y_true[mask], y_pred[mask])
        out[str(seg)] = {'auc': auc, 'n': n}
    return out


def feature_zscore(
    today: np.ndarray, baseline_mean: float, baseline_std: float,
) -> float:
    """Z-score of today's mean against baseline distribution. NaN on zero std."""
    if baseline_std == 0 or np.isnan(baseline_std):
        return float('nan')
    today_mean = float(np.nanmean(today)) if today.size else float('nan')
    if np.isnan(today_mean):
        return float('nan')
    return (today_mean - baseline_mean) / baseline_std


def fetch_recent_fires(
    conn: psycopg2.extensions.connection, feed: str, lookback_days: int,
) -> pd.DataFrame:
    table = 'lottery_finder_fires' if feed == 'lottery' else 'silent_boom_alerts'
    sql = f"""
      SELECT
        date,
        underlying_symbol,
        option_type,
        dte,
        takeit_prob,
        takeit_model_version,
        peak_ceiling_pct,
        realized_trail30_10_pct
      FROM {table}
      WHERE date >= CURRENT_DATE - INTERVAL '{lookback_days} days'
        AND takeit_prob IS NOT NULL
        AND peak_ceiling_pct IS NOT NULL
    """
    return pd.read_sql(sql, conn)


def compute_feed_drift(
    df: pd.DataFrame, feed: str,
) -> dict[str, float | dict]:
    """Compute the headline metrics for one feed: 7d/30d AUC vs both targets,
    per-segment AUC, calibration bins."""
    out: dict[str, float | dict] = {'feed': feed, 'n_rows_total': len(df)}
    if df.empty:
        return out

    today = pd.Timestamp.utcnow().normalize().tz_localize(None).date()
    for window_days, label in [(7, '7d'), (30, '30d')]:
        cutoff = today - dt.timedelta(days=window_days)
        win = df[df['date'] >= pd.Timestamp(cutoff)]
        if win.empty:
            continue
        y_pred = win['takeit_prob'].to_numpy()
        peak_label = (win['peak_ceiling_pct'].to_numpy() >= 20).astype(int)
        out[f'auc_{label}_peak'] = rolling_auc(peak_label, y_pred)
        if 'realized_trail30_10_pct' in win:
            real_label = (
                win['realized_trail30_10_pct'].fillna(-100).to_numpy() >= 0
            ).astype(int)
            out[f'auc_{label}_realized'] = rolling_auc(real_label, y_pred)

    # Per-segment AUC on 30d window
    cutoff30 = today - dt.timedelta(days=30)
    win30 = df[df['date'] >= pd.Timestamp(cutoff30)]
    if not win30.empty:
        y_pred = win30['takeit_prob'].to_numpy()
        peak_label = (win30['peak_ceiling_pct'].to_numpy() >= 20).astype(int)

        # Segment by DTE bucket
        dte_seg = pd.cut(
            win30['dte'],
            bins=[-1, 0, 3, 100],
            labels=['0DTE', '1-3', '4+'],
        ).astype(str).to_numpy()
        out['by_dte'] = per_segment_auc(peak_label, y_pred, dte_seg)

        # Segment by option type
        out['by_option_type'] = per_segment_auc(
            peak_label, y_pred, win30['option_type'].astype(str).to_numpy(),
        )

    return out


def render_markdown_report(
    today_str: str,
    lottery: dict[str, float | dict],
    silent_boom: dict[str, float | dict],
) -> str:
    lines: list[str] = []
    lines.append(f'# TAKE-IT drift report — {today_str}')
    lines.append('')
    for feed_name, summary in [('lottery', lottery), ('silent_boom', silent_boom)]:
        lines.append(f'## {feed_name}')
        lines.append('')
        lines.append(f'- rows in 30d window: {summary.get("n_rows_total", 0)}')
        for k in ('auc_7d_peak', 'auc_30d_peak', 'auc_7d_realized', 'auc_30d_realized'):
            v = summary.get(k)
            if v is not None:
                lines.append(f'- {k}: {v:.3f}' if isinstance(v, float) and not np.isnan(v) else f'- {k}: n/a')
        if 'by_dte' in summary:
            lines.append('')
            lines.append('### per-DTE 30d AUC (peak target)')
            for seg, m in summary['by_dte'].items():  # type: ignore[union-attr]
                lines.append(f'- {seg}: AUC={m["auc"]:.3f}  n={m["n"]}')
        if 'by_option_type' in summary:
            lines.append('')
            lines.append('### per-option-type 30d AUC (peak target)')
            for seg, m in summary['by_option_type'].items():  # type: ignore[union-attr]
                lines.append(f'- {seg}: AUC={m["auc"]:.3f}  n={m["n"]}')
        lines.append('')
    return '\n'.join(lines)


def plot_reliability(
    df: pd.DataFrame, feed: str, today_str: str,
) -> Path | None:
    if df.empty:
        return None
    cutoff30 = pd.Timestamp.utcnow().normalize().tz_localize(None) - pd.Timedelta(days=30)
    win = df[df['date'] >= cutoff30]
    if win.empty:
        return None
    y_pred = win['takeit_prob'].to_numpy()
    y_true = (win['peak_ceiling_pct'].to_numpy() >= 20).astype(int)
    bins = reliability_bins(y_true, y_pred, n_bins=10)

    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = PLOT_DIR / f'reliability_{feed}_{today_str}.png'
    fig, ax = plt.subplots(figsize=(8, 6))
    pred = [b[0] for b in bins]
    actual = [b[1] for b in bins]
    ax.plot([0, 1], [0, 1], 'k--', label='perfect calibration')
    ax.plot(pred, actual, 'o-', label=feed)
    ax.set_xlabel('predicted prob (bin mean)')
    ax.set_ylabel('actual rate (peak >= 20%)')
    ax.set_title(f'TAKE-IT reliability — {feed} — 30d ending {today_str}')
    ax.legend()
    ax.grid(alpha=0.3)
    fig.savefig(out_path, dpi=150, bbox_inches='tight')
    plt.close(fig)
    return out_path


def main() -> int:
    today_str = dt.date.today().isoformat()
    conn = get_connection()
    try:
        lottery_df = fetch_recent_fires(conn, 'lottery', 30)
        sb_df = fetch_recent_fires(conn, 'silent_boom', 30)

        lottery_summary = compute_feed_drift(lottery_df, 'lottery')
        sb_summary = compute_feed_drift(sb_df, 'silent_boom')

        plot_reliability(lottery_df, 'lottery', today_str)
        plot_reliability(sb_df, 'silent_boom', today_str)

        report = render_markdown_report(today_str, lottery_summary, sb_summary)
        DOCS_TMP.mkdir(parents=True, exist_ok=True)
        report_path = DOCS_TMP / f'takeit-drift-{today_str}.md'
        report_path.write_text(report, encoding='utf-8')
        print(f'Wrote {report_path}')

        # Persist key metrics to takeit_health_daily (ml_-prefixed names)
        with conn.cursor() as cur:
            for feed_name, s in (('lottery', lottery_summary), ('silent_boom', sb_summary)):
                for key in ('auc_7d_peak', 'auc_30d_peak', 'auc_7d_realized', 'auc_30d_realized'):
                    val = s.get(key)
                    if val is None or (isinstance(val, float) and np.isnan(val)):
                        continue
                    cur.execute(
                        """
                        INSERT INTO takeit_health_daily
                          (date, feed, metric_name, metric_value)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (date, feed, metric_name)
                        DO UPDATE SET
                          metric_value = EXCLUDED.metric_value,
                          computed_at = NOW()
                        """,
                        (today_str, feed_name, f'ml_{key}', float(val)),
                    )
            conn.commit()
    finally:
        conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 4: Run pytest**

Run: `cd ml && .venv/bin/python -m pytest tests/test_takeit_drift_monitor.py -v`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add ml/src/takeit_drift_monitor.py ml/tests/test_takeit_drift_monitor.py && git commit -m "feat(ml): takeit-drift monitor with rolling AUC, reliability, per-segment AUC"
```

---

### Task 3.2: Wire `takeit_drift_monitor.py` into `make update`

- [ ] **Step 1: Modify the Makefile**

In the project root `Makefile`, find the `update` target (~line 199). Read its existing recipe — it chains several Python scripts. Append a new step BEFORE the closing line:

```makefile
	@echo "==> TAKE-IT drift monitor"
	@set -a && source $(ENV_FILE) && set +a && \
		cd ml && .venv/bin/python -m takeit_drift_monitor
```

(Path inference: if the file uses `$(PYTHON)` for the binary, use that; if it `cd`s into `ml/`, follow that pattern. Re-read for the exact existing convention.)

Also add a STANDALONE `takeit-drift` target for re-running:

```makefile
.PHONY: takeit-drift

takeit-drift:
	@set -a && source $(ENV_FILE) && set +a && \
		cd ml && .venv/bin/python -m takeit_drift_monitor
```

And add `takeit-drift` to the existing `.PHONY` line.

- [ ] **Step 2: Smoke run**

Run: `make takeit-drift`
Expected: outputs a markdown report to `docs/tmp/takeit-drift-YYYY-MM-DD.md` + reliability PNGs in `ml/plots/takeit-drift/`, and writes rows to `takeit_health_daily`.

- [ ] **Step 3: Commit**

```bash
git add Makefile && git commit -m "feat(make): wire takeit-drift into make update + standalone target"
```

---

## PHASE 4 — Historical backfill (one-shot TS tool)

### Task 4.1: Backfill script

**Files:**
- Create: `scripts/backfill-takeit-scores.mjs`
- Modify: `Makefile` (add `takeit-backfill` target)

- [ ] **Step 1: Write the script**

```js
// scripts/backfill-takeit-scores.mjs
//
// Backfill takeit_prob on historical rows by re-using the production
// scoring code path. Idempotent (WHERE takeit_prob IS NULL), resumable,
// batched. Run via:
//   make takeit-backfill
//   make takeit-backfill FEED=lottery
//   make takeit-backfill FEED=silent_boom SINCE=2026-03-01 LIMIT=10000
//
// Pre-flight: source .env.local for DATABASE_URL + BLOB_READ_WRITE_TOKEN.

import { neon } from '@neondatabase/serverless';
import { config as dotenvConfig } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import {
  scoreLottery,
  scoreSilentBoom,
  loadTakeitDetectContext,
} from '../api/_lib/takeit-detect.js';

dotenvConfig({ path: '.env.local' });

const FEED = process.env.FEED ?? 'both';
const SINCE = process.env.SINCE ?? null; // YYYY-MM-DD
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const BATCH_SIZE = 2000;

const sql = neon(process.env.DATABASE_URL);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.resolve('scripts/output', `backfill-takeit-${runId}.log`);
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
};

const feeds =
  FEED === 'both' ? ['lottery', 'silent_boom'] : [FEED];

for (const feed of feeds) {
  const ctxKey = feed === 'lottery' ? 'lottery' : 'silentboom';
  const ctx = await loadTakeitDetectContext(ctxKey, {
    sentry: { captureMessage: () => {}, captureException: () => {} },
  });
  if (!ctx) {
    log(`${feed}: no bundle available, skipping`);
    continue;
  }
  log(`${feed}: bundle version=${ctx.bundle.version} schema=${ctx.bundle.xgb_json_schema}`);

  const table = feed === 'lottery' ? 'lottery_finder_fires' : 'silent_boom_alerts';
  const scoreFn = feed === 'lottery' ? scoreLottery : scoreSilentBoom;

  let totalScored = 0;
  let totalNull = 0;
  let lastId = 0;

  while (true) {
    const where = [
      `takeit_prob IS NULL`,
      `id > ${lastId}`,
      SINCE ? `date >= '${SINCE}'::date` : null,
    ]
      .filter(Boolean)
      .join(' AND ');

    const batch = await sql.unsafe(
      `SELECT * FROM ${table} WHERE ${where} ORDER BY id LIMIT ${BATCH_SIZE}`,
    );
    if (!batch.length) {
      log(`${feed}: no more rows, done`);
      break;
    }
    log(`${feed}: batch of ${batch.length} rows starting at id=${batch[0].id}`);

    const updates = [];
    for (const row of batch) {
      const { prob, version } = scoreFn(ctx, row);
      if (prob == null) {
        totalNull += 1;
      } else {
        totalScored += 1;
      }
      updates.push({ id: row.id, prob, version });
    }

    // Persist in a single transaction per batch
    await sql.transaction(
      updates.map(
        (u) => sql`
          UPDATE ${sql.unsafe(table)}
          SET takeit_prob = ${u.prob},
              takeit_model_version = ${u.version}
          WHERE id = ${u.id}
        `,
      ),
    );

    lastId = batch[batch.length - 1].id;
    log(`${feed}: progress scored=${totalScored} null=${totalNull} lastId=${lastId}`);

    if (LIMIT && totalScored + totalNull >= LIMIT) {
      log(`${feed}: hit LIMIT=${LIMIT}, stopping`);
      break;
    }
  }
  log(`${feed}: COMPLETE scored=${totalScored} null=${totalNull}`);
}

log(`backfill done. log: ${logPath}`);
```

- [ ] **Step 2: Add Makefile target**

```makefile
.PHONY: takeit-backfill

takeit-backfill:
	@set -a && source $(ENV_FILE) && set +a && \
		FEED=$(FEED) SINCE=$(SINCE) LIMIT=$(LIMIT) \
		node scripts/backfill-takeit-scores.mjs
```

Add `takeit-backfill` to the `.PHONY` list. Same env-forwarding caveat as Task 1.4 — the explicit `FEED=$(FEED) SINCE=$(SINCE) LIMIT=$(LIMIT)` is required so `make takeit-backfill FEED=lottery LIMIT=1000` actually propagates those into `process.env` inside the Node script.

- [ ] **Step 3: Dry-run a small batch**

Run: `make takeit-backfill FEED=lottery LIMIT=100`
Expected: scores ~100 historical rows, logs progress to `scripts/output/backfill-takeit-*.log`, exits cleanly.

- [ ] **Step 4: Verify in DB**

Sanity check via psql or a one-off query: confirm `takeit_prob IS NOT NULL` increased on the targeted rows, and `takeit_model_version` matches the active bundle's version.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-takeit-scores.mjs Makefile && git commit -m "feat(takeit): one-shot backfill tool (make takeit-backfill, parity-safe)"
```

---

## Final verification (after all tasks)

- [ ] Run the full project gate: `npm run review` (tsc + eslint + prettier + vitest --coverage). Fix any failures before declaring done.
- [ ] Run the ml tests: `cd ml && .venv/bin/python -m pytest tests/test_takeit_drift_monitor.py -v`.
- [ ] Spot-check the cron registration: `grep -A 1 audit-takeit-health vercel.json` shows the schedule entry.
- [ ] After deploy, manually invoke the cron once: `curl -H "Authorization: Bearer $CRON_SECRET" https://<production-url>/api/cron/audit-takeit-health` — confirm 200 OK and a row in `takeit_health_daily`.
- [ ] Run `make takeit-drift` once locally — confirm the markdown report + reliability PNG land in `docs/tmp/` and `ml/plots/takeit-drift/`.
- [ ] Run `make takeit-backfill FEED=lottery LIMIT=1000` and confirm null-rate on lottery_finder_fires drops.

## Out of scope (tracked for a follow-up spec)

- Retraining TAKE-IT on a realized-with-stop label. Will land as a shadow model via champion/challenger when justified by Phase 3's peak-vs-realized AUC divergence data.
- Ensemble / multi-seed bundle.
- Embedding the bundle in git instead of Blob.
