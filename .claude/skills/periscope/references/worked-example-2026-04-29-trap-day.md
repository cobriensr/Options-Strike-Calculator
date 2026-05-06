# Worked example — 2026-04-29 morning open (trap-day pattern)

This file is loaded on demand from `SKILL.md` when an analogous setup appears. Read as a counterpoint to the clean 2026-04-30 example that lives in-skill — same chart family, very different trade thesis.

## Setup at the open (08:20–08:30 CT slice)

- Date: Wed 2026-04-29, viewing 4/30 expiry (1DTE).
- Spot ~7,140 at the leftmost open candle (back-read discipline: ignore the red dotted 7,136.18 line — that's the eventual close, future data).
- Cone (yellow diagonals): **upper 7,163.69, lower 7,092.49** — calculated at 9:31 ET (8:31 CT, one minute after the slice ends).
- Cone width ~71 pts, midpoint 7,128 (the ATM strike at calc time). Roughly symmetric around the calc-time spot.

## What the chart showed

- **7150** — biggest green Gamma bar (~+850), large red Charm bar (~−110K, charm-driven /ES buy under the OTM-call decoder), green Positions cluster (~2000). Magnet _and_ cap. Only ~$10 above spot — well inside the upper cone bound at 7163.
- **7165–7200** — secondary +γ layered up to and past the upper cone.
- **7115–7140 (spot zone)** — **empty of structural defense**. Tiny red −γ bars only. No green +γ floor in the band 7115–7140.
- **7100** — meaningful red −γ → acceleration zone, not a floor.
- **7080–7060** — more red Gamma + red Positions → MM short below.
- **7060** — small green +γ; the first hint of a real floor.
- **7020** — huge red Positions bar (the biggest red on the chart).

## The trade thesis the chart supported at the open

This was a **trap setup**, not a clean directional opportunity. Two reads:

1. **Inside-cone magnet:** 7150 is reachable (~$10 above spot, well inside upper cone at 7163). High-probability target but low-reward — only 10 pts of upside.
2. **Asymmetric reward/risk:** 10 pts up to the magnet vs. 30–60 pts down to any meaningful defense. The cone gives ±35 pts of expected move; the structure says any downside drift accelerates with no floor until ~7060, brushing the lower cone bound at 7092.

## The right framing at the open

> Cone-bounded chop day with downside fragility. Reward/risk on a long is poor (10 up / 40+ down). Don't trade inside the no-mans-land 7115–7140. Conditional setups: long ONLY if SPX reclaims 7150 with stop at 7140 (vol breakout); short ONLY if SPX breaks 7115 with target at the lower cone 7092 and stop at 7140. Anything in between is a chop trap.

## What actually happened (debrief — separate from the open read)

- Open ~7140 → early drop to 7115–7120.
- Chop range 7115–7140 through midday.
- ~12–1 PM CT: flush to ~7100 (the low of day, deep into the −γ zone, brushing the lower cone).
- Afternoon recovery to close 7,136.18 (−0.04%, basically flat).

The day delivered exactly what the cone + bar-features implied: chop with a fragile-floor flush nearly to the lower cone, then a recovery as the +γ at 7150 dragged price back. **The chart was screaming "no-trade or asymmetric vol-extension setup" at the open.**

## Common ways this kicks a trader's ass

1. **Long anywhere 7115–7135 expecting the 7150 magnet** — got flushed in the midday drop because there was no +γ floor to defend.
2. **Short the early drop holding for acceleration** — covered too high or held into the recovery; either way the +γ at 7150 dragged price back.
3. **Iron condor inside the cone** — looks like a clean range, but the cone tells you the market is pricing significant vol; the midday flush threatens the lower wing, late-day recovery threatens the upper wing. Range structures need a +γ floor _and_ ceiling; this had only the ceiling.

## The diagnostic the skill should produce on a chart like this

> No-trade or vol-extension day. Cone bounds 7092–7163 are the actionable vol-extension levels; chop inside the cone has no edge given the fragile downside (no +γ floor between spot and ~7060). Long entries require a +γ floor confirmation that doesn't exist here, OR a reclaim of 7150 with the cap then becoming the stop. Short entries require a confirmed break of 7115 targeting the lower cone. Wait for confirmation; don't trade the middle.
