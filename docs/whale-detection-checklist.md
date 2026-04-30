# Whale Move Detection — Live Trading Checklist

A live, repeatable framework for identifying high-conviction options prints
(whale moves) on indices and ETFs, and translating them into directional
trades. Built from 11 days of UW EOD flow data (2026-04-13 through 2026-04-29)
covering 13,841 outsized chains.

The framework focuses on the question that matters during the day:
**where is the level a whale just declared, and which side of it should I be
on?** It deliberately ignores motivational reads ("is this hedging or a
directional bet?") because those distinctions don't change the trade — only
the level does.

---

## Step 1 — Detection filters

A print must satisfy **all** of the following to qualify as a whale move
worth acting on. If any single filter fails, the print is noise.

| Filter             | Threshold                                                                     | Rationale                                              |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Underlying**     | SPX, SPXW, SPY, QQQ, NDX, NDXP, IWM                                           | Index/ETF flow only — single-name flow is too noisy   |
| **Premium**        | ≥ $5M total                                                                   | Smaller sizes are retail / dispersion noise            |
| **One-sidedness**  | ≥ 85% on bid side OR ≥ 85% on ask side                                        | Concentrated direction = real conviction               |
| **Trade count**    | ≥ 5 prints in the same chain                                                  | Single blocks (count = 1) are usually structural       |
| **Moneyness**      | Strike within ±5% of spot                                                     | Far OTM = hedges; far ITM = financing                  |
| **DTE**            | ≤ 14 days                                                                     | Long-dated = positioning, not directional              |
| **No paired leg**  | The same strike + same expiry must NOT have an opposite-side print same day   | Eliminates conversions, reversals, synthetics          |

---

## Step 2 — Classify the whale move

Once a print passes the filter, classify it by **side** and **strike position
vs spot**:

| Type | Name                       | Side       | Strike vs Spot                           | Direction signal     | Conviction |
| ---- | -------------------------- | ---------- | ---------------------------------------- | -------------------- | ---------- |
| **1** | **Hard floor declared**   | BID (sold) | PUT, strike ≥ spot (ITM) or ≤ 0.5% OTM  | Strongly bullish     | Highest    |
| **2** | **Hard ceiling declared** | BID (sold) | CALL, strike ≤ spot (ITM) or ≤ 0.5% OTM | Strongly bearish     | Highest    |
| **3** | **Floor break expected**  | ASK (bought) | PUT, strike ≤ spot (OTM 0.5–3%)        | Bearish              | High       |
| **4** | **Ceiling break expected**| ASK (bought) | CALL, strike ≥ spot (OTM 0.5–3%)       | Bullish              | High       |

The **strike itself** is the level. Sold puts declare a floor. Sold calls
declare a ceiling. Bought puts/calls bet that the level will break.

---

## Step 3 — Trade action per type

| Type | Entry                                                     | Stop                                                  | Target                                                  | Sizing guidance                                                |
| ---- | --------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| **1**| Long the underlying or buy ATM/NTM calls                  | Below the session low set just before the print       | The strike of the sold put, or next gamma wall above   | ≤ 25% of normal size if mid-day; 50% if 9–10 AM CT             |
| **2**| Short the underlying or buy ATM/NTM puts                  | Above the session high set just before the print      | The strike of the sold call, or next gamma wall below  | Same                                                           |
| **3**| Short the underlying or buy ATM puts                      | Above the prior consolidation high                    | Strike of bought put + safety margin                   | Lean smaller — buying puts is lower historical edge            |
| **4**| Long the underlying or buy ATM calls                      | Below the prior consolidation low                     | Strike of bought call + safety margin                  | Lean smaller                                                   |

---

## Step 4 — Time-of-day modifiers

The same print has different edge depending on when it fires.

| Hour CT     | Type 1/2 (Floor / Ceiling)                                | Type 3/4 (Break)              |
| ----------- | --------------------------------------------------------- | ----------------------------- |
| 08:30–09:00 | Maximum edge — open positioning                           | Maximum edge                  |
| 09:00–10:00 | High edge — best risk/reward window                       | High edge — 78% historical win |
| 10:00–11:00 | Medium edge                                               | Medium edge                   |
| 11:00–12:00 | **High edge IF at session extreme** (low for puts, high for calls) | Medium                        |
| 12:00–13:00 | Medium — usually re-tests the level                       | Low — afternoon chop           |
| 13:00–14:00 | Low — premium harvest dominates                           | Low                           |
| 14:00–15:00 | Avoid — close-related rolls and unwinds                   | Avoid                         |

**Critical mid-day rule:** Type 1 and Type 2 prints fired between 11:00 and
12:00 CT are still high-edge **only if** they coincide with a session
extreme (the print marks the low for a Type 1, or the high for a Type 2).
Mid-day prints away from session extremes are usually premium harvest and
should not be traded.

---

## Step 5 — Multi-leg positioning bets (different play, different rules)

A separate playbook for the 8–14 DTE bucket. These are swing trades, not
intraday — different filter, different action.

| Filter        | Value                                                                |
| ------------- | -------------------------------------------------------------------- |
| Premium       | **$5–10M only** (NOT $10M+ — those are usually structural at this DTE) |
| Side          | ASK (paid premium)                                                  |
| DTE           | 8–14 days                                                           |
| Moneyness     | 1.5–3% OTM                                                          |
| Time          | 9–10 AM CT                                                          |
| Trade count   | ≥ 5                                                                 |

**Trade action:** position smaller and longer in the same direction as the
print. Hold 1–3 days. Historical win rate in this bucket: **78%**.

---

## Step 6 — Disqualifiers (always ignore)

| Pattern                                            | Why it's noise                                          |
| -------------------------------------------------- | ------------------------------------------------------- |
| Trade count = 1 with $10M+ premium                | Single block = box trade or block hedge                  |
| Paired same-strike ASK + BID prints same day      | Synthetic position (conversion / reversal / risk-rev)    |
| Far OTM (>3% out) and ≥ $10M                      | Tail hedge or vol-surface trade, not directional         |
| Single-name (TSLA, NVDA, AAPL, etc.)              | Stock-specific catalyst risk dominates the flow signal   |
| Far DTE (> 30 days)                                | Positioning trade — won't move price intraday            |
| After 14:00 CT                                     | Rolls / closes / EOD positioning — not actionable        |

---

## Worked example — 2026-04-29 SPXW 7150 P

The trade I missed by over-thinking motivation. Working through the
checklist in real time would have caught it.

| Filter                | Required                          | This print                       | Pass? |
| --------------------- | --------------------------------- | -------------------------------- | ----- |
| Index / ETF           | yes                               | SPXW                             | ✅    |
| Premium ≥ $5M         | yes                               | $12,037,400                      | ✅    |
| ≥ 85% one-sided       | yes                               | 95% BID                          | ✅    |
| Trade count ≥ 5       | yes                               | 5                                | ✅    |
| Moneyness ≤ 5%        | yes                               | +0.42% (ITM put — strike > spot) | ✅    |
| DTE ≤ 14              | yes                               | 0                                | ✅    |
| No paired leg         | yes                               | (no 7150 C ASK same day)         | ✅    |
| **Classification**    | —                                 | **Type 1 (floor declared)**     | —     |
| Time modifier         | session extreme required mid-day  | 11:56 CT, immediately after the morning low at 11:34 | ✅ |
| **Trade signal**      | —                                 | **Long SPX/NQ, target 7150, stop 7113** | — |

**Trade map that would have resulted:**

- Entry: 11:56 CT at SPX ~7,120 / QQQ ~$658
- Stop: SPX 7,113 (the morning flush low) — risk 7 points
- Target: SPX 7,150 (the strike of the sold put) — reward 30 points
- R:R ≈ 1:4
- Outcome: SPX rallied above 7,150 by mid-afternoon → ~4R winner

---

## The simplest mnemonic

When a print clears the detection filter, ask three questions in order:

1. **Is it real?**
   - Trade count ≥ 5
   - No paired opposite-side same-strike print
   - Near the money (within 5%)
   - If any answer is no → ignore.

2. **Where is the level?**
   - The strike. That's your target if puts are sold (floor) or your stop-magnet if calls are sold (ceiling).

3. **Are you on the right side of it?**
   - Puts SOLD ITM at the lows → trade up to the strike
   - Calls SOLD ITM at the highs → trade down to the strike
   - Puts BOUGHT OTM near the lows → trade down through the strike
   - Calls BOUGHT OTM near the highs → trade up through the strike

The level is the trade. Don't second-guess motivation.

---

## Historical edge by category (11-day baseline)

For reference — these are the win rates that informed the framework:

| Category                                          | Win rate    | Notes                              |
| ------------------------------------------------- | ----------- | ---------------------------------- |
| ASK-side tells, all hours                         | 47%         | Baseline — no clear edge alone     |
| BID-side tells, all hours                         | 39%         | Baseline                           |
| ASK-side tells, 9–10 AM CT                        | 67%         | Best hour                          |
| BID-side tells, 9–10 AM CT                        | 56%         | Best hour                          |
| 8–14 DTE ASK-side, $5–10M, near-the-money         | 78%         | Highest-edge swing setup           |
| 0DTE ASK-side, all                                | 44%         | Coin flip but huge magnitudes      |
| 0DTE call BID-side at the morning highs           | 0% (n=8)    | Catastrophic — never sell into rip |
| ≥ $10M ASK-side                                   | 22%         | Usually structural — avoid          |
| Tells fired after 11 AM CT                        | < 50%       | Edge degrades through the day      |

---

## Use notes

- This document codifies a framework, not a guarantee. Sample size is 11
  days; treat the win rates as directional, not statistically authoritative.
- Update with new findings every ~30 trading days as the EOD parquet
  archive grows.
- The most actionable rule is **Step 6 disqualifiers**. Most "tells" you
  see on a UW stream are noise; filtering them out is more important than
  identifying the genuine ones.
- Keep a trade journal entry for every whale move you act on. After 30
  trades, recalibrate the win rates against your actual execution.
