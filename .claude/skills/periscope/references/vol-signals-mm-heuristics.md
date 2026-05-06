# VolSignals MM Heuristics — Companion Reference

**Status:** PLACEHOLDER — awaiting transcript distillation.
**Source:** YouTube channel [@VolSignals](https://www.youtube.com/@VolSignals) (Imran Lakha and prior-MM contributors, ex-Goldman SPX desk perspective).
**Purpose:** Encode former-MM heuristics about how dealer desks _actually_ hedge SPX/SPY/QQQ flows, so Periscope reads can move from "what the bars show" → "what the desk on the other side is forced to do next."

This file is **read on demand** by the `periscope` skill — it is NOT auto-loaded with the skill body. Cite this file from `SKILL.md` only when a heuristic here is load-bearing for a specific read.

---

## Verification convention

Each heuristic is tagged with a confidence flag. The user is the source of truth — VolSignals framing is informative but not gospel.

- **`[verified]`** — Confirmed against this user's Periscope back-reads or live trades.
- **`[plausible]`** — Imran's framing is internally consistent and aligns with public dealer-flow research, but not yet validated on this trader's setup.
- **`[era-specific]`** — May reflect pre-2022 desk practice (pre-0DTE explosion, pre-FedTrade). Flag whenever cited.
- **`[contested]`** — Conflicts with another trusted source or with Periscope mechanics as written in `SKILL.md`. Surface explicitly before applying.

When citing a heuristic in a Periscope read, include the tag in parentheses, e.g. _"Imran's rule on charm acceleration after 2pm CT [plausible]."_

---

## Section 1 — Dealer hedging mechanics

How desks size, time, and route hedges in response to flow. The mechanics layer underneath every Periscope bar.

> _Empty — populate from videos covering: delta hedging cadence, gamma-driven rehedge frequency, vanna/charm desk decay handling, end-of-day flatten-down behavior, hedge venue choice (cash vs. futures vs. options)._

### Sub-topics to populate

- Intraday rehedge cadence by gamma magnitude
- "Sticky" vs. "responsive" desk regimes
- When desks let inventory drift vs. flatten aggressively
- Cash-equity hedging vs. /ES futures (and how Periscope green/red bars translate)

---

## Section 2 — Charm / vanna behavior

Decay-driven flow that is invisible on most retail charts but is the dominant EoD driver.

> _Empty — populate from videos on: charm acceleration windows, vanna response to vol moves, opex-week vanna unwinds, FOMC/CPI vanna setups._

### Sub-topics to populate

- Charm acceleration timing (afternoon ramp, last-hour flush)
- Vanna's role on vol-down days vs. vol-up days
- How charm-driven /ES drift shows up on Periscope's Charm panel

---

## Section 3 — 0DTE flow attribution

Distinguishing dealer-driven moves from speculative/hedger flow on the day of expiry.

> _Empty — populate from videos on: morning 0DTE positioning reads, charm-vs-flow attribution intraday, when 0DTE structure dominates vs. when it gets overwhelmed by macro flow._

### Sub-topics to populate

- Open-print 0DTE skew tells
- "Dealer is short gamma" days — early signs and intraday escalation
- When 0DTE positioning gets overridden by macro tape

---

## Section 4 — EoD dynamics & MOC mechanics

Last-hour behavior is its own regime — pin pressure, market-on-close imbalance interaction, late vanna unwind.

> _Empty — populate from videos on: pin mechanics, MOC imbalance interpretation, last-30-min charm flush patterns, expiration-day pin failures._

### Sub-topics to populate

- Pin formation vs. pin failure tells
- MOC imbalance vs. dealer hedge direction (when they align vs. fight)
- Late-day +γ floor/ceiling reliability

---

## Section 5 — Vol-shock & event-day behavior

How desks react when realized > implied (or vice versa) — Periscope's cone gets the most useful here.

> _Empty — populate from videos on: CPI/FOMC days, single-stock-event spillover to SPX, vol-of-vol regime shifts, gamma-flip days._

### Sub-topics to populate

- Vol expansion → dealer rehedge cascade (procyclical regime)
- Vol compression → suppressive hedging tightens range
- When the straddle cone is reliable vs. when realized blows through

---

## Section 6 — Cross-asset / SPY-QQQ-ES interactions

How dealer hedging in SPX/SPY/QQQ interacts with /ES futures basis and ETF arbitrage.

> _Empty — populate from videos on: SPY vs. SPX dealer positioning differences, QQQ-as-leading-indicator framing, /ES basis behavior on dealer-flush days._

### Sub-topics to populate

- When SPY flow is the better tell than SPX (links to user's existing "hunt flow in SPY/QQQ first" rule)
- /ES basis as confirmation of dealer hedge direction

---

## Section 7 — Anti-patterns / things Imran says NOT to do

Equally valuable — corrections of common retail misreads.

> _Empty — populate from videos where Imran explicitly debunks a common framing._

---

## Source-video index

Track which video each heuristic came from, so we can re-watch for context if a reading conflicts.

| Heuristic ID | Source video title | URL | Date watched | Tag |
| ------------ | ------------------ | --- | ------------ | --- |
| _empty_      |                    |     |              |     |

---

## Distillation workflow

When the user provides a transcript:

1. Read end-to-end first (don't extract on the first pass).
2. Pull only heuristics that are **specific and falsifiable** (e.g. "after 2pm CT, charm flow accelerates ~2x" — not "dealers hedge their books").
3. Tag each one with confidence (see "Verification convention" above).
4. Add to the relevant section with a one-line citation back to the source-video index.
5. If a heuristic conflicts with `SKILL.md`, flag it as `[contested]` and surface to the user — do NOT silently overwrite the skill.
6. After ~10 heuristics accumulate, audit: which ones have we actually used in reads? Drop the dead weight.
