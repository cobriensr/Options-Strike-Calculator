# Futures Panel Redesign — Actionable Macro Context

## Problem

The current futures panel shows raw prices, 1H change %, day change %, and volume ratios. This is redundant with TradingView and doesn't help with the core decision: **should I add to this position or tighten up?**

## Use Case

The user is managing open 0DTE SPX positions or deciding whether to enter a directional trade (long call or short put). They need a fast read on whether the macro environment supports their thesis. Time-to-insight needs to be under 2 seconds.

## Design Principles

1. **Signal, not data** — show what the data means, not the raw numbers
2. **Only surface what's moving** — flat instruments are noise
3. **Color = conviction** — background intensity should match magnitude
4. **One-second regime read** — the top of the panel answers "risk on or risk off?"

---

## Proposed Layout

### 1. Regime Banner (top)

A full-width colored bar with a one-line summary:

```
┌─────────────────────────────────────────────────────────────┐
│  🟢 RISK ON — broad strength, vol declining, dollar weak    │
└─────────────────────────────────────────────────────────────┘
```

States:

- **RISK ON** (green) — ES/NQ rising, VX declining or contango, ZN flat/falling
- **RISK OFF** (red) — ES/NQ falling, VX rising or backwardation, ZN rallying, GC rallying
- **MIXED** (amber) — conflicting signals (e.g., tech leading but small caps lagging)
- **VOLATILE** (purple) — VX spiking >2 pts, rapid ES movement, high uncertainty

Logic: score each instrument's 30-min momentum, weight by SPX relevance (ES highest, DX lowest), threshold into regimes.

### 2. Signal Cards (middle)

Replace the current 7-card grid with **3-5 dynamic signal cards** that only show instruments doing something notable. Each card is a sentence, not a data table.

**When ES is moving:**

```
┌──────────────────────────────────────────┐
│  /ES  ▲ +18 pts (30 min)  6,670         │
│  Accelerating on 1.4x volume            │
│  ░░░░░░░░░░░░░░████████ ← momentum bar  │
└──────────────────────────────────────────┘
```

**When VX term structure matters:**

```
┌──────────────────────────────────────────┐
│  /VX  CONTANGO  -0.85 spread            │
│  Front 18.50 → Back 19.35               │
│  Normal vol regime — favorable for       │
│  credit spreads                          │
└──────────────────────────────────────────┘
```

**When flight-to-safety is active:**

```
┌──────────────────────────────────────────┐
│  ⚠ FLIGHT TO SAFETY                     │
│  /ZN +0.5 pts, /GC +1.2% while          │
│  /ES -20 pts (30 min)                    │
│  Institutional exit — tighten stops      │
└──────────────────────────────────────────┘
```

**When CL is spiking:**

```
┌──────────────────────────────────────────┐
│  🛢 CRUDE SPIKE  /CL -26% (1H)          │
│  Deflation signal — vol compression      │
│  favorable if sustained                  │
└──────────────────────────────────────────┘
```

**When DX is surging:**

```
┌──────────────────────────────────────────┐
│  💵 DOLLAR SURGE  /DX +0.8% (1H)        │
│  Strong dollar = equity headwind         │
│  Watch for SPX resistance               │
└──────────────────────────────────────────┘
```

Cards that have nothing notable to report are hidden. If everything is calm, show a single "All quiet — no notable macro moves" card.

### 3. Compact Reference Row (bottom)

For users who still want raw prices, a single condensed row:

```
ES 6,670  NQ 24,244  ZN 110.7  RTY 2,536  CL 82.56  GC 2,350  DX 97.8  VX 18.5/19.4
```

Monospace, small font, muted color. It's there if you need it, but not the focus.

---

## Regime Scoring Algorithm

Score computed from 30-minute momentum of each instrument:

| Instrument | Weight | Bullish Signal     | Bearish Signal      |
| ---------- | ------ | ------------------ | ------------------- |
| ES         | 0.30   | Rising >5 pts      | Falling >5 pts      |
| NQ         | 0.20   | Rising >0.1%       | Falling >0.1%       |
| VX (term)  | 0.20   | Contango deepening | Backwardation       |
| ZN         | 0.10   | Falling (risk on)  | Rising (flight)     |
| GC         | 0.10   | Falling (risk on)  | Rising (fear)       |
| CL         | 0.05   | Stable             | >2% move either way |
| DX         | 0.05   | Falling (risk on)  | Rising (headwind)   |

**Regime thresholds:**

- Score > +0.3 → RISK ON
- Score < -0.3 → RISK OFF
- |Score| < 0.3 but VX spiking → VOLATILE
- Otherwise → MIXED

## Signal Card Trigger Thresholds

| Signal            | Trigger Condition                | Card Style                            |
| ----------------- | -------------------------------- | ------------------------------------- |
| ES Momentum       | \|ES 30m change\| > 10 pts       | Green/red gradient                    |
| ES-NQ Divergence  | \|ES% - NQ%\| > 0.3% (30 min)    | Amber warning                         |
| VX Term Structure | Always shown                     | Blue (contango) / Red (backwardation) |
| Flight to Safety  | ZN up + GC up + ES down (30 min) | Red warning                           |
| CL Spike          | \|CL 1H change\| > 2%            | Orange alert                          |
| DX Surge          | \|DX 1H change\| > 0.5%          | Amber                                 |
| Unusual Calm      | No triggers active               | Gray "all quiet"                      |

---

## Data Requirements

All data already available from `futures_snapshots`:

- `price`, `change_1h_pct` for each symbol
- `vxTermSpread`, `vxTermStructure` for VX

**New data needed (computed in snapshot cron or frontend):**

- 30-minute change (currently only 1H and day — need to add 30-min window)
- ES point change (not just %, raw pts matters for SPX traders)
- Regime score (can compute client-side from existing snapshot data)

## Sparkline Option

Each signal card could include a 60-minute sparkline showing trajectory. Data source: query last 60 bars from `futures_bars` via a new lightweight endpoint, or include in the snapshot response as an array of 60 closes.

**Tradeoff:** Adds ~1 query per symbol per refresh. Could cache aggressively (1-min TTL) since bars only update every minute anyway.

---

## Implementation Phases

### Phase 1: Regime Banner + Signal Cards

- Compute regime score from existing snapshot data (client-side)
- Replace grid with dynamic signal cards
- Keep compact reference row at bottom
- No new API endpoints needed

### Phase 2: Enhanced Signals

- Add 30-min change to snapshot cron
- Add ES point-change display
- Add ES-NQ divergence detection

### Phase 3: Sparklines

- New `/api/futures/sparklines` endpoint returning last 60 closes per symbol
- Render inline SVG sparklines in signal cards
- 1-minute cache TTL

---

## Trading Context Integration

The regime banner and signal cards should also feed into:

1. **Claude analysis context** — the regime state can be injected into the analyze prompt so Claude knows the macro backdrop
2. **Alert messages** — SMS alerts can reference the current regime ("CRUDE SPIKE during RISK OFF regime — heightened vol likely")
3. **Pre-market component** — overnight regime context (was the Globex session risk-on or risk-off leading into the open?)
