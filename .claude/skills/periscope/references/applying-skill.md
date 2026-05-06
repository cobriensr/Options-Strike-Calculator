# How to apply the periscope skill (procedural checklist)

This file is loaded on demand. Meta-guidance on how to apply the periscope skill — a procedural checklist version of the rules in `SKILL.md`.

When the user pastes a Periscope chart or asks about exits / stops / direction with one in view:

0. **Verify expiry == chart date (0DTE).** If not, flag it before reading anything else.
1. **Identify spot** from the SPX price label (or the authoritative `spot` value injected by the backend; never the red dotted line on a back-read).
2. **Identify the dominant +γ strikes** (largest green Gamma bars) within ±$30 of spot — those are stop and target candidates.
3. **Tally charm flow** across visible strikes — sum the signed magnitudes to get the day's net mechanical drift direction.
4. **Check Positions for the day's gravitational center** — usually the largest Positions bar marks the strike price wants to drift into.
5. **Check for orange bars** at any structural level — flag flipped regimes, downgrade conviction at those strikes.
6. **Check for cone breach** if straddle lines are shown — signals vol extension, not mean reversion.
7. **State the direction call** based on the charm tally; flag if symmetric / no-trade.
8. **Quote specific stop and target strikes**, not "support area." The chart gives per-strike resolution; use it.
9. **Apply mode-specific weighting** (pre-trade is open-of-day positioning; intraday weighting tilts after 12:30 CT; debrief uses full-session perspective).

The output the user wants is _actionable_: a stop strike, a target strike, a directional bias, and a confidence note from time-of-day. If you can't quote a specific strike, say so explicitly rather than gesturing at a region.
