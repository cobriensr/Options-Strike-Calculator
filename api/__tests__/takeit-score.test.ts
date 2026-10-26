/**
 * Unit tests for the Take-It scorer (api/_lib/takeit-score.ts) on small,
 * hand-built bundles.
 *
 * takeit-score.parity.test.ts needs the trained bundles in ml/data/takeit/,
 * which is gitignored, so it skips wherever the bundle is absent (CI, fresh
 * clones and worktrees). Nothing here reads a file: every
 * tree, spline and bundle is built inline and every expected value is derived
 * by hand in the comment beside it, so these run identically on CI.
 *
 * Numbers are picked to be exact in float32 where possible (0.25, 0.75,
 * ln 3 -> sigmoid 0.75, ...), because the scorer rounds to float32 at each
 * step to match XGBoost and sklearn.
 */

import { describe, expect, it } from 'vitest';

import {
  BundleSchemaError,
  TAKEIT_GATE_EXEMPT_MIN_PROB,
  applyIsotonic,
  assertBundleCompat,
  featuresFromRow,
  parseBaseScore,
  predictTakeitScore,
  walkTree,
} from '../_lib/takeit-score.js';
import type {
  IsotonicSpline,
  TakeitBundle,
  XGBTree,
} from '../_lib/takeit-score.js';

/* ───────────────────────────── Fixtures ──────────────────────────── */

// sigmoid(ln 3) = 1 / (1 + 1/3) = 3/4, so a logit of ±ln 3 lands on 0.75 / 0.25.
const LN3 = Math.log(3);

/**
 * Leaf values live in split_conditions, as in XGBoost's JSON. Each leaf's
 * base_weights is deliberately 20x its value (as tree_method='exact' stores
 * it at eta 0.05), so a walk that read base_weights would be off 20x in
 * every test below with a nonzero leaf, not only the dedicated walkTree one.
 */
const PRE_ETA = 20;

/** A leaf-only tree: one node, no split, leaf value `w`. */
function leaf(w: number): XGBTree {
  return {
    left_children: [-1],
    right_children: [-1],
    split_indices: [0],
    split_conditions: [w],
    default_left: [0],
    base_weights: [w * PRE_ETA],
  };
}

/**
 * A depth-1 tree. Node 0 splits on `features[featureIdx] < threshold`; node 1
 * is the left leaf and node 2 the right leaf. `defaultLeft` routes a missing
 * value (1 = left, 0 = right).
 */
function stump(
  featureIdx: number,
  threshold: number,
  defaultLeft: 0 | 1,
  leftLeaf: number,
  rightLeaf: number,
): XGBTree {
  return {
    left_children: [1, -1, -1],
    right_children: [2, -1, -1],
    split_indices: [featureIdx, 0, 0],
    split_conditions: [threshold, leftLeaf, rightLeaf],
    default_left: [defaultLeft, 0, 0],
    base_weights: [0, leftLeaf * PRE_ETA, rightLeaf * PRE_ETA],
  };
}

/**
 * A depth-2 tree:
 *   node 0: features[0] < 0 ? node 1 : node 2   (missing -> left)
 *   node 1: features[1] < 5 ? node 3 : node 4   (missing -> right)
 *   node 2: leaf 0.5
 *   node 3: leaf -0.125
 *   node 4: leaf 0.375
 */
function twoLevelTree(splitType?: number[]): XGBTree {
  return {
    left_children: [1, 3, -1, -1, -1],
    right_children: [2, 4, -1, -1, -1],
    split_indices: [0, 1, 0, 0, 0],
    split_conditions: [0, 5, 0.5, -0.125, 0.375],
    default_left: [1, 0, 0, 0, 0],
    base_weights: [0, 0, 0.5 * PRE_ETA, -0.125 * PRE_ETA, 0.375 * PRE_ETA],
    ...(splitType ? { split_type: splitType } : {}),
  };
}

// Knots on dyadic values so each interpolated output is exact in float32.
// 'clip' is what the exporter writes and the only mode assertBundleCompat
// accepts.
const SPLINE: IsotonicSpline = {
  x_thresholds: [0.25, 0.5, 1],
  y_thresholds: [0.125, 0.5, 0.75],
  out_of_bounds: 'clip',
};

/**
 * Two features (a, b), base_score 0.5 (logit 0) and two stumps:
 *   tree 1: a < 10 ? +ln 3 : -ln 3   (missing a -> left, +ln 3)
 *   tree 2: b < 0  ? +ln 3 : 0       (missing b -> right, 0)
 * Calibrated through SPLINE.
 */
function makeBundle(overrides: Partial<TakeitBundle> = {}): TakeitBundle {
  return {
    version: 'v-test',
    alert_type: 'lottery',
    trained_on_date: '2026-10-26',
    win_label_threshold_pct: 20,
    xgb_json_schema: '2.1',
    feature_cols: ['a', 'b'],
    top_tickers: [],
    categorical_cols: [],
    feature_derivation_constants: {},
    xgb_model: {
      learner: {
        learner_model_param: { base_score: '[5E-1]' },
        gradient_booster: {
          model: {
            trees: [stump(0, 10, 1, LN3, -LN3), stump(1, 0, 0, LN3, 0)],
          },
        },
      },
    },
    isotonic: SPLINE,
    ...overrides,
  };
}

function bundleWithModel(baseScore: string, trees: XGBTree[]): TakeitBundle {
  return makeBundle({
    xgb_model: {
      learner: {
        learner_model_param: { base_score: baseScore },
        gradient_booster: { model: { trees } },
      },
    },
  });
}

/** Run `fn` and return the Error it threw; fail if it returned normally. */
function caught(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`expected an Error, got ${String(err)}`, { cause: err });
  }
  throw new Error('expected a throw, got a normal return');
}

/** Assert `fn` throws a BundleSchemaError, by class, name and exact message. */
function expectBundleSchemaError(fn: () => unknown, message: string): void {
  const err = caught(fn);
  expect(err).toBeInstanceOf(BundleSchemaError);
  expect(err.name).toBe('BundleSchemaError');
  expect(err.message).toBe(message);
}

/* ───────────────────────────── Constants ─────────────────────────── */

describe('TAKEIT_GATE_EXEMPT_MIN_PROB', () => {
  it('is 0.70, the gate-exempt crossover from the gate-fix design doc', () => {
    expect(TAKEIT_GATE_EXEMPT_MIN_PROB).toBe(0.7);
  });
});

describe('BundleSchemaError', () => {
  it('is an Error subclass named BundleSchemaError that keeps its message', () => {
    const err = new BundleSchemaError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BundleSchemaError);
    expect(err.name).toBe('BundleSchemaError');
    expect(err.message).toBe('boom');
  });
});

/* ─────────────────────────── assertBundleCompat ──────────────────── */

describe('assertBundleCompat', () => {
  it('accepts a valid bundle whose xgb_json_schema is 2.1 (the supported set)', () => {
    expect(() => assertBundleCompat(makeBundle())).not.toThrow();
  });

  it.each([
    ['2.0', 'unsupported xgb_json_schema=2.0 (supported: 2.1)'],
    ['3.0', 'unsupported xgb_json_schema=3.0 (supported: 2.1)'],
    ['2.1.0', 'unsupported xgb_json_schema=2.1.0 (supported: 2.1)'],
  ])('rejects xgb_json_schema %s with BundleSchemaError', (schema, message) => {
    expectBundleSchemaError(
      () => assertBundleCompat(makeBundle({ xgb_json_schema: schema })),
      message,
    );
  });

  it.each([
    // applyIsotonic always clips, so a 'nan' spline would score differently
    // from Python.
    ['nan', 'nan'],
    // sklearn's IsotonicRegression defaults to 'nan', and export_model.py
    // always writes the field, so an absent value is not a known 'clip'.
    ['absent', undefined],
  ] as const)(
    'rejects isotonic.out_of_bounds %s with BundleSchemaError',
    (_label, outOfBounds) => {
      const isotonic = { ...SPLINE, out_of_bounds: outOfBounds };
      expectBundleSchemaError(
        () => assertBundleCompat(makeBundle({ isotonic })),
        `unsupported isotonic.out_of_bounds=${String(outOfBounds)} (supported: clip)`,
      );
    },
  );

  it('rejects a structurally invalid bundle (empty tree list)', () => {
    expectBundleSchemaError(
      () => assertBundleCompat(bundleWithModel('[5E-1]', [])),
      'TakeitBundle validation failed at xgb_model.learner.gradient_booster.model.trees: xgb_model.trees must be non-empty',
    );
  });

  describe('every per-node tree array must match left_children in length', () => {
    // A short split_conditions used to pass and score as NaN at a leaf, or
    // send every value right at a split; so did a short default_left. The
    // message names the first short array (in schema order) and both lengths,
    // so a Sentry event can be triaged without the 3.5 MB bundle. The
    // malformed tree is second, so the path names trees.1.
    const where =
      'TakeitBundle validation failed at xgb_model.learner.gradient_booster.model.trees.1';

    it.each([
      'right_children',
      'split_indices',
      'split_conditions',
      'default_left',
      'base_weights',
      'split_type',
    ] as const)('rejects a tree whose %s is one entry short', (key) => {
      const tree = twoLevelTree([0, 0, 0, 0, 0]);
      tree[key] = tree[key]!.slice(1);
      expectBundleSchemaError(
        () => assertBundleCompat(bundleWithModel('[5E-1]', [leaf(0), tree])),
        `${where}: ${key} length 4 != left_children length 5`,
      );
    });

    it('rejects an empty split_conditions on a leaf-only tree', () => {
      const tree = { ...leaf(0), split_conditions: [] };
      expectBundleSchemaError(
        () => assertBundleCompat(bundleWithModel('[5E-1]', [leaf(0), tree])),
        `${where}: split_conditions length 0 != left_children length 1`,
      );
    });

    it('rejects a tree whose left_children is the longer array', () => {
      // Every other array is now short; right_children is reported first.
      const tree = twoLevelTree();
      tree.left_children = [...tree.left_children, -1];
      expectBundleSchemaError(
        () => assertBundleCompat(bundleWithModel('[5E-1]', [leaf(0), tree])),
        `${where}: right_children length 5 != left_children length 6`,
      );
    });

    it('accepts a tree with no split_type, or one of full length', () => {
      expect(() =>
        assertBundleCompat(
          bundleWithModel('[5E-1]', [
            twoLevelTree(),
            twoLevelTree([0, 0, 0, 0, 0]),
          ]),
        ),
      ).not.toThrow();
    });
  });

  it('runs structural validation before the version check', () => {
    // '' fails the schema's min(1) before the supported-set lookup runs, so
    // the message names the field rather than "unsupported xgb_json_schema=".
    const err = caught(() =>
      assertBundleCompat(makeBundle({ xgb_json_schema: '' })),
    );
    expect(err).toBeInstanceOf(BundleSchemaError);
    expect(err.name).toBe('BundleSchemaError');
    expect(err.message).toMatch(
      /^TakeitBundle validation failed at xgb_json_schema: /,
    );
  });
});

/* ───────────────────────────── parseBaseScore ────────────────────── */

describe('parseBaseScore', () => {
  it.each([
    // XGBoost's own form: a bracketed float32 in scientific notation.
    ['[6.012309E-1]', 0.6012309],
    ['[5E-1]', 0.5],
    // Bare number, no brackets.
    ['0.5', 0.5],
    ['1e-1', 0.1],
    // Outer whitespace is trimmed before the brackets are stripped.
    ['  [0.25]\n', 0.25],
    // Whitespace inside the brackets is ignored by Number().
    ['[ 0.75 ]', 0.75],
    // Each bracket is stripped on its own, so a lone one is fine.
    ['[0.5', 0.5],
    ['0.5]', 0.5],
    // No range check here: inverseSigmoid rejects these in predictTakeitScore.
    ['-0.5', -0.5],
    // Number('') is 0, so empty brackets parse as 0 (and are then rejected
    // by predictTakeitScore as out of (0, 1); see below).
    ['[]', 0],
  ])('parses %j as %d', (raw, expected) => {
    expect(parseBaseScore(raw)).toBe(expected);
  });

  it.each([
    ['abc'],
    ['[abc]'],
    // Only one bracket is stripped from each end.
    ['[[0.5]]'],
    ['NaN'],
    ['[Infinity]'],
    ['-Infinity'],
    ['1/2'],
  ])('throws BundleSchemaError for %j', (raw) => {
    expectBundleSchemaError(
      () => parseBaseScore(raw),
      `base_score not finite: ${raw}`,
    );
  });
});

/* ──────────────────────────────── walkTree ───────────────────────── */

describe('walkTree', () => {
  it('returns the leaf value of a leaf-only tree, whatever the features', () => {
    expect(walkTree(leaf(0.42), [])).toBe(0.42);
    expect(walkTree(leaf(-1.5), [1, 2, 3])).toBe(-1.5);
  });

  it('reads the leaf value from split_conditions, not base_weights', () => {
    // XGBoost's JSON keeps a leaf's value in split_conditions; base_weights
    // is not always the leaf value. Here every base_weights entry
    // deliberately differs from the leaf value (20x, as exact stores it at
    // eta 0.05), so a walk that read it would return 5 or -15.
    const exactStump: XGBTree = {
      left_children: [1, -1, -1],
      right_children: [2, -1, -1],
      split_indices: [0, 0, 0],
      split_conditions: [10, 0.25, -0.75],
      default_left: [0, 0, 0],
      base_weights: [0, 5, -15],
    };
    expect(walkTree(exactStump, [1])).toBe(0.25);
    expect(walkTree(exactStump, [20])).toBe(-0.75);
  });

  describe('numeric split: value < threshold goes left, else right', () => {
    const tree = stump(0, 10, 1, 0.25, -0.75);
    it.each([
      [5, 0.25],
      [9.999, 0.25],
      [-Infinity, 0.25],
      // Equal to the threshold is not "<", so it goes right.
      [10, -0.75],
      [10.5, -0.75],
      [Infinity, -0.75],
    ])('feature %d -> leaf %d', (value, expected) => {
      expect(walkTree(tree, [value])).toBe(expected);
    });
  });

  describe('missing value follows default_left', () => {
    const leftDefault = stump(0, 10, 1, 0.25, -0.75);
    const rightDefault = stump(0, 10, 0, 0.25, -0.75);
    it.each([
      ['null', [null]],
      ['NaN', [Number.NaN]],
      // features[0] is undefined when the vector is too short.
      ['absent (undefined)', []],
    ] as const)(
      '%s -> left when default_left=1, right when 0',
      (_label, features) => {
        expect(walkTree(leftDefault, features)).toBe(0.25);
        expect(walkTree(rightDefault, features)).toBe(-0.75);
      },
    );

    // The type says number | null, but a vector built from untyped JSON is
    // not checked. Any non-number is missing, never coerced: '5' is not 5,
    // true is not 1, and 'abc' does not become NaN-goes-right.
    it.each([
      ['the string "abc"', 'abc'],
      ['the numeric string "5"', '5'],
      ['true', true],
      ['false', false],
      ['an object', {}],
    ])('%s -> left when default_left=1, right when 0', (_label, value) => {
      const features = [value] as unknown as number[];
      expect(walkTree(leftDefault, features)).toBe(0.25);
      expect(walkTree(rightDefault, features)).toBe(-0.75);
    });
  });

  it.each([
    // f0 < 0 -> node 1; f1 < 5 -> node 3.
    [[-1, 1], -0.125],
    // f0 < 0 -> node 1; f1 >= 5 -> node 4.
    [[-1, 9], 0.375],
    // f0 >= 0 -> node 2, f1 never read.
    [[1, 1], 0.5],
    [[1, null], 0.5],
    // f0 missing -> node 1 (default left); f1 = 1 < 5 -> node 3.
    [[null, 1], -0.125],
    // f0 < 0 -> node 1; f1 missing -> node 4 (default right).
    [[-1, null], 0.375],
  ])('two-level tree: features %j -> leaf %d', (features, expected) => {
    expect(walkTree(twoLevelTree(), features)).toBe(expected);
  });

  it.each([
    // float32 spacing between 2^27 and 2^28 is 16. The nearest multiple of 16
    // to both -200,000,010 and -200,000,012 is -200,000,016, so they compare
    // equal in float32 and the split goes right, although -200,000,012 is
    // smaller in float64.
    [-200_000_012, -0.75],
    // -200,000,030 rounds to -200,000,032, below -200,000,016: left.
    [-200_000_030, 0.25],
  ])(
    'compares in float32: feature %d vs threshold -200000010 -> leaf %d',
    (value, expected) => {
      const tree = stump(0, -200_000_010, 1, 0.25, -0.75);
      expect(walkTree(tree, [value])).toBe(expected);
    },
  );

  it.each([
    ['absent', undefined],
    // walkTree alone tolerates this; assertBundleCompat rejects such a tree
    // at load (see the per-node array-length tests above).
    ['shorter than the node arrays', []],
    ['all zero', [0, 0, 0, 0, 0]],
  ])('treats split_type %s as numeric', (_label, splitType) => {
    expect(walkTree(twoLevelTree(splitType), [-1, 9])).toBe(0.375);
  });

  it('throws BundleSchemaError on a categorical split at the root', () => {
    expectBundleSchemaError(
      () => walkTree(twoLevelTree([1, 0, 0, 0, 0]), [-1, 9]),
      'categorical split at node 0 (split_type=1) is not supported',
    );
  });

  it('names the node of a categorical split below the root', () => {
    expectBundleSchemaError(
      () => walkTree(twoLevelTree([0, 2, 0, 0, 0]), [-1, 9]),
      'categorical split at node 1 (split_type=2) is not supported',
    );
  });

  describe('malformed trees fail at the depth cap', () => {
    // Node 0 is its own left and right child, so the walk never reaches a leaf.
    const cyclic: XGBTree = {
      left_children: [0],
      right_children: [0],
      split_indices: [0],
      split_conditions: [0],
      default_left: [1],
      base_weights: [0],
    };

    it('throws a plain Error naming an unknown tree id', () => {
      const err = caught(() => walkTree(cyclic, [1]));
      expect(err).not.toBeInstanceOf(BundleSchemaError);
      expect(err.name).toBe('Error');
      expect(err.message).toBe('walkTree exceeded depth cap; tree id=unknown');
    });

    it('names the tree id when the tree object carries one', () => {
      const withId = { ...cyclic, id: 7 };
      const err = caught(() => walkTree(withId, [1]));
      expect(err.message).toBe('walkTree exceeded depth cap; tree id=7');
    });

    it('treats a child index past the node arrays as malformed, not a leaf', () => {
      // Node 0 sends every value to node 5, which does not exist. Its child
      // lookups read undefined, never -1, so the walk loops to the cap
      // instead of returning an undefined leaf value.
      const dangling: XGBTree = {
        left_children: [5],
        right_children: [5],
        split_indices: [0],
        split_conditions: [0],
        default_left: [1],
        base_weights: [0],
      };
      const err = caught(() => walkTree(dangling, [1]));
      expect(err.message).toBe('walkTree exceeded depth cap; tree id=unknown');
    });
  });
});

/* ────────────────────────────── applyIsotonic ────────────────────── */

describe('applyIsotonic', () => {
  it.each([
    // Below the first knot: clipped to y[0].
    [0, 0.125],
    [0.1, 0.125],
    [-Infinity, 0.125],
    // Exactly on the first knot.
    [0.25, 0.125],
    // Between knots 0 and 1: t = (0.375 - 0.25) / 0.25 = 0.5,
    // y = 0.125 + 0.5 * (0.5 - 0.125) = 0.3125.
    [0.375, 0.3125],
    // Exactly on the interior knot.
    [0.5, 0.5],
    // Between knots 1 and 2: t = (0.75 - 0.5) / 0.5 = 0.5,
    // y = 0.5 + 0.5 * (0.75 - 0.5) = 0.625.
    [0.75, 0.625],
    // Exactly on the last knot.
    [1, 0.75],
    // Above the last knot: clipped to y.at(-1).
    [1.5, 0.75],
    [Infinity, 0.75],
  ])(
    'maps %d to %d on knots x=[0.25,0.5,1] y=[0.125,0.5,0.75]',
    (x, expected) => {
      expect(applyIsotonic(SPLINE, x)).toBe(expected);
    },
  );

  it.each([
    // Knots on y = x^2. Each x sits at a segment midpoint, so t = 0.5 and
    // y = (y_lo + y_hi) / 2. With 5 knots the binary search moves both lo
    // and hi to reach the inner segments.
    [0.125, 0.03125], // (0 + 0.0625) / 2
    [0.375, 0.15625], // (0.0625 + 0.25) / 2
    [0.625, 0.40625], // (0.25 + 0.5625) / 2
    [0.875, 0.78125], // (0.5625 + 1) / 2
  ])('binary-searches 5 knots: %d -> %d', (x, expected) => {
    const spline: IsotonicSpline = {
      x_thresholds: [0, 0.25, 0.5, 0.75, 1],
      y_thresholds: [0, 0.0625, 0.25, 0.5625, 1],
    };
    expect(applyIsotonic(spline, x)).toBe(expected);
  });

  it('works in float32: input, knots and output are single-precision', () => {
    const identity: IsotonicSpline = {
      x_thresholds: [0, 1],
      y_thresholds: [0, 1],
    };
    // 0.3 is not a float32; its nearest float32 is 0.30000001192092896, and
    // the identity spline returns that, not 0.3.
    expect(applyIsotonic(identity, 0.3)).toBe(Math.fround(0.3));
    expect(applyIsotonic(identity, 0.3)).not.toBe(0.3);

    // Clipped and on-knot outputs are float32-rounded knot values too.
    const offGrid: IsotonicSpline = {
      x_thresholds: [0, 0.1, 1],
      y_thresholds: [0.2, 0.1, 1],
    };
    expect(applyIsotonic(offGrid, -1)).toBe(Math.fround(0.2));
    expect(applyIsotonic(offGrid, 0.1)).toBe(Math.fround(0.1));
  });

  describe('NaN in gives NaN out, never a clipped or knot value', () => {
    // The first two knots share an x. NaN used to fall through the clip
    // checks and the search to that zero-width segment and return y[0].
    const sharedFirstX: IsotonicSpline = {
      x_thresholds: [0.25, 0.25, 1],
      y_thresholds: [0.125, 0.5, 0.75],
    };

    it.each([
      ['distinct knots', SPLINE],
      ['first two knots sharing an x', sharedFirstX],
    ])('on %s', (_label, spline) => {
      expect(applyIsotonic(spline, Number.NaN)).toBeNaN();
    });

    it.each([
      // On or below the shared x: clipped to y[0].
      [0.25, 0.125],
      // The search lands on knots 1 and 2 (x 0.25 -> 1), never the
      // zero-width segment: t = 0.375 / 0.75 = 0.5, y = 0.5 + 0.5 * 0.25.
      [0.625, 0.625],
    ])(
      'still interpolates finite input on the shared-x spline: %d -> %d',
      (x, expected) => {
        expect(applyIsotonic(sharedFirstX, x)).toBe(expected);
      },
    );
  });

  it('returns the input unchanged when there are no knots', () => {
    // Not even float32-rounded. A loaded bundle never gets here: the schema
    // requires at least 2 knots.
    expect(applyIsotonic({ x_thresholds: [], y_thresholds: [] }, 0.3)).toBe(
      0.3,
    );
  });

  it('throws BundleSchemaError when x and y knot counts differ', () => {
    expectBundleSchemaError(
      () => applyIsotonic({ x_thresholds: [0, 1], y_thresholds: [0] }, 0.5),
      'isotonic knot mismatch: x.length=2 y.length=1',
    );
  });
});

/* ────────────────────────────── featuresFromRow ──────────────────── */

describe('featuresFromRow', () => {
  const bundle = makeBundle({ feature_cols: ['a', 'b', 'c', 'd', 'e'] });

  it('orders values by feature_cols and turns missing, null and undefined into null', () => {
    const row = { e: 5, a: 1.5, b: null, c: undefined, extra: 99 };
    // d is absent; extra is not a feature column and is dropped.
    expect(featuresFromRow(bundle, row)).toEqual([1.5, null, null, null, 5]);
  });

  it('keeps falsy and non-finite numbers as they are', () => {
    // 0 must stay 0, not become null. NaN and ±Infinity pass through; walkTree
    // routes NaN by default_left.
    const row = {
      a: 0,
      b: Number.NaN,
      c: Infinity,
      d: -Infinity,
      e: -2.5,
    };
    expect(featuresFromRow(bundle, row)).toEqual([
      0,
      Number.NaN,
      Infinity,
      -Infinity,
      -2.5,
    ]);
  });

  it('returns all nulls for an empty row', () => {
    expect(featuresFromRow(bundle, {})).toEqual([null, null, null, null, null]);
  });

  it('passes non-numeric values from untyped JSON through without coercion', () => {
    // The type says number | null | undefined, but a row parsed from JSON is
    // not checked. featuresFromRow does no coercion or validation: the detect
    // path runs sanitizeScoringInputs (api/_lib/takeit-detect.ts) first, and
    // walkTree treats any non-number that slips through as missing (see the
    // predictTakeitScore test below).
    const row = JSON.parse('{"a":"1.5","b":"abc","c":true,"d":null}') as Record<
      string,
      number | null | undefined
    >;
    expect(featuresFromRow(bundle, row)).toEqual([
      '1.5',
      'abc',
      true,
      null,
      null,
    ]);
  });
});

/* ───────────────────────────── predictTakeitScore ────────────────── */

describe('predictTakeitScore', () => {
  // makeBundle() itself passes assertBundleCompat (tested above), so these
  // run on a bundle the loader would accept.
  it.each([
    // logit = 0 (base 0.5) + tree1 + tree2.
    // a < 10 (+ln 3), b >= 0 (0): sigmoid(ln 3) = 0.75.
    // Calibrated: t = (0.75 - 0.5) / 0.5 = 0.5 -> 0.5 + 0.5 * 0.25 = 0.625.
    [5, 1, 0.75, 0.625],
    // a >= 10 (-ln 3), b >= 0 (0): sigmoid(-ln 3) = 0.25, on the first knot.
    [20, 1, 0.25, 0.125],
    // a >= 10 (-ln 3), b < 0 (+ln 3): logit 0, sigmoid 0.5, on the middle knot.
    [20, -1, 0.5, 0.5],
    // a < 10 (+ln 3), b < 0 (+ln 3): logit ln 9, sigmoid 9/10 = 0.9,
    // float32 0.8999999761581421. Calibrated: t = 0.39999998 / 0.5 =
    // 0.79999995, y = 0.5 + 0.79999995 * 0.25 = 0.69999999 = float32(0.7).
    [5, -1, Math.fround(0.9), Math.fround(0.7)],
    // Missing a -> default left (+ln 3); missing b -> default right (0).
    [null, null, 0.75, 0.625],
    [Number.NaN, Number.NaN, 0.75, 0.625],
  ])(
    'a=%s b=%s -> prob_raw %d, prob_calibrated %d',
    (a, b, raw, calibrated) => {
      expect(predictTakeitScore(makeBundle(), [a, b])).toEqual({
        prob_raw: raw,
        prob_calibrated: calibrated,
      });
    },
  );

  it('scores non-numeric row values from untyped JSON as missing', () => {
    // Coerced, a = '20' would go right (-ln 3) and b = '-1' left (+ln 3):
    // logit 0, prob 0.5. As missing, a goes left (+ln 3) and b right (0),
    // the same 0.75 / 0.625 as an all-null row.
    const bundle = makeBundle();
    const row = JSON.parse('{"a":"20","b":"-1"}') as Record<
      string,
      number | null | undefined
    >;
    const allNull = predictTakeitScore(bundle, [null, null]);
    expect(allNull).toEqual({ prob_raw: 0.75, prob_calibrated: 0.625 });
    expect(predictTakeitScore(bundle, featuresFromRow(bundle, row))).toEqual(
      allNull,
    );
  });

  it('treats base_score as a probability and converts it to a logit', () => {
    // logit(0.75) = ln 3, plus a 0-weight tree, gives sigmoid(ln 3) = 0.75.
    // Adding 0.75 as a raw logit would give sigmoid(0.75) = 0.679 instead.
    const bundle = bundleWithModel('[7.5E-1]', [leaf(0)]);
    expect(predictTakeitScore(bundle, [1, 1]).prob_raw).toBe(0.75);
  });

  it('saturates to exactly 0 or 1 for huge logits, never NaN', () => {
    // sigmoid(1000) = 1 / (1 + e^-1000) = 1. sigmoid(-1000) uses the stable
    // form e^-1000 / (1 + e^-1000) = 0. Calibration clips to the spline ends.
    const high = predictTakeitScore(
      bundleWithModel('0.5', [leaf(1000)]),
      [0, 0],
    );
    expect(high).toEqual({ prob_raw: 1, prob_calibrated: 0.75 });
    const low = predictTakeitScore(
      bundleWithModel('0.5', [leaf(-1000)]),
      [0, 0],
    );
    expect(low).toEqual({ prob_raw: 0, prob_calibrated: 0.125 });
  });

  it('keeps both probabilities in [0, 1] across a grid of inputs', () => {
    const values = [null, Number.NaN, -1e9, -1, 0, 9.99, 10, 1e9];
    for (const a of values) {
      for (const b of values) {
        const { prob_raw, prob_calibrated } = predictTakeitScore(makeBundle(), [
          a,
          b,
        ]);
        expect(prob_raw).toBeGreaterThanOrEqual(0);
        expect(prob_raw).toBeLessThanOrEqual(1);
        expect(prob_calibrated).toBeGreaterThanOrEqual(0);
        expect(prob_calibrated).toBeLessThanOrEqual(1);
      }
    }
  });

  it.each([
    [[1], 'feature vector length 1 != bundle.feature_cols.length 2'],
    [[1, 2, 3], 'feature vector length 3 != bundle.feature_cols.length 2'],
  ])(
    'throws on a feature vector of the wrong length: %j',
    (features, message) => {
      const err = caught(() => predictTakeitScore(makeBundle(), features));
      expect(err.name).toBe('Error');
      expect(err.message).toBe(message);
    },
  );

  it.each([
    ['0', 'base_score 0 out of (0, 1)'],
    ['1', 'base_score 1 out of (0, 1)'],
    ['[1.5]', 'base_score 1.5 out of (0, 1)'],
    ['-0.25', 'base_score -0.25 out of (0, 1)'],
    // parseBaseScore reads empty brackets as 0; the range check catches it.
    ['[]', 'base_score 0 out of (0, 1)'],
  ])('throws BundleSchemaError for base_score %j', (baseScore, message) => {
    expectBundleSchemaError(
      () => predictTakeitScore(bundleWithModel(baseScore, [leaf(0)]), [1, 1]),
      message,
    );
  });

  it('throws BundleSchemaError for a non-numeric base_score', () => {
    expectBundleSchemaError(
      () => predictTakeitScore(bundleWithModel('garbage', [leaf(0)]), [1, 1]),
      'base_score not finite: garbage',
    );
  });

  it.each([
    // An empty split_conditions makes walkTree return an undefined leaf
    // value, and the sum becomes NaN. assertBundleCompat rejects this tree at
    // load; this is the scorer's own guard for a bundle that skipped
    // validation.
    [
      'an empty split_conditions',
      [{ ...leaf(0), split_conditions: [] }],
      'NaN',
    ],
    // Finite leaves whose sum overflows float64.
    ['leaves summing past +MAX_VALUE', [leaf(1e308), leaf(1e308)], 'Infinity'],
    [
      'leaves summing past -MAX_VALUE',
      [leaf(-1e308), leaf(-1e308)],
      '-Infinity',
    ],
  ])(
    'throws BundleSchemaError when the summed logit is not finite: %s',
    (_label, trees, logit) => {
      expectBundleSchemaError(
        () => predictTakeitScore(bundleWithModel('0.5', trees), [1, 1]),
        `logit not finite: ${logit}`,
      );
    },
  );

  it('propagates a categorical-split refusal from any tree', () => {
    const bundle = bundleWithModel('0.5', [
      leaf(0),
      twoLevelTree([1, 0, 0, 0, 0]),
    ]);
    expectBundleSchemaError(
      () => predictTakeitScore(bundle, [-1, 9]),
      'categorical split at node 0 (split_type=1) is not supported',
    );
  });
});
