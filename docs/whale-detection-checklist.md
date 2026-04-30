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
| **Premium**        | ≥ ticker-specific p95 (see "Per-ticker thresholds" below)                     | Calibrated to each ticker's premium distribution       |
| **One-sidedness**  | ≥ 85% on bid side OR ≥ 85% on ask side                                        | Concentrated direction = real conviction               |
| **Trade count**    | ≥ 5 prints in the same chain                                                  | Single blocks (count = 1) are usually structural       |
| **Moneyness**      | Strike within ±5% of spot                                                     | Far OTM = hedges; far ITM = financing                  |
| **DTE**            | ≤ 14 days                                                                     | Long-dated = positioning, not directional              |
| **No simultaneous paired leg** | If a same-strike same-expiry opposite-side print exists, its trade window must NOT overlap with this leg's window. Sequential rolls (one leg closes as the other opens) are OK — see "Position rolls" in Step 2 | Eliminates pure conversions / reversals while preserving directional rolls |

### Per-ticker premium thresholds

A flat $5M threshold doesn't scale across tickers — SPX and NDX trade at much
larger dollar sizes than QQQ, SPY, or IWM. The threshold below is the **95th
percentile of premium per ticker** across the 11-day outsized-chain universe.
Recompute these every ~30 trading days as the parquet archive grows.

| Ticker     | p50 (typical) | **p95 whale threshold** | p99    | Max     |
| ---------- | ------------- | ----------------------- | ------ | ------- |
| **SPX**    | $2.6M         | **$80.8M**              | $150M  | $1.68B  |
| **SPXW**   | $517K         | **$6.8M**               | $22.1M | $426M   |
| **NDX**    | $2.5M         | **$26.0M**              | $114M  | $128M   |
| **NDXP**   | $251K         | **$2.6M**               | $6.7M  | $10.7M  |
| **QQQ**    | $375K         | **$5.7M**               | $14.5M | $25.5M  |
| **SPY**    | $356K         | **$6.3M**               | $19.2M | $63.6M  |
| **IWM**    | $338K         | **$9.3M**               | $21.2M | $30.4M  |

**Practical floor:** if you're scanning live and don't have these numbers
handy, use **≥ p95 OR ≥ $5M, whichever is lower** as a fast approximation.

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

### Position rolls (special case of pairing)

When a same-strike same-expiry opposite-side print exists, check the trade
windows before disqualifying:

- **Overlapping windows** (legs trade in the same minute or with continuous
  overlap, similar size, mirror-image side): pure synthetic / conversion /
  reversal — ignore. The trade is structural / financing.
- **Sequential windows** (one leg's last trade ≈ other leg's first trade,
  no overlap): position roll — a directional trader changing structure.
  Treat the *active* (later) leg as the whale move and classify it as
  Type 1–4 normally.

Worked example: 2026-04-29 SPXW 7150 had both a call sequence
(09:39 → 11:56:52) and a put sequence (11:56:52 → 14:33:07). The call
*closed* at the exact second the put *opened*. That's a roll — the trader
pivoted from long calls to short puts, both bullish expressions. The
checklist treats this as a Type 1 (floor declared) via the active put-sell
leg, not a synthetic disqualifier.

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
| Premium       | **Between p90 and p99 of the ticker's distribution** (above p99 is usually structural at this DTE; for SPXW that's roughly $5–10M, for QQQ ~$3–8M, for NDXP ~$1.3–4M) |
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
| Paired same-strike ASK + BID prints with **overlapping** trade windows | Pure synthetic — financing / conversion / reversal — ignore |
| (Sequential same-strike legs with non-overlapping windows | **Not a disqualifier** — see "Position rolls" in Step 2) |
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
| No simultaneous paired leg | required | 7150 C closed at 11:56:52 — same second the 7150 P opened — **sequential, not overlapping** = position roll, not synthetic | ✅ |
| **Classification**    | —                                 | **Type 1 (floor declared)** via the active put-sell leg | —     |
| Time modifier         | session extreme required mid-day  | 11:56 CT, immediately after the morning low at 11:34 | ✅ |
| **Trade signal**      | —                                 | **Long SPX/NQ, target 7150, stop 7113** | — |

**Pairing detail:**

| Strike | Side    | First trade | Last trade  | Trade count | Vol    | Premium      |
| ------ | ------- | ----------- | ----------- | ----------- | ------ | ------------ |
| 7150 C | calls   | 09:39:31    | 11:56:52    | 7           | 42,015 | $2,675,540   |
| 7150 P | puts    | 11:56:52    | 14:33:07    | 5           | 12,582 | $12,037,400  |

The call sequence's last trade and the put sequence's first trade share the
same timestamp to the second. The trader was long calls in the morning
(bullish bet, took a loss as SPX faded), then rolled the position into a
short ITM put-sell at the lows (still bullish, now collecting premium).
Both legs express the same directional view — bullish on SPX. The roll
qualifies as a Type 1 whale move via the active put-sell leg.

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
   - No *simultaneous* paired opposite-side same-strike print (sequential rolls are OK — see Step 2)
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
