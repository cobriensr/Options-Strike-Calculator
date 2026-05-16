/**
 * Take-It score — pure-TypeScript XGBoost prediction + isotonic calibration.
 *
 * Spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md
 *
 * The bundle JSON is produced by `ml/src/takeit/export_model.py` and contains:
 *   - learner.learner_model_param.base_score (probability, must be inverse-
 *     sigmoid'd to a logit before adding tree outputs).
 *   - learner.gradient_booster.model.trees[] — for each tree:
 *       left_children, right_children (-1, -1 means leaf)
 *       split_indices, split_conditions (feature index + threshold)
 *       default_left (NaN routing, 1 = left, 0 = right)
 *       base_weights (leaf value at each node)
 *   - isotonic.x_thresholds, isotonic.y_thresholds (piecewise-linear knots)
 *
 * Prediction:
 *   logit = inv_sigmoid(base_score) + Σ tree.predict(features)
 *   prob_raw = sigmoid(logit)
 *   prob_calibrated = interp_isotonic(prob_raw)
 *
 * The parity test in api/__tests__/takeit-score.parity.test.ts gates this:
 * every TS prediction must match the Python prediction within 1e-6 on 50
 * production rows. Any divergence fails the build.
 */

const SUPPORTED_XGB_JSON_SCHEMAS: ReadonlySet<string> = new Set(['2.1']);

const LEAF_SENTINEL = -1;

/* ────────────────────────── Bundle types ────────────────────────── */

export interface XGBTree {
  left_children: number[];
  right_children: number[];
  split_indices: number[];
  split_conditions: number[];
  default_left: number[];
  base_weights: number[];
  split_type?: number[];
}

export interface IsotonicSpline {
  x_thresholds: number[];
  y_thresholds: number[];
  out_of_bounds?: 'clip' | 'nan';
}

export interface TakeitBundle {
  version: string;
  alert_type: 'lottery' | 'silentboom';
  trained_on_date: string;
  win_label_threshold_pct: number;
  xgb_json_schema: string;
  feature_cols: string[];
  top_tickers: string[];
  categorical_cols: string[];
  feature_derivation_constants: Record<string, number>;
  xgb_model: {
    learner: {
      learner_model_param: {
        base_score: string;
        num_feature?: string;
      };
      gradient_booster: {
        model: {
          trees: XGBTree[];
          gbtree_model_param?: { num_trees: string };
        };
      };
    };
  };
  isotonic: IsotonicSpline;
  metrics_snapshot?: Record<string, unknown>;
}

export interface ScoreResult {
  prob_raw: number;
  prob_calibrated: number;
}

/* ───────────────────── Bundle integrity checks ──────────────────── */

export class BundleSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleSchemaError';
  }
}

/**
 * Throws BundleSchemaError if the bundle's XGBoost JSON schema isn't in our
 * supported set. Phase 3 spec resolved decision #6: silent miscompute is
 * worse than visibly stuck — fail closed and alert.
 */
export function assertBundleCompat(
  bundle: TakeitBundle,
  supported: ReadonlySet<string> = SUPPORTED_XGB_JSON_SCHEMAS,
): void {
  if (!supported.has(bundle.xgb_json_schema)) {
    throw new BundleSchemaError(
      `unsupported xgb_json_schema=${bundle.xgb_json_schema} (supported: ${[...supported].join(',')})`,
    );
  }
}

/* ────────────────────────── Math helpers ────────────────────────── */

function sigmoid(x: number): number {
  // Numerically stable form for large |x|.
  if (x >= 0) {
    const e = Math.exp(-x);
    return 1 / (1 + e);
  }
  const e = Math.exp(x);
  return e / (1 + e);
}

function inverseSigmoid(p: number): number {
  // logit(p) = ln(p / (1 - p)). p must be in (0, 1) — base_score is fitted
  // from class balance so this holds for the trained bundles.
  if (p <= 0 || p >= 1) {
    throw new BundleSchemaError(`base_score ${p} out of (0, 1)`);
  }
  return Math.log(p / (1 - p));
}

/**
 * Parses the base_score string. XGBoost emits it as a JSON string wrapped in
 * square brackets, e.g. `"[6.012309E-1]"`. The value is a probability for
 * binary:logistic.
 */
export function parseBaseScore(rawBaseScore: string): number {
  const cleaned = rawBaseScore.trim().replace(/^\[|\]$/g, '');
  const v = Number(cleaned);
  if (!Number.isFinite(v)) {
    throw new BundleSchemaError(`base_score not finite: ${rawBaseScore}`);
  }
  return v;
}

/* ──────────────────────── Tree traversal ────────────────────────── */

/**
 * Walk one XGBoost tree to its leaf and return the leaf weight.
 *
 * Direction rule (matches XGBoost C++ src/tree/tree_model.cc):
 *   if isNaN(feature_value): follow default_left[node]
 *   else if feature_value < split_conditions[node]: go left
 *   else: go right
 *
 * Float32 quantization: XGBoost stores split thresholds as float32 and
 * truncates feature values to float32 before comparison (DMatrix is float32).
 * For features with magnitude >~1e7 (e.g. mkt_tide_diff at -2e8), the float32
 * mantissa loses enough precision that a strict `<` comparison in float64
 * can flip relative to XGBoost's float32 comparison. We apply Math.fround()
 * (single-precision round) to both operands so we land on the same branch.
 * Verified against XGBoost's predict(pred_leaf=True) — 0/300 tree mismatches
 * after the cast vs 4/300 without it on rows with large-magnitude features.
 */
export function walkTree(
  tree: XGBTree,
  features: ReadonlyArray<number | null>,
): number {
  let node = 0;
  // Hard cap iterations to defeat malformed trees.
  for (let depth = 0; depth < 1024; depth++) {
    const left = tree.left_children[node]!;
    const right = tree.right_children[node]!;
    if (left === LEAF_SENTINEL && right === LEAF_SENTINEL) {
      return tree.base_weights[node]!;
    }
    // Categorical splits encode `split_conditions` as a bitset, not a numeric
    // threshold; current bundles have split_type all-0 (numeric only). Fail
    // closed if a future retrain ever enables categorical splits — silent
    // miscompute is worse than a visible refusal.
    const splitTypeAtNode = tree.split_type?.[node];
    if (splitTypeAtNode !== undefined && splitTypeAtNode !== 0) {
      throw new BundleSchemaError(
        `categorical split at node ${node} (split_type=${splitTypeAtNode}) is not supported`,
      );
    }
    const featureIdx = tree.split_indices[node]!;
    const value = features[featureIdx];
    const threshold = tree.split_conditions[node]!;
    let goLeft: boolean;
    if (value === null || value === undefined || Number.isNaN(value)) {
      goLeft = tree.default_left[node] === 1;
    } else {
      // Match XGBoost's float32-truncated comparison.
      goLeft = Math.fround(value) < Math.fround(threshold);
    }
    node = goLeft ? left : right;
  }
  throw new Error(
    `walkTree exceeded depth cap; tree id=${(tree as { id?: number }).id ?? 'unknown'}`,
  );
}

/**
 * Predict the calibrated probability for one feature vector.
 *
 * `features` is in `bundle.feature_cols` order. Missing or NaN entries are
 * routed via each tree's default_left bit.
 */
export function predictTakeitScore(
  bundle: TakeitBundle,
  features: ReadonlyArray<number | null>,
): ScoreResult {
  if (features.length !== bundle.feature_cols.length) {
    throw new Error(
      `feature vector length ${features.length} != bundle.feature_cols.length ${bundle.feature_cols.length}`,
    );
  }
  const baseProb = parseBaseScore(
    bundle.xgb_model.learner.learner_model_param.base_score,
  );
  let logit = inverseSigmoid(baseProb);
  const trees = bundle.xgb_model.learner.gradient_booster.model.trees;
  for (const tree of trees) {
    logit += walkTree(tree, features);
  }
  // sklearn isotonic gets a float32 input (XGBoost.predict_proba returns f32).
  // Fround so the parity gate against Python's value is tight.
  const probRaw = Math.fround(sigmoid(logit));
  const probCalibrated = applyIsotonic(bundle.isotonic, probRaw);
  return { prob_raw: probRaw, prob_calibrated: probCalibrated };
}

/* ─────────────────────────── Isotonic ───────────────────────────── */

/**
 * Linear interpolation on the (x_thresholds, y_thresholds) knot pairs that
 * sklearn's IsotonicRegression(out_of_bounds='clip') produces. The Python
 * test_isotonic_knots_round_trip test confirms np.interp on these knots
 * matches sklearn's transform() to 1e-9, so this is the same semantics.
 */
export function applyIsotonic(spline: IsotonicSpline, x: number): number {
  const xs = spline.x_thresholds;
  const ys = spline.y_thresholds;
  if (xs.length === 0) return x;
  if (xs.length !== ys.length) {
    throw new BundleSchemaError(
      `isotonic knot mismatch: x.length=${xs.length} y.length=${ys.length}`,
    );
  }
  // sklearn IsotonicRegression stores X_thresholds_/y_thresholds_ as float32
  // and its transform() returns float32. Cast input + knots + output to single
  // precision so the TS interp matches Python's float32 result bit-for-bit.
  const xf = Math.fround(x);
  const x0f = Math.fround(xs[0]!);
  const xnf = Math.fround(xs.at(-1)!);
  // Clip to range — matches sklearn's default `out_of_bounds='clip'`.
  if (xf <= x0f) return Math.fround(ys[0]!);
  if (xf >= xnf) return Math.fround(ys.at(-1)!);
  // Binary search for the right segment.
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (Math.fround(xs[mid]!) <= xf) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const x0 = Math.fround(xs[lo]!);
  const x1 = Math.fround(xs[hi]!);
  const y0 = Math.fround(ys[lo]!);
  const y1 = Math.fround(ys[hi]!);
  if (x1 === x0) return y0;
  // Op-by-op fround so each intermediate matches sklearn's float32 chain.
  const dx = Math.fround(xf - x0);
  const range = Math.fround(x1 - x0);
  const t = Math.fround(dx / range);
  const dy = Math.fround(y1 - y0);
  const inc = Math.fround(t * dy);
  return Math.fround(y0 + inc);
}

/* ───────────────────── Feature-vector helpers ───────────────────── */

/**
 * Build the feature vector in `bundle.feature_cols` order from a row object.
 * Missing keys become null (treated as NaN by walkTree).
 */
export function featuresFromRow(
  bundle: TakeitBundle,
  row: Readonly<Record<string, number | null | undefined>>,
): Array<number | null> {
  const out: Array<number | null> = new Array(bundle.feature_cols.length);
  for (let i = 0; i < bundle.feature_cols.length; i++) {
    const v = row[bundle.feature_cols[i]!];
    out[i] = v === undefined || v === null ? null : v;
  }
  return out;
}
