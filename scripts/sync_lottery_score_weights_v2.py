#!/usr/bin/env python
"""Sync ml/output/lottery_score_weights.json into the v2 TypeScript mirror.

`api/_lib/lottery-score-weights-v2.ts` is the Phase 2 output of the
lottery rescore project (spec: docs/superpowers/specs/lottery-rescore-2026-05-22.md).

This script is intentionally SEPARATE from scripts/sync_lottery_score_weights.py
(the old pipeline, gated off by `make refit` since commit 9512fb34). Phase 3 will
wire up the v2 exports; until then the old file drives production scoring.

Usage:
    ml/.venv/bin/python scripts/sync_lottery_score_weights_v2.py

Idempotent: same JSON in → same TS out.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = ROOT / "ml" / "output" / "lottery_score_weights.json"
TS_PATH = ROOT / "api" / "_lib" / "lottery-score-weights-v2.ts"


def fmt_record(d: dict[str, object], indent: int = 2) -> str:
    """Render a dict as a TS object literal body (one key: value, per line)."""
    pad = " " * indent
    lines = [f"{pad}{k}: {v}," for k, v in d.items()]
    return "\n".join(lines)


def fmt_array(values: list[object]) -> str:
    """Render a list as a TS array literal."""
    return "[" + ", ".join(str(v) for v in values) + "]"


def render_ts(w: dict) -> str:  # noqa: PLR0914 — intentionally flat render function
    f = w["features"]
    cutoffs = w["cutoffs"]
    model_version = w["model_version"]
    trained_at = w["trained_at"]

    # Ticker weights — full universe sorted alphabetically (mirrors JSON order)
    ticker_lines = "\n".join(
        f"  {k}: {v}," for k, v in f["ticker_weights"].items()
    )

    # DTE weights — iterate JSON keys so a future model with DTE 4+ doesn't
    # silently drop entries. Quote keys (TS object literal needs strings since
    # numeric-string keys go through Record<string, number>).
    dte_body = "\n".join(
        f"  '{k}': {v}," for k, v in f["dte_weights"].items()
    )

    # TOD weights
    tod = f["tod_weights"]
    tod_body = (
        f"  AM_open: {tod['AM_open']},\n"
        f"  MID: {tod['MID']},\n"
        f"  LUNCH: {tod['LUNCH']},\n"
        f"  PM: {tod['PM']},"
    )

    # TOD DOW overrides — rendered as nested object. Each inner object uses the
    # same TimeOfDay keys as TOD_WEIGHTS_V2 so the call site can index directly.
    dow_overrides: dict[str, dict[str, int]] = f.get("tod_weights_dow_overrides", {})
    dow_override_lines: list[str] = []
    for dow_name, dow_tod in dow_overrides.items():
        inner = (
            f"    AM_open: {dow_tod['AM_open']},\n"
            f"    MID: {dow_tod['MID']},\n"
            f"    LUNCH: {dow_tod['LUNCH']},\n"
            f"    PM: {dow_tod['PM']},"
        )
        dow_override_lines.append(f"  {dow_name}: {{\n{inner}\n  }},")
    dow_override_body = "\n".join(dow_override_lines)

    # Option type weights
    ot = f["option_type_weights"]

    # Quintile arrays
    vow = fmt_array(f["vol_oi_quintile_weights"])
    vob = fmt_array(f["vol_oi_quintile_boundaries"])
    gw = fmt_array(f["gamma_quintile_weights"])
    gb = fmt_array(f["gamma_quintile_boundaries"])
    aw = fmt_array(f["ask_pct_quintile_weights"])
    ab = fmt_array(f["ask_pct_quintile_boundaries"])

    t1 = cutoffs["t1"]
    t2 = cutoffs["t2"]

    return f'''\
/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate via: ml/.venv/bin/python scripts/sync_lottery_score_weights_v2.py
 *
 * Phase 2 output of the lottery rescore project.
 * Spec: docs/superpowers/specs/lottery-rescore-2026-05-22.md
 * Source JSON: ml/output/lottery_score_weights.json
 *
 * Model version : {model_version}
 * Trained at    : {trained_at}
 *
 * Phase 3 will wire computeLotteryScoreV2() into detect-lottery-fires.ts.
 * Until then the old lottery-score-weights.ts continues to drive production.
 */

// ---------------------------------------------------------------------------
// Ticker weights
// ---------------------------------------------------------------------------

export const LOTTERY_TICKER_WEIGHTS_V2: Readonly<Record<string, number>> = {{
{ticker_lines}
}};

// ---------------------------------------------------------------------------
// Time-of-day weights
// ---------------------------------------------------------------------------

export const TOD_WEIGHTS_V2: Readonly<
  Record<'AM_open' | 'MID' | 'LUNCH' | 'PM', number>
> = {{
{tod_body}
}};

// ---------------------------------------------------------------------------
// TOD DOW overrides  (per-day-of-week override tables; only Monday for now)
//
// 90-day lineage finding (2026-05-22): Monday TOD outcome pattern is fully
// inverted vs Tue-Fri — LUNCH is the only positive Monday slot, AM_open is
// the worst. The global weights (AM_open=+4, LUNCH=-4) work backwards on
// Mondays. This map corrects that without touching the global table.
//
// Schema: {{ [dayName: string]: Record<TimeOfDay, number> }}
// dayName matches `new Date(...).toLocaleDateString('en-US', {{weekday:'long'}})`
// ---------------------------------------------------------------------------

type TimeOfDay = 'AM_open' | 'MID' | 'LUNCH' | 'PM';

export const TOD_WEIGHTS_DOW_OVERRIDES_V2: Readonly<
  Record<string, Readonly<Record<TimeOfDay, number>>>
> = {{
{dow_override_body}
}};

// ---------------------------------------------------------------------------
// DTE weights  (keys are string-encoded integers to survive JSON round-trips)
// ---------------------------------------------------------------------------

export const DTE_WEIGHTS_V2: Readonly<Record<string, number>> = {{
{dte_body}
}};

// ---------------------------------------------------------------------------
// Vol/OI quintile weights + boundaries
// ---------------------------------------------------------------------------

/** Per-quintile score uplift for vol_to_oi_window (length 5, index = quintile 0-4). */
export const VOL_OI_QUINTILE_WEIGHTS: ReadonlyArray<number> = {vow};

/**
 * Boundaries that define the vol/OI quintiles (length 4).
 * Quintile 0 : value < boundaries[0]
 * Quintile k : boundaries[k-1] <= value < boundaries[k]
 * Quintile 4 : value >= boundaries[3]
 */
export const VOL_OI_QUINTILE_BOUNDARIES: ReadonlyArray<number> = {vob};

// ---------------------------------------------------------------------------
// Gamma-at-trigger quintile weights + boundaries
// ---------------------------------------------------------------------------

export const GAMMA_QUINTILE_WEIGHTS: ReadonlyArray<number> = {gw};
export const GAMMA_QUINTILE_BOUNDARIES: ReadonlyArray<number> = {gb};

// ---------------------------------------------------------------------------
// Ask-pct quintile weights + boundaries
// ---------------------------------------------------------------------------

export const ASK_PCT_QUINTILE_WEIGHTS: ReadonlyArray<number> = {aw};
export const ASK_PCT_QUINTILE_BOUNDARIES: ReadonlyArray<number> = {ab};

// ---------------------------------------------------------------------------
// Option type weights
// ---------------------------------------------------------------------------

export const OPT_TYPE_WEIGHTS_V2: Readonly<Record<'C' | 'P', number>> = {{
  C: {ot['C']},
  P: {ot['P']},
}};

// ---------------------------------------------------------------------------
// Tier cutoffs
// ---------------------------------------------------------------------------

export const LOTTERY_TIER_THRESHOLDS_V2 = {{
  t1: {t1},
  t2: {t2},
}} as const;

// ---------------------------------------------------------------------------
// Helper: assign a value to quintile 0-4 using a 4-element boundary array
// ---------------------------------------------------------------------------

/**
 * Map a continuous `value` to a quintile index (0–4) using `boundaries`.
 *
 * Assignment rules (mirrors the Python training logic):
 *   - value < boundaries[0]  → quintile 0
 *   - value < boundaries[1]  → quintile 1
 *   - value < boundaries[2]  → quintile 2
 *   - value < boundaries[3]  → quintile 3
 *   - value >= boundaries[3] → quintile 4
 *
 * @param value      The raw feature value (e.g. vol_to_oi_window).
 * @param boundaries Four-element sorted array of bucket thresholds.
 * @returns          Integer in [0, 4].
 */
export function assignQuintile(
  value: number,
  boundaries: ReadonlyArray<number>,
): number {{
  for (let i = 0; i < boundaries.length; i++) {{
    const bound = boundaries[i];
    if (bound !== undefined && value < bound) return i;
  }}
  return 4;
}}

// ---------------------------------------------------------------------------
// Main score function
// ---------------------------------------------------------------------------

/**
 * Compute the v2 lottery score for a single fire alert.
 *
 * Returns `null` when:
 *   - `args.isAligned` is false (hard gate per spec decision 6)
 *   - `args.dte` is not in {{0, 1, 2, 3}} (out of scoring universe)
 *
 * Otherwise returns an integer sum of per-feature weights:
 *   ticker + tod + dte + vol_oi_quintile + gamma_quintile +
 *   ask_pct_quintile + option_type
 *
 * Null-safe features (volOiWindow, gammaAtTrigger, triggerAskPct) contribute
 * 0 when the value is unavailable rather than invalidating the whole score.
 *
 * `dayOfWeek` (optional): full day name matching
 * `toLocaleDateString('en-US', {{weekday:'long'}})` (e.g. "Monday"). When
 * provided and a matching entry exists in TOD_WEIGHTS_DOW_OVERRIDES_V2, the
 * override table is used for the tod component; otherwise falls back to the
 * global TOD_WEIGHTS_V2. Currently only "Monday" has an override.
 */
export function computeLotteryScoreV2(args: {{
  ticker: string;
  tod: 'AM_open' | 'MID' | 'LUNCH' | 'PM';
  /** Days-to-expiry; only 0, 1, 2, 3 are in the scoring universe. */
  dte: number;
  /** vol_to_oi_window at trigger time; null when not populated. */
  volOiWindow: number | null;
  /** gamma_at_trigger; null when not populated. */
  gammaAtTrigger: number | null;
  /** trigger_ask_pct; null when not populated. */
  triggerAskPct: number | null;
  optionType: 'C' | 'P';
  /**
   * True when the alert direction aligns with net flow:
   * call + cum_ncp > cum_npp, OR put + cum_npp > cum_ncp.
   */
  isAligned: boolean;
  /**
   * Full day name (e.g. "Monday"). When provided and an override exists in
   * TOD_WEIGHTS_DOW_OVERRIDES_V2, that table replaces the global TOD weights
   * for this fire's tod component.
   */
  dayOfWeek?: string;
}}): number | null {{
  if (!args.isAligned) return null;

  const dteKey = String(args.dte);
  if (!(dteKey in DTE_WEIGHTS_V2)) return null;

  // Resolve TOD weights: use DOW override when present, else global.
  const todWeights: Readonly<Record<TimeOfDay, number>> =
    args.dayOfWeek !== undefined && args.dayOfWeek in TOD_WEIGHTS_DOW_OVERRIDES_V2
      ? TOD_WEIGHTS_DOW_OVERRIDES_V2[args.dayOfWeek]!
      : TOD_WEIGHTS_V2;

  let score = 0;

  score += LOTTERY_TICKER_WEIGHTS_V2[args.ticker] ?? 0;
  score += todWeights[args.tod];
  score += DTE_WEIGHTS_V2[dteKey] ?? 0;

  if (args.volOiWindow !== null) {{
    const q = assignQuintile(args.volOiWindow, VOL_OI_QUINTILE_BOUNDARIES);
    score += VOL_OI_QUINTILE_WEIGHTS[q] ?? 0;
  }}

  if (args.gammaAtTrigger !== null) {{
    const q = assignQuintile(args.gammaAtTrigger, GAMMA_QUINTILE_BOUNDARIES);
    score += GAMMA_QUINTILE_WEIGHTS[q] ?? 0;
  }}

  if (args.triggerAskPct !== null) {{
    const q = assignQuintile(args.triggerAskPct, ASK_PCT_QUINTILE_BOUNDARIES);
    score += ASK_PCT_QUINTILE_WEIGHTS[q] ?? 0;
  }}

  score += OPT_TYPE_WEIGHTS_V2[args.optionType];

  return score;
}}

// ---------------------------------------------------------------------------
// Tier label
// ---------------------------------------------------------------------------

/** Map a v2 score to its display tier. null score → 'tier3'. */
export function lotteryScoreTierV2(
  score: number | null,
): 'tier1' | 'tier2' | 'tier3' {{
  if (score === null) return 'tier3';
  if (score >= LOTTERY_TIER_THRESHOLDS_V2.t1) return 'tier1';
  if (score >= LOTTERY_TIER_THRESHOLDS_V2.t2) return 'tier2';
  return 'tier3';
}}
'''


# ---------------------------------------------------------------------------
# Sanity check: mirror the TS score logic in Python so the printed value
# can be cross-checked against the TS runtime.
# ---------------------------------------------------------------------------


def assign_quintile(value: float, boundaries: list[float]) -> int:
    for i, b in enumerate(boundaries):
        if value < b:
            return i
    return 4


def compute_score_python(
    weights: dict,
    ticker: str,
    tod: str,
    dte: int,
    vol_oi_window: float | None,
    gamma_at_trigger: float | None,
    trigger_ask_pct: float | None,
    option_type: str,
    is_aligned: bool,
) -> int | None:
    if not is_aligned:
        return None
    f = weights["features"]
    dte_key = str(dte)
    if dte_key not in f["dte_weights"]:
        return None
    score = 0
    score += f["ticker_weights"].get(ticker, 0)
    score += f["tod_weights"][tod]
    score += f["dte_weights"][dte_key]
    if vol_oi_window is not None:
        q = assign_quintile(vol_oi_window, f["vol_oi_quintile_boundaries"])
        score += f["vol_oi_quintile_weights"][q]
    if gamma_at_trigger is not None:
        q = assign_quintile(gamma_at_trigger, f["gamma_quintile_boundaries"])
        score += f["gamma_quintile_weights"][q]
    if trigger_ask_pct is not None:
        q = assign_quintile(trigger_ask_pct, f["ask_pct_quintile_boundaries"])
        score += f["ask_pct_quintile_weights"][q]
    score += f["option_type_weights"][option_type]
    return score


def main() -> None:
    if not JSON_PATH.exists():
        sys.exit(f"[sync_v2] ERROR: Missing weights JSON: {JSON_PATH}")

    weights = json.loads(JSON_PATH.read_text())
    rendered = render_ts(weights)
    TS_PATH.write_text(rendered)

    # Run prettier on the output so re-runs don't churn the working tree.
    # Without this step, Prettier reformats the long array literals on the
    # first `npm run review` after a sync, producing a permanent diff that
    # gets undone by the next sync. The infinite loop is silent and ugly.
    import subprocess
    result = subprocess.run(
        ["npx", "prettier", "--write", str(TS_PATH)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"[sync_v2] WARNING: prettier failed (returncode={result.returncode})")
        print(f"  stdout: {result.stdout.strip()}")
        print(f"  stderr: {result.stderr.strip()}")

    print(f"[sync_v2] wrote {TS_PATH}")
    print(f"[sync_v2] tickers: {len(weights['features']['ticker_weights'])}")
    print(f"[sync_v2] model: {weights['model_version']}")

    # -----------------------------------------------------------------------
    # Sanity check — replicate TS logic in Python and print expected values
    # for manual cross-verification.
    # Sample fire: AMZN / AM_open / DTE 1 / volOi=0.12 / gamma=0.05 / askPct=0.55 / C / aligned
    # -----------------------------------------------------------------------
    f = weights["features"]
    cutoffs = weights["cutoffs"]
    ticker = "AMZN"
    tod = "AM_open"
    dte = 1
    vol_oi_window = 0.12
    gamma_at_trigger = 0.05
    trigger_ask_pct = 0.55
    option_type = "C"
    is_aligned = True

    score = compute_score_python(
        weights, ticker, tod, dte,
        vol_oi_window, gamma_at_trigger, trigger_ask_pct,
        option_type, is_aligned,
    )

    # Component breakdown for the 9 sanity-check values
    ticker_w = f["ticker_weights"].get(ticker, 0)
    tod_w = f["tod_weights"][tod]
    dte_w = f["dte_weights"][str(dte)]

    vob = f["vol_oi_quintile_boundaries"]
    vq = assign_quintile(vol_oi_window, vob)
    vow = f["vol_oi_quintile_weights"][vq]

    gb = f["gamma_quintile_boundaries"]
    gq = assign_quintile(gamma_at_trigger, gb)
    gw = f["gamma_quintile_weights"][gq]

    ab = f["ask_pct_quintile_boundaries"]
    aq = assign_quintile(trigger_ask_pct, ab)
    aw = f["ask_pct_quintile_weights"][aq]

    ot_w = f["option_type_weights"][option_type]

    print("\n--- Sanity check (AMZN / AM_open / DTE1 / volOi=0.12 / gamma=0.05 / askPct=0.55 / C / aligned) ---")
    print(f"  1. ticker_weight ({ticker})         : {ticker_w}")
    print(f"  2. tod_weight ({tod})       : {tod_w}")
    print(f"  3. dte_weight (DTE {dte})            : {dte_w}")
    print(f"  4. vol_oi_quintile (Q{vq})           : {vow}  [volOi={vol_oi_window} -> Q{vq}]")
    print(f"  5. gamma_quintile (Q{gq})            : {gw}  [gamma={gamma_at_trigger} -> Q{gq}]")
    print(f"  6. ask_pct_quintile (Q{aq})          : {aw}  [askPct={trigger_ask_pct} -> Q{aq}]")
    print(f"  7. option_type ({option_type})              : {ot_w}")
    print(f"  8. is_aligned gate               : PASS (score not null)")
    print(f"  9. TOTAL score                   : {score}")
    t1, t2 = cutoffs["t1"], cutoffs["t2"]
    tier = "tier1" if score >= t1 else ("tier2" if score >= t2 else "tier3")
    print(f"     tier (t1={t1}, t2={t2})      : {tier}")


if __name__ == "__main__":
    main()
