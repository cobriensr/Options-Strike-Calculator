/**
 * Take-It scorer parity test — TS predictions must match Python's to 1e-6.
 *
 * Spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md
 *
 * Fixture: `ml/tests/fixtures/takeit_parity_fixture.json` — 50 real production
 * feature rows per alert type plus the Python model's raw + calibrated
 * predictions. Regenerate with
 * `ml/.venv/bin/python -m ml.src.takeit.generate_parity_fixture`
 * (`ml/.venv/Scripts/python` on Windows).
 *
 * This is the gate that any future bundle-format change must survive.
 * If parity slips, suspect (in order): isotonic interpolation drift, NaN
 * routing, base_score parsing, tree direction (< vs <=).
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type TakeitBundle,
  assertBundleCompat,
  featuresFromRow,
  predictTakeitScore,
} from '../_lib/takeit-score.js';
import { expandOneHotCategoricals } from '../_lib/takeit-features.js';

// Raw-prob parity is exact-fround-match across our 100 fixture rows.
// Calibrated parity is gated looser because the isotonic slope can amplify
// a single 1-ULP drift in the float32 prob_raw input (which depends on the
// platform's float64-vs-float32 sigmoid rounding) into a ~3e-6 output diff.
// 1e-5 still flags any meaningful algorithmic divergence; a 0.001% probability
// drift is well below any trading-decision threshold.
const PARITY_TOLERANCE_RAW = 1e-6;
const PARITY_TOLERANCE_CAL = 1e-5;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_PATH = path.join(
  REPO_ROOT,
  'ml',
  'tests',
  'fixtures',
  'takeit_parity_fixture.json',
);
const BUNDLE_DIR = path.join(REPO_ROOT, 'ml', 'data', 'takeit');

// Remedies shown in the skip title. Forward slashes so a command pastes
// into Git Bash as well as PowerShell; the venv's interpreter lives in
// bin/ on POSIX and Scripts/ on Windows.
const VENV_PYTHON = `ml/.venv/${process.platform === 'win32' ? 'Scripts' : 'bin'}/python`;
// The fixture is tracked, so a missing one was deleted.
const FIXTURE_FIX =
  'restore it with `git checkout -- ml/tests/fixtures/takeit_parity_fixture.json`';
// `train` alone can't recreate the bundle the fixture was generated from:
// it reads the gitignored training parquet (built from the prod DB) and
// stamps today's version. So copy the bundle, or rebuild every step and
// commit the regenerated fixture.
const BUNDLE_FIX =
  "copy ml/data/takeit/ from a checkout that has the fixture's bundle " +
  `version, or run ${VENV_PYTHON} -m ml.src.takeit.build_training_set, ` +
  `${VENV_PYTHON} -m ml.src.takeit.train and ` +
  `${VENV_PYTHON} -m ml.src.takeit.generate_parity_fixture, then commit ` +
  'the new fixture';

interface ParityRow {
  features: Record<string, number | null>;
  expected_prob_raw: number;
  expected_prob_calibrated: number;
}

interface ParityBlock {
  alert_type: 'lottery' | 'silentboom';
  bundle_version: string;
  n_rows: number;
  rows: ParityRow[];
}

interface ParityFixture {
  lottery: ParityBlock;
  silentboom: ParityBlock;
}

function bundlePath(alertType: 'lottery' | 'silentboom'): string {
  return path.join(BUNDLE_DIR, `${alertType}_classifier.json`);
}

// Called only after missingArtifact() found every file.
function loadFixture(): ParityFixture {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as ParityFixture;
}

function loadBundle(alertType: 'lottery' | 'silentboom'): TakeitBundle {
  return JSON.parse(
    fs.readFileSync(bundlePath(alertType), 'utf8'),
  ) as TakeitBundle;
}

// Skip the parity tests wherever the artifacts are absent. `ml/data/` is
// gitignored, so CI and every fresh clone or worktree lack the bundles.
// takeit-score.test.ts unit-tests the scorer without them, so the skip
// loses only the check against real Python output, which matters
// whenever the bundle or the scorer changes; the skip title says how to
// get the artifacts back.
function missingArtifact(): { what: string; fix: string } | null {
  if (!fs.existsSync(FIXTURE_PATH)) {
    return { what: `parity fixture ${FIXTURE_PATH}`, fix: FIXTURE_FIX };
  }
  for (const alertType of ['lottery', 'silentboom'] as const) {
    const p = bundlePath(alertType);
    if (!fs.existsSync(p)) {
      return { what: `${alertType} bundle ${p}`, fix: BUNDLE_FIX };
    }
  }
  return null;
}

const missing = missingArtifact();

describe('takeit-score TS↔Python parity', () => {
  if (missing) {
    it.skip(`skipped: ${missing.what} is absent; ${missing.fix}`, () => {});
    return;
  }

  const fixture = loadFixture();

  for (const alertType of ['lottery', 'silentboom'] as const) {
    describe(alertType, () => {
      const bundle = loadBundle(alertType);
      const block = fixture[alertType];

      it('bundle schema is supported', () => {
        expect(() => assertBundleCompat(bundle)).not.toThrow();
      });

      it('bundle version matches fixture version', () => {
        expect(block.bundle_version).toBe(bundle.version);
      });

      it(`raw prob matches Python within ${PARITY_TOLERANCE_RAW} for all ${block.n_rows} rows`, () => {
        const diffs: {
          idx: number;
          ts: number;
          py: number;
          absdiff: number;
        }[] = [];
        for (let i = 0; i < block.rows.length; i++) {
          const row = block.rows[i]!;
          const features = featuresFromRow(bundle, row.features);
          const result = predictTakeitScore(bundle, features);
          const diff = Math.abs(result.prob_raw - row.expected_prob_raw);
          if (diff > PARITY_TOLERANCE_RAW) {
            diffs.push({
              idx: i,
              ts: result.prob_raw,
              py: row.expected_prob_raw,
              absdiff: diff,
            });
          }
        }
        if (diffs.length > 0) {
          const summary = diffs
            .slice(0, 5)
            .map(
              (d) =>
                `  row ${d.idx}: ts=${d.ts.toFixed(10)} py=${d.py.toFixed(10)} Δ=${d.absdiff.toExponential(3)}`,
            )
            .join('\n');
          throw new Error(
            `${diffs.length}/${block.rows.length} rows exceed raw tolerance ${PARITY_TOLERANCE_RAW}:\n${summary}`,
          );
        }
      });

      it(`calibrated prob matches Python within ${PARITY_TOLERANCE_CAL} for all ${block.n_rows} rows`, () => {
        const diffs: {
          idx: number;
          ts: number;
          py: number;
          absdiff: number;
        }[] = [];
        for (let i = 0; i < block.rows.length; i++) {
          const row = block.rows[i]!;
          const features = featuresFromRow(bundle, row.features);
          const result = predictTakeitScore(bundle, features);
          const diff = Math.abs(
            result.prob_calibrated - row.expected_prob_calibrated,
          );
          if (diff > PARITY_TOLERANCE_CAL) {
            diffs.push({
              idx: i,
              ts: result.prob_calibrated,
              py: row.expected_prob_calibrated,
              absdiff: diff,
            });
          }
        }
        if (diffs.length > 0) {
          const summary = diffs
            .slice(0, 5)
            .map(
              (d) =>
                `  row ${d.idx}: ts=${d.ts.toFixed(10)} py=${d.py.toFixed(10)} Δ=${d.absdiff.toExponential(3)}`,
            )
            .join('\n');
          throw new Error(
            `${diffs.length}/${block.rows.length} rows exceed calibrated tolerance ${PARITY_TOLERANCE_CAL}:\n${summary}`,
          );
        }
      });

      it('scores a fixture row identically when inactive one-hots arrive via expandOneHotCategoricals', () => {
        const prefixes = [
          ...bundle.categorical_cols.map((c) => `${c}_`),
          'ticker_bucket_',
        ];
        const isOneHot = (name: string) =>
          prefixes.some((p) => name.startsWith(p));
        for (const row of block.rows) {
          // Recover the raw categorical values from the active (1.0) columns.
          const raw: Record<string, string> = {};
          let ticker = 'NOT_A_TOP_TICKER';
          for (const [name, v] of Object.entries(row.features)) {
            if (v !== 1) continue;
            if (name.startsWith('ticker_bucket_')) {
              const bucket = name.slice('ticker_bucket_'.length);
              if (bucket !== 'OTHER') ticker = bucket;
              continue;
            }
            const col = bundle.categorical_cols.find((c) =>
              name.startsWith(`${c}_`),
            );
            if (col) raw[col] = name.slice(col.length + 1);
          }
          // Live shape: numeric features only, one-hot block rebuilt.
          const live: Record<string, number | null> = {};
          for (const [name, v] of Object.entries(row.features)) {
            if (!isOneHot(name)) live[name] = v;
          }
          Object.assign(live, expandOneHotCategoricals(bundle, raw, ticker));
          const result = predictTakeitScore(
            bundle,
            featuresFromRow(bundle, live),
          );
          expect(
            Math.abs(result.prob_raw - row.expected_prob_raw),
          ).toBeLessThanOrEqual(PARITY_TOLERANCE_RAW);
        }
      });

      it('probabilities are in [0, 1]', () => {
        for (let i = 0; i < block.rows.length; i++) {
          const features = featuresFromRow(bundle, block.rows[i]!.features);
          const r = predictTakeitScore(bundle, features);
          expect(r.prob_raw).toBeGreaterThanOrEqual(0);
          expect(r.prob_raw).toBeLessThanOrEqual(1);
          expect(r.prob_calibrated).toBeGreaterThanOrEqual(0);
          expect(r.prob_calibrated).toBeLessThanOrEqual(1);
        }
      });
    });
  }
});
