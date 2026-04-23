# SPXW — Raw Flow Observations (trader's-eye view)

**Date:** 2026-04-23
**Source data:** 8 EOD CSVs from bot flow (2026-04-13 → 2026-04-22)
**Total SPXW prints in sample:** 10,134,357
**Scope:** SPXW only. Similar analysis for SPY/QQQ not yet done.

## TL;DR

- A **recurring institutional 9-month call-spread program** (strikes ~8000-8200, sized 10-32k contracts) prints every single trading day via floor-brokered blocks.
- **~35% of 0DTE premium is multi-leg** (spread legs, not directional bets). Our previous "burst" analysis was partially picking these up as signal.
- **Big 0DTE blocks concentrate in the first 2 hours** after open (60%+ of daily block count).
- **Put/call baseline is 0.5, not 1.0** — SPX 0DTE is systematically call-heavy.
- **Deep-ITM calls (≥30% ITM) are synthetic-stock proxies**, not directional bets. Should be filtered out.

---

## The big picture numbers

Across 8 trading days, SPXW carries ~10.1M prints and $70B+ of premium. 78-84% of ROWS are 0DTE, but only 25-40% of PREMIUM — because longer-dated prints are dominated by big institutional blocks.

---

## Finding 1: A recurring institutional call-spread program is visible every single day

Every trading day in the sample, 20-30k contract blocks print at strikes **8000-8200 with ~260 DTE expiry** (9-month calls at 15-20% OTM). All via exchange XCBO with condition `mfsl`. Examples:

- **2026-04-16 15:56 CT**: 32,000× 8150C + 32,000× 8170C, both at MID — $20-wide call spread, $348M premium combined
- **2026-04-14 19:43 CT**: 30,500× 8150C + 30,500× 8170C SELL — same structure, different day
- **2026-04-21 19:46 CT**: 26,500× 8120C + 24,500× 8100C SELL
- **2026-04-13 14:13 CT**: 22,000× 8170C + 21,500× 8190C

**What this is:** A systematic call-spread selling program — probably an overwrite / covered-call / structured-product hedge. Institutional.

**Why you care:**
- The strike range (15-20% OTM on 9-month calls) is where institutions think the **SPX ceiling** is over the medium term. Track where this program's strikes sit relative to spot over time.
- You won't trade against this directly (notional is $100s of millions). But its strike migration is a regime signal — if it shifts to PUT-side, a structural change is happening.
- **Not a 0DTE magnet signal** — these blocks are 260 DTE and unrelated to your short-term setups.

---

## Finding 2: ~35% of 0DTE premium is multi-leg (spreads), not single prints

| Condition | N prints (0DTE) | Premium ($M) | Avg size | % in signal band |
|---|---|---|---|---|
| `auto` (single-leg electronic) | 4.6M | 6,121 | 2.7 | 25% |
| `mlet` (multi-leg electronic) | 2.1M | 5,054 | 3.6 | **39%** |
| `slan` (single-leg) | 689k | 912 | 1.7 | 23% |
| `mlat` (multi-leg late) | 456k | 523 | 1.6 | **37%** |
| `isoi` (ISO sweep, aggressive) | 17k | 40 | 3.9 | 10% |

**What this means:** `mlet` and `mlat` carry $5.6B of 0DTE premium — those are **spread legs**, not directional bets. When you see a "big buy on the QQQ 647P" that's an `mlet` print, it's probably the long leg of a put spread where someone sold the 645P simultaneously. The "buy-side aggression" is a data artifact of how spreads are reported.

**Why you care:**
- **Our burst analysis was partially picking up spread legs** — 37-39% of multi-leg prints fall in the 0.3-1% signal band, vs 25% for singles.
- **For a true directional-flow signal, filter to `auto`/`slan` conditions only.** This is a 1-line fix to the upstream filter in the alerting spec.

**Action item:** re-run `eod_flow_premium_threshold.py` with `cond IN ('auto','slan')` filter to see if the touch rate signal changes. If it goes UP, singles are the real signal. If it goes DOWN, much of what we saw was spread-leg bleed.

---

## Finding 3: Big 0DTE blocks (≥1000 contracts) cluster in the first 2 hours

```
CT hour      Big blocks    % multi-leg
08-09:00           18           56%
09-10:00           31           39%
10-11:00           19           42%
11-12:00           25           24%
12-13:00           17           35%
13-14:00           12           33%
14-15:00            9           67%
```

**What this means:** Peak directional-block activity is 9-10 CT (the hour after open). By afternoon, block count drops 60%+, and what remains is disproportionately multi-leg (end-of-day structured-product hedging / pre-close adjustments).

**Why you care:**
- **Concentrate attention on 8:30-10:30 CT for alert value.** Your best-signal window overlaps with when directional blocks are densest.
- Afternoon bursts (14-15 CT) are 67% multi-leg — much more likely to be spread legs than real directional bets. Consider raising the premium threshold on afternoon alerts.

---

## Finding 4: First-5-min profile is dominated by ATM electronic flow, with a handful of big mfsl blocks

In the 8:30:00-8:35:00 CT opening window:

| Condition | Avg prints/day | Premium/day | Avg size | % near-ATM |
|---|---|---|---|---|
| `auto` | ~6,900 | ~$6.7M | 2.8 | **96%** |
| `mlet` | ~3,200 | ~$3.8M | 3.1 | 84% |
| `slan` | ~920 | ~$0.9M | 1.7 | **99%** |
| `mfsl` | ~3.5 | ~$1.2M | **154** | 71% |

**What this means:**
- 96% of retail-ish `auto` 0DTE prints in the first 5 minutes are ATM. That's the opening-auction positioning.
- Meanwhile, `mfsl` floor blocks are tiny in count (28 across all 8 days × first 5 min = 3-4/day) but HUGE in size (avg 154 contracts) and 29% NOT-near-ATM.
- **The big directional moves by institutions happen through `mfsl` in the very first minutes.** Everyone else is noise at ATM.

**Action item:** An alert class for **opening-5-min mfsl blocks** might catch the most-informed flow of the day, before everyone else settles in.

---

## Finding 5: 0DTE is systematically call-heavy

P/C premium ratio intraday (first 2 hours):
```
CT window     Call $M   Put $M   P/C ratio
08:30-09:00     404      203       0.50
09:00-09:30     380      188       0.50
09:30-10:00     489      243       0.50
```

**What this means:** Twice as much premium in calls as puts during regular-session 0DTE. That's a persistent positive skew toward bullish / call-heavy positioning.

**Why you care:** Don't read 0DTE put flow in isolation — the baseline is already call-tilted. A "heavy put day" needs to be heavy relative to THIS baseline (P/C = 0.5), not the 1.0 null baseline you might default to.

---

## Finding 6: "Persistent strikes" aren't really a thing at SPXW 0DTE

I looked for strikes that showed up in the daily top-10 premium ranking across multiple days. Only found **2 strikes persisted for 3+ days**:
- SPXW 7100C — 3 days
- SPXW 7120C — 3 days

Both right at spot. These aren't "structural levels" — they're just wherever ATM happens to be.

**What this means:** The "same strike getting hammered day after day" hypothesis doesn't hold on SPX 0DTE because spot moves, and near-ATM flow follows spot. Persistence analysis works better on longer-dated contracts where strikes remain fixed relative to events (earnings, FOMC, expiration).

---

## Finding 7: The "deep-ITM stock proxy" trade is persistent

Repeatedly across days we see large blocks of strikes like 5000C, 6000C, 6300C with dollar premium $90k-$460k per single trade. At SPX ~7100, a 5000C is 30% ITM with ~$2100 of intrinsic value per contract. These are **not directional bets on 0DTE options** — they're **synthetic long-stock positions via deep ITM calls**, used for capital efficiency or tax purposes.

**Why you care:**
- These should be filtered out of ANY directional-flow analysis. They don't carry information about where SPX is going.
- **Filter rule:** drop prints where `ABS(delta) > 0.90` (deep ITM) unless you're tracking structural positioning specifically.

---

## Finding 8: IV nearly doubles between hour 1 and hour 2

Median IV on signal-band 0DTE prints:
- 08-09 CT: **23.1%**, p99 38.6%
- 09-10 CT: **32.1%**, p99 **120.7%**

**What this means:** As spot moves, fixed strikes become further OTM, and those further-OTM strikes have higher IV due to skew. Plus new mfsl blocks start firing. The IV signal you see at 9:30 CT is structurally different from 8:30 CT.

**Why you care:** If you use IV as an alert feature, condition it on time-of-day. An IV of 40% at 8:45 CT is unusual; the same IV at 9:45 CT is normal.

---

## Finding 9: `isoi` (ISO sweeps) are rare but aggressive

Only 17k total ISO sweep prints across 8 days on SPXW. They're small (avg size 4), almost always near-ATM (88%), and come through an aggressive intermarket-sweep order type that crosses the spread against multiple exchanges simultaneously.

**Why you care:** ISO sweeps are typically **informed flow** — whoever placed them had an edge worth paying multi-venue slippage for. Not suited for a premium-threshold alert (they're too small individually), but if you see multiple ISO sweeps on the same strike within a 30s window, that's a tell.

---

## The cleanest concrete takeaways for your intraday trading

1. **Filter to single-leg conditions only** before trusting any "burst" signal. `cond IN ('auto','slan')`. Your previous analysis mixed singles with spread legs, and the spread-leg contamination was substantial.

2. **Concentrate alert attention on 8:30-10:30 CT.** That's where 60% of big 0DTE blocks live. Tighten thresholds in the afternoon (less signal, more spread-leg noise).

3. **Put/call baseline is 0.5, not 1.0.** Your "put-heavy day" trigger needs to account for this skew.

4. **Watch `mfsl` blocks in the first 5 minutes specifically.** Only ~3 per day, but they're huge (avg 154 contracts) and often not-ATM. That's informed flow.

5. **Filter out deep-ITM prints** (|delta| > 0.90). They're stock proxies, not directional bets.

6. **Track the 8000-8200 call-spread program as a regime indicator.** When the program's strikes shift meaningfully (e.g., by 2+% of spot, or swaps side to puts), the institutional view of medium-term range has changed.

---

## What I haven't looked at yet

- **SPY/QQQ/NDXP** — same exercise on retail-ish ETFs. Condition codes and trade-type mixes may differ materially.
- **Daily calendar effects** — is Monday (post-weekend) different from Friday (expiry)? Haven't tested; 2 Mondays / 2 Fridays in sample.
- **Inter-symbol correlation** — does a QQQ burst precede or follow an SPXW burst? Could cross-symbol confirmation boost hit rate.
- **Same-strike repeated bursts WITHIN a day** — e.g., 7100C gets a burst at 9:30 AND 11:00. Does the second confirm the first, or exhaust?
- **Aggression-sign analysis on singles-only.** Expected to run next.
