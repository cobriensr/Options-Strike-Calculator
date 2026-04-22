# PAC BOS Config A — TradingView Charting Indicator

**Status:** E1.5 deliverable from the [PAC backtester spec](../docs/superpowers/specs/pac-backtester-2026-04-18.md).

This Pine v6 indicator ports the validated Config A strategy (2022–2024 NQ, 2,729 trades, 89.7% WR, $89K P&L, 36/36 positive months) to TradingView for **visual eyeball-validation only**. It does NOT fire alerts, webhooks, or trade automation. That's Epic 2.

## What it plots

### Structural markers (always on the chart)

- **Swing highs**: small red dots above bars where `pivothigh(5, 5)` confirmed a swing high. These are the levels the strategy watches for bearish breaks.
- **Swing lows**: small green dots below bars where `pivotlow(5, 5)` confirmed a swing low. The levels the strategy watches for bullish breaks.
- **BOS break lines**: when a BOS fires, a blue horizontal line is drawn from the swing bar to the break bar, showing exactly which level got broken. This is the event the strategy is trading.

### Entry + active trade

- **Entry arrow**: green up-triangle (LONG BOS) or red down-triangle (SHORT BOS) at the signal bar.
- **Info label**: direction, z_vwap at entry, ADX, ATR.
- **Stop line** (red dashed): either the most recent correct-side swing extreme, or 2.25× ATR fallback. Extends forward each bar until the trade exits.
- **Target line** (green dashed): 2.0× ATR from entry. Extends forward each bar until the trade exits.

### Exits

When the active trade closes, a labeled marker prints at the exit bar showing **reason + dollar P&L per 1 contract**. Green text = win, red = loss. Reasons:

| Label | Meaning |
|---|---|
| `TARGET` | Intrabar high/low crossed the 2.0× ATR target |
| `STOP` | Intrabar high/low crossed the swing-extreme (or ATR-fallback) stop |
| `OPP` | An opposite-direction BOS signal fired while in trade (EXIT_ONLY semantics) |
| `EOD` | RTH session ended while in trade (force-flat at session close) |

The stop/target lines stop extending once the exit marker prints. A new trade can open on the next qualifying entry.

### Context

- **Event-day tint**: faint orange background on FOMC + OPEX days where trades are suppressed.
- **Status table** (top-right): live view of RTH state, event flag, z_vwap, ADX, ATR.

## Installation

1. Open TradingView → load **NQ1!** (NQ continuous) or **MNQU2026** or whichever contract you trade.
2. Set chart to **1-minute** bars.
3. Set chart timezone to **America/Chicago** (right-click the time axis → change timezone).
4. Open **Pine Editor** (bottom panel).
5. Paste the contents of [pac-bos-config-a.pine](pac-bos-config-a.pine).
6. Click **Save** → give it a name → click **Add to chart**.
7. Verify the top-right status table appears showing live ADX / z_vwap / etc.

## Setting up alerts (JSON webhook + sound)

The indicator fires alerts via two mechanisms. Pick the one that matches how you want to consume signals.

### Option A: Single dynamic alert (webhook + sound together)

Best when you want EVERY long + short signal to hit the same webhook AND play a sound.

1. Right-click the chart → **Add alert** (or press `Alt+A`).
2. **Condition**: pick `PAC BOS Config A — Charting Only` → `Any alert() function call`.
3. **Options** tab:
   - **Notifications** → enable **Play sound** → pick a sound (e.g., "Triangle up" for attention) → set volume.
   - **Webhook URL** → paste your endpoint (e.g., `https://your-domain.vercel.app/api/pac-webhook`).
4. **Message**: leave blank — the Pine script dynamically sets the message body to a JSON payload.
5. Click **Create**.

When a signal fires, TradingView will:

- Play the configured sound
- POST this JSON body to your webhook URL:

```json
{
  "strategy": "pac_bos_config_a",
  "symbol": "NQ1!",
  "action": "long",
  "price": 21425.2500,
  "stop": 21398.5000,
  "target": 21445.7500,
  "z_vwap": 1.42,
  "adx": 28.31,
  "atr": 10.2500,
  "time": "2026-04-21T14:33:00Z"
}
```

### Option B: Two static alerts (independent per-direction control)

Best when you want DIFFERENT delivery channels per direction (e.g., long = webhook only, short = sound only).

1. Right-click chart → **Add alert**.
2. **Condition**: `PAC BOS Config A` → `PAC BOS — LONG entry` (or SHORT).
3. Configure Webhook URL / sound / email independently for each.
4. Repeat for the other direction.

These static alerts send a simple text message: `"PAC BOS LONG on NQ1! @ 21425.25"`. For structured JSON, use Option A.

### Testing the webhook

Use [webhook.site](https://webhook.site) to capture the payload without writing any backend:

1. Open <https://webhook.site> → copy your unique URL.
2. Paste it as the Webhook URL in the TradingView alert.
3. Wait for the next signal (or scroll the chart back and right-click a past BOS arrow → "Create alert here" → fire immediately).
4. Observe the POST body arrive on webhook.site.

### Disabling alerts

The `useAlerts` input at the top of the indicator settings toggles the dynamic `alert()` calls off without removing the indicator. The static `alertcondition()` templates are always available in the alert dialog regardless of that toggle.

## What to watch for (2-week validation protocol)

Goal: see if signals fire with the frequency and quality the backtest predicts, **without trading any of them**.

### Daily log (spreadsheet or journal)

For each trading day, record:

| Field | What to note |
|---|---|
| Date | |
| # LONG signals fired | Backtest avg: ~4/day |
| # SHORT signals fired | Backtest avg: ~3/day |
| Event day? | Y/N (tint visible) |
| Any obviously bad signals? | e.g., signal fires during a news spike, at the bottom of a doji range, etc. |
| ADX at each entry | Top-tercile (31+) entries should feel like "clean trend" bars |
| Entry structure | Did the bar actually look like a BOS breakout? |
| Would-be outcome | Did price reach target, stop, or neither by session close? |

After 2 weeks of logging (~10 trading days, ~60–80 signals):

### Pass criteria

1. **Signal frequency**: ~7/day avg across the window (range 3–15). If < 3 or > 20, something's miscalibrated.
2. **Visual quality**: signals fire on bars that look like genuine breakouts, not noise. If > 20% look like "random bar in chop," the PAC primitives aren't capturing what your eye considers structure.
3. **Would-be WR**: hand-track a sample of 20 signals and see roughly how many hit 2.0× ATR target before 2.25× ATR stop. If < 80% hit target, the backtest is miscalibrated for live conditions.
4. **ADX distribution at entries**: most signals should have ADX > 20. If many signals fire with ADX < 15, the strategy is catching chop rather than trend.

### Fail criteria (stop and investigate)

- Signals fire continuously in chop — you don't see what the indicator is reacting to.
- Stop lines frequently end up on the **wrong side of entry** — means the swing-extreme logic has an edge case live that the backtest didn't expose.
- ATR / ADX values on the info table differ wildly from what TradingView's built-in indicators show — means the Pine math is off.

## Parameters you can tune in the indicator settings

| Input | Default | Tune when |
|---|---|---|
| Swing Length | 5 | Raise to 8 or 10 if too many micro-swings on your chart |
| Stop × ATR | 2.25 | Lower if you want tighter risk per trade |
| Target × ATR | 2.0 | Raise if you want to let winners run further |
| Min z_close_vwap | 1.0 | Raise to 1.5 for fewer, stronger setups |
| RTH-only | on | Off = overnight trading too (backtest didn't test this) |
| Skip events | on | Off = show what would have fired on FOMC/OPEX days |

## Known simplifications vs. the Python backtest

1. **No trade management**: this is a charting indicator. `on_opposite_signal=EXIT_ONLY` and `exit_after_n_bos=2` from the backtest are NOT implemented here. You manually close trades when an opposite signal fires or after 2 same-direction BOS prints.
2. **Session stdev approximation**: Pine's rolling 60-bar stdev of (price − VWAP) stands in for the backtest's cumulative session-reset stdev. The two track closely after ~30 min into the session; pre-10:00 CT z_vwap values may differ slightly. Not a fundamental issue — most trades fire mid/late-session anyway.
3. **FOMC dates hardcoded through 2026** — update the `isFOMC_20XX` blocks in the Pine file when the Fed publishes future calendars.

## After 2 weeks — decision gate

- **Signals look real & right frequency** → proceed to E1.6 (manual-trade journal UI) and start paper-trading a handful of signals to generate a real P&L distribution.
- **Signals look off** → investigate the divergence in the Python backtest first, update the Pine port, and re-run validation.
- **Frequency wildly off** → input parameters may need tuning for your specific contract / timeframe. Revisit `swingLen` and `minZVWAP`.

## Links

- [Python backtest code](../ml/src/pac_backtest/)
- [Engine](../ml/src/pac/engine.py)
- [Spec](../docs/superpowers/specs/pac-backtester-2026-04-18.md)
- [Search-space expansion spec](../docs/superpowers/specs/pac-search-space-expansion-2026-04-20.md)
