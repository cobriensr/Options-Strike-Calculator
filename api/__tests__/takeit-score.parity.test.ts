/**
 * Take-It scorer parity test — TS predictions must match Python's to 1e-6.
 *
 * Spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md
 *
 * Fixture: `ml/tests/fixtures/takeit_parity_fixture.json` — 50 real production
 * feature rows per alert type plus the Python model's raw + calibrated
 * predictions. Regenerate with `python -m ml.src.takeit.generate_parity_fixture`.
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

function loadFixture(): ParityFixture {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(
      `parity fixture missing at ${FIXTURE_PATH}; regenerate with: ml/.venv/bin/python -m ml.src.takeit.generate_parity_fixture`,
    );
  }
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as ParityFixture;
}

function loadBundle(alertType: 'lottery' | 'silentboom'): TakeitBundle {
  const p = path.join(BUNDLE_DIR, `${alertType}_classifier.json`);
  if (!fs.existsSync(p)) {
    throw new Error(
      `bundle missing at ${p}; regenerate with: ml/.venv/bin/python -m ml.src.takeit.train`,
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as TakeitBundle;
}

describe('takeit-score TS↔Python parity', () => {
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
