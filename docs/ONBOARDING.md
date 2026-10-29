# Onboarding

Start here. This doc covers **what the app is, what's in it, where the data comes from, and what you need to run it.** Once you've read this, [LOCAL_DEV.md](LOCAL_DEV.md) gets you running locally.

## What this app is

A trading workbench for one trader (Charles, the owner) doing **0DTE SPX options**. The center is a Black-Scholes-grounded strike calculator; everything else is context that informs the trade decision — flow, dealer positioning, regime, dark pool levels, news events, prior similar days, AI chart analysis. The trader uses it from ~8:30 AM CT through the close every market day.

It is also a **research platform**: 76 Vercel cron jobs (as of 2026-10-28) and the `uw-stream` websocket service persist live market data to Neon Postgres; the `build-features` cron builds ML features every trading day, and a multi-phase ML research pipeline (GitHub Actions, scheduled runs paused since April 2026) validates signals; the analyze endpoint's "lessons learned" compendium curates each session's review into rules that get injected into the next.

Live at [theta-options.com](https://theta-options.com).

## The single-owner model — read this first

The app is designed around one authenticated owner. If you clone this repo, here's what works for whom:

| You are…                                    | What works                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The owner with all credentials              | Everything                                                                                                 |
| A guest with a `GUEST_ACCESS_KEYS` entry    | Read-only access to data panels (dark pool, GEX, flow). **No access** to the AI analyze endpoint.          |
| An unauthenticated visitor                  | The full calculator with manual SPY/VIX inputs. No live market data. No AI analyze.                        |
| A developer cloning the repo to evaluate it | Frontend dev server runs immediately (Path A in [LOCAL_DEV.md](LOCAL_DEV.md)). UI shows empty data panels. |

This isn't a SaaS — there's no signup flow. The auth model is intentional ([CLAUDE.md](../CLAUDE.md) §"Backend (api/)" explains the design).

---

## The trading-day timeline

Reading the app in the order it gets used helps. See [TRADING_WORKFLOW.md](TRADING_WORKFLOW.md) for the full rules.

| Time (CT)    | Phase            | Panels in focus                                                                                              |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| 7:00 – 8:30  | Pre-market       | `PreMarketInput`, `VIXTermStructure`, `EventDayWarning`, `PreTradeSignals`, `OpeningFlowSignal` (after 8:35) |
| 8:30 – 9:00  | Opening read     | `MarketRegimeSection`, `OpeningRangeCheck`, `DealerRegimeTile`, `DarkPoolLevels`, `LotteryFinder`            |
| 9:00 – 11:00 | Entry windows    | `ChartAnalysis` (Pre-Trade mode), `DeltaRegimeGuide`, `IronCondorSection`, `BWBCalculator`, `Periscope`      |
| 11:00 – 2:00 | Management       | `PositionMonitor`, `Tracker`, `ChartAnalysis` (Mid-Day), `GreekFlowPanel`, `GreekHeatmap`, `IntervalBAFeed`  |
| 2:00 – 3:00  | Exit / new entry | `SilentBoom`, `VegaSpikeFeed`, `Periscope`, `StrikeBattleMap`                                                |
| After close  | Review           | `ChartAnalysis` (Review mode), `SettlementCheck`, `MLInsights` (next morning)                                |

---

## Panel-by-panel guide

Panels (in [src/components/](../src/components/)) are grouped here by purpose, not by where they appear in the UI. For each: what it shows, what API/source feeds it, and which subscription tier is required.

### Calculator core (the math)

| Panel               | Shows                                                            | Data source                                        |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| `SpotPriceSection`  | SPY / SPX inputs + auto-derived ratio                            | Manual + `/api/quotes` (Schwab)                    |
| `IVInputSection`    | VIX / VIX1D / VIX9D / VVIX + 0DTE adjustment                     | `/api/quotes` + CBOE static fallback for VIX1D     |
| `DateTimeSection`   | Date + time (market hours)                                       | Client clock + market hours table                  |
| `AdvancedSection`   | Skew slider, wing width, contracts, kurtosis controls            | Local state                                        |
| `ResultsSection`    | The strike table — 6 delta targets × put/call × premium / Greeks | Pure Black-Scholes computation (no API)            |
| `IronCondorSection` | IC P&L, breakevens, PoP with fat-tail adjustment                 | Pure math                                          |
| `BWBSection`        | Broken-wing butterfly with gamma-anchored sweet spot             | `/api/bwb-anchor` (computed from GEX + charm flow) |
| `BWBCalculator`     | Standalone BWB structure builder                                 | Pure math                                          |
| `RiskCalculator`    | Position sizing, risk tiers, buy/sell mode                       | Local state                                        |
| `HedgeSection`      | Hedge sizing with DTE / extrinsic / IV-expansion modeling        | Pure math                                          |
| `ParameterSummary`  | Compact recap of inputs                                          | Local state                                        |
| `DeltaStrikesTable` | Standalone delta strike table                                    | Pure math                                          |

### Market regime intelligence

| Panel                 | Shows                                                             | Source                                                              |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| `MarketRegimeSection` | Orchestrator container for the regime stack                       | Composes child panels                                               |
| `VIXRegimeCard`       | Current VIX regime (Green / Caution / Elevated / Extreme)         | VIX from quotes + 9,102-day historical stats baked into `src/data/` |
| `VixRegimeBanner`     | Sticky regime ribbon                                              | Same                                                                |
| `DeltaRegimeGuide`    | Delta ceiling for IC / PCS / CCS, DOW + clustering adjusted       | Historical VIX-range data + computed signals                        |
| `VIXTermStructure`    | VIX1D/VIX/VIX9D curve shape (Contango / Fear-spike / Hump / etc.) | `/api/quotes` (Schwab)                                              |
| `VIXRangeAnalysis`    | Historical range + survival heatmap                               | `src/data/vixRangeStats.ts` (static)                                |
| `VolatilityCluster`   | Yesterday's range percentile → today's expected range multiplier  | `/api/yesterday` (Schwab) + computed                                |
| `OpeningRangeCheck`   | First-30-min consumption signal (GREEN / MODERATE / RED)          | `/api/intraday` (Schwab)                                            |
| `RvIvCard`            | 5-day rolling Parkinson RV / IV ratio                             | `/api/yesterday` (Schwab) + VIX1D                                   |
| `PreTradeSignals`     | Compact cards — RV/IV, overnight gap, move breadth                | Multiple sources composed                                           |
| `EventDayWarning`     | FOMC / CPI / NFP / GDP banners + dynamic economic events          | Static calendar + `/api/events` (FRED + Finnhub)                    |
| `DealerRegimeTile`    | Dealer net-gamma posture                                          | `/api/dealer-regime` (Unusual Whales)                               |
| `ZeroGammaPanel`      | Gamma flip level today                                            | UW per-strike GEX                                                   |
| `FlowRegimeBadge`     | Live pill: is today's options flow abnormal for this time of day  | `/api/flow-regime` (uw-stream `ws_option_trades`)                   |
| `Regime0dte`          | 0DTE gamma regime grade + intraday downside triggers              | `/api/regime-0dte` (UW 0DTE GEX + Schwab strike IV + SPX candles)   |

### Flow / dealer positioning

| Panel               | Shows                                                                         | Source                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GreekFlowPanel`    | Greek-weighted flow per ticker (SPX/SPY/QQQ)                                  | Unusual Whales `/greek-flow`                                                                                |
| `GreekHeatmap`      | Per-strike Greek exposure heatmap                                             | Unusual Whales strike-exposure + websocket                                                                  |
| `GexLandscape`      | Full-session gamma landscape                                                  | GEXBot per-strike exposure (`gexbot_api_capture`)                                                           |
| `GexTarget`         | GEX target scoring (which strike will price gravitate to)                     | Computed from strike GEX                                                                                    |
| `Gexbot`            | GEXBot dealer state across index, futures and ETF symbols                     | GEXBot API                                                                                                  |
| `DarkPoolLevels`    | $5M+ dark pool support/resistance levels                                      | Unusual Whales `/darkpool`                                                                                  |
| `LotteryFinder`     | Unusual options flow fires with Take-It scoring                               | UW `option_trades` websocket (uw-stream → `ws_option_trades`) → `detect-lottery-fires` cron → Take-It score |
| `SilentBoom`        | Pre-move detection (vol/OI/flow confluence)                                   | uw-stream `ws_option_trades` → `detect-silent-boom` cron                                                    |
| `OptionsAlerts`     | Full-screen view (`#alerts`) with Lottery Finder and Silent Boom side by side | Same as the two feeds                                                                                       |
| `OpeningFlowSignal` | V4 opening-5min flow rule for SPY+QQQ (~73% OOS win rate)                     | uw-stream `ws_option_trades` ($1M+ tickets, 09:30–09:40 ET)                                                 |
| `PreMarketSignals`  | Container for `OpeningFlowSignal` and `PinSetupTile`                          | Composes child panels                                                                                       |
| `IntervalBAFeed`    | Bid/ask interval pattern feed                                                 | uw-stream `interval_ba` handler (UW `option_trades` for SPY/SPXW/QQQ)                                       |
| `VegaSpikeFeed`     | Vega spike alerts                                                             | UW + computed                                                                                               |
| `StrikeBattleMap`   | Strike-by-strike buyer vs. seller pressure                                    | UW                                                                                                          |
| `TakeItScore`       | Lottery Finder candidate scoring (XGBoost)                                    | Score: `api/_lib/takeit-score.ts`; SHAP flags: sidecar `/takeit/explain` via `takeit-fill-shap` cron        |
| `Periscope`         | Periscope gamma/charm panel + trade plan                                      | `populate-periscope-from-gexbot` cron (GEXBot)                                                              |
| `PeriscopeChat`     | History of persisted Periscope reads + lesson library                         | `/api/periscope-chat-*`, `/api/periscope-lessons-*`                                                         |
| `PeriscopeLottery`  | Cheap far-OTM SPX 0DTE call/put setups from Periscope exposure changes        | `/api/periscope-lottery-feed` (GEXBot-derived slices)                                                       |
| `GammaNodeDetector` | Rule-based setups at the nearest positive-gamma floor/ceiling (E1, E5, PCS)   | `/api/gamma-setups/*`                                                                                       |

### Positions

| Panel             | Shows                                                     | Source                                                                           |
| ----------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `PositionMonitor` | Live SPX 0DTE positions with greeks, P&L, theta decay sim | `/api/positions` (Schwab Trader API) or thinkorswim paperMoney CSV upload        |
| `Tracker`         | Long-term contract tracker with alerts                    | `/api/tracker/*` (spec: `docs/superpowers/specs/contract-tracker-2026-05-17.md`) |
| `SettlementCheck` | Backtest-mode settlement verification                     | Historical candles + computed                                                    |
| `PinRiskAnalysis` | OI heatmap + max pain + pin risk                          | `/api/chain` (Schwab)                                                            |
| `PinSetupTile`    | Pin setup alert                                           | Same                                                                             |

### AI analysis

| Panel             | Shows                                                                                                | Source                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `ChartAnalysis`   | Upload UI for up to 2 Periscope screenshots (gamma + charm) → structure / delta / entry plan / hedge | Anthropic Claude Opus 4.7 via `/api/analyze`               |
| `MLInsights`      | ML pipeline research plots with Claude-written explanations (the scheduled pipeline is paused)       | `/api/ml/plots` (Vercel Blob) + Claude Sonnet 4.6 analysis |
| `ThetaDecayChart` | Theta curve across the remaining session                                                             | Pure computation                                           |

### Futures

| Panel               | Shows                                                     | Source                  |
| ------------------- | --------------------------------------------------------- | ----------------------- |
| `FuturesCalculator` | Day-trade futures P&L calculator (ES, NQ, etc. tick math) | Local state — math only |

### System / utility

| Panel                    | Shows                                                            | Source                                              |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------- |
| `AccessKey`              | Guest-key entry form                                             | `/api/auth/guest-key`                               |
| `AppHeader`              | Branding + status indicators                                     | Mixed                                               |
| `SectionNav`             | Sticky section navigation                                        | Local                                               |
| `NotificationPermission` | PWA push subscription                                            | Browser Notification API → `/api/push/*`            |
| `AlertBanner`            | Active alerts banner                                             | `/api/alerts`                                       |
| `IntervalBAAlertBanner`  | Interval B/A alerts                                              | UW                                                  |
| `UpdateAvailable`        | PWA new-version banner                                           | Service worker                                      |
| `ErrorBoundary`          | React error catcher                                              | Sentry forwarding                                   |
| `BacktestDiag`           | Historical-replay diagnostic panel                               | Local                                               |
| `PanelPrefsModal`        | Show, hide and reorder panels; saved per owner and per guest key | `/api/panel-prefs` (public visitors: browser-local) |

---

## External services & accounts

What you need a paid account / API key for, in rough priority order.

### Required for the core experience

#### 1. Schwab Developer

- **What it powers**: SPY / SPX / VIX / VIX1D / VIX9D / VVIX quotes, option chains (deltas, IV, OI), historical candles, live positions (Trader API).
- **Sign up**: [developer.schwab.com](https://developer.schwab.com). Create an app; register callback URLs `http://localhost:3000/api/auth/callback` (dev) and your prod origin (e.g. `https://theta-options.com/api/auth/callback`).
- **Cost**: Free. Rate limits exist.
- **Env vars**: `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, `OWNER_SCHWAB_ACCOUNT_SHA256` (sha256 of the owner's account number; unset → every login refused), `APP_URL` (builds the OAuth redirect URI), `OWNER_SECRET` (owner session cookie value).
- **Note**: Requires a Schwab brokerage account (the API is "developer access for Schwab customers", not a third-party API). The Trader API exposes only your own positions — there's no impersonation.

#### 2. Anthropic

- **What it powers**: Claude Opus 4.7 chart analysis (`/api/analyze`, with a Sonnet 4.6 fallback and pre-check), weekly lessons curation (Opus 4.7), weekly Periscope lessons curation (Sonnet 4.6), ML plot analysis (Sonnet 4.6, `/api/ml/analyze-plots`).
- **Sign up**: [console.anthropic.com](https://console.anthropic.com).
- **Cost**: ~$0.40–0.60 per `/api/analyze` invocation (up to 2 images + adaptive thinking on Opus 4.7). At ~3 analyses/day × 20 days, expect roughly **$25–40/month** plus background calls (lessons curation, ML plot analysis, Periscope) — call it **$50–100/month** in practice.
- **Env var**: `ANTHROPIC_API_KEY`.
- **Optimization**: Static prompt parts use `cache_control: ephemeral` for ~90% cost reduction on cached portions ([prompt-caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)).

#### 3. Unusual Whales

- **What it powers**: All flow signals (Market Tide, Net Flow, Greek Flow), GEX snapshots, dark pool blocks, websocket feeds via `uw-stream` (flow-alerts, option_trades for the 86-ticker Lottery Finder universe, futures_trades for the CME futures bars, plus handlers for net_flow, gex_strike_expiry, off_lit_trades and Interval B/A, enabled per `WS_CHANNELS`), Periscope screenshots — basically half the data surface.
- **Sign up**: [unusualwhales.com](https://unusualwhales.com).
- **Required tier**: **Advanced** (websocket access for `uw-stream`). Standard tier doesn't include WS.
- **Cost**: Check current pricing — Advanced is in the high-end personal tier range.
- **Env var**: `UW_API_KEY`.

#### 4. OpenAI

- **What it powers**: `text-embedding-3-large` (2000-dim) embeddings for the lessons-learned dedup pipeline and analog-day retrieval (Phase B backend).
- **Sign up**: [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
- **Cost**: Embeddings are cheap. Probably **<$5/month** for personal use.
- **Env var**: `OPENAI_API_KEY`.

#### 5. Neon Postgres (via Vercel Marketplace)

- **What it powers**: All persistent data — snapshots, analyses, flow_data, GEX tables, training_features, lessons, positions. 80+ tables and 191 numbered migrations (as of 2026-10-28).
- **Sign up**: Vercel dashboard → Storage → Connect Database → Neon.
- **Cost**: Free tier (0.5 GB storage) likely insufficient given the data volume; **Pro ~$19/month** is realistic.
- **Env vars**: `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED`. Auto-injected.

#### 6. Upstash Redis (via Vercel Marketplace)

- **What it powers**: Schwab OAuth token storage (with distributed lock for refresh), all rate limiters, caches.
- **Sign up**: Vercel dashboard → Storage → Connect Database → Upstash for Redis.
- **Cost**: Free tier (10,000 commands/day) is **typically enough** for personal use.
- **Env vars**: `KV_REST_API_URL`, `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`).

#### 7. Vercel (the platform itself)

- **What it powers**: Hosting, serverless functions, cron jobs, Blob storage, bot detection.
- **Required tier**: **Pro ($20/month)** — required for the 780s function timeout on `/api/analyze`. Hobby tier caps at 60s and the Claude Opus 4.7 with adaptive thinking will time out.
- **Env vars**: `BLOB_READ_WRITE_TOKEN` (auto-injected when Blob is added).

#### 8. Vercel Blob

- Sub-product of Vercel. Stores ML pipeline plots, the Take-It model bundle, the daily GEXBot archive, Periscope images, the frozen historical archive the sidecar seeds from, and database backups.
- Added via Vercel Storage → Connect → Blob.
- Pay-per-usage; typically **<$1/month** for personal volumes.

#### 9. Sentry

- **What it powers**: Frontend errors, backend errors, performance traces.
- **Sign up**: [sentry.io](https://sentry.io). Connect via Vercel Integrations for auto `SENTRY_DSN`.
- **Cost**: Free tier (5K errors / 10K traces / month) is sufficient.
- **Env vars**: `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` (for source map upload during build).

### Required for the Railway sidecar (Railway service #1)

#### 10. Railway

- **What it powers**: Hosts the `sidecar/` and `uw-stream/` Python services.
- **Sign up**: [railway.app](https://railway.app).
- **Cost**: ~$5–20/month/service for personal usage tier. Two services = budget **~$20–40/month**.
- **Sidecar env vars**: `DATABASE_URL` (only for its `/health` db check), `SENTRY_DSN`, `TAKEIT_SERVER_ENABLED`, `TAKEIT_SIDECAR_SHARED_SECRET`, `ARCHIVE_*`, `BLOB_READ_WRITE_TOKEN`. See [sidecar/README.md](../sidecar/README.md).
- **Vercel env vars for the sidecar**: `SIDECAR_URL` (archive queries for analog days and `fetch-day-ohlc`), `SIDECAR_TAKEIT_URL` and `SIDECAR_TAKEIT_SECRET` (same value as the sidecar's `TAKEIT_SIDECAR_SHARED_SECRET`, sent as a bearer token by the `takeit-fill-shap` cron).

### Required for the websocket consumer (Railway service #2)

- Same `UW_API_KEY` as above (UW Advanced tier required for WS).
- Same `DATABASE_URL`. It writes `ws_flow_alerts`, `ws_option_trades`, `futures_bars`, and (per `WS_CHANNELS`) `ws_gex_strike_expiry`, `ws_net_flow_per_ticker`, `interval_ba_alerts` and `dark_pool_prints`, all in the same Neon instance. Futures bars come from this service since Databento was removed (2026-09-29).
- Other env vars: `WS_CHANNELS` (which channels to subscribe; default `flow-alerts`), `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Upstash connection lease), `VERCEL_NOTIFY_URL` + `INTERNAL_NOTIFY_SECRET` (pushes Interval B/A alerts to `/api/push/notify`; Vercel needs the same `INTERNAL_NOTIFY_SECRET`), `SENTRY_DSN`. See [uw-stream/README.md](../uw-stream/README.md).
- Same Railway hosting.

### Optional integrations

| Service              | Powers                                                                                                                 | Cost                           | Env vars                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| **FRED**             | Dynamic economic events (PCE, PPI, JOLTS)                                                                              | Free                           | `FRED_API_KEY`                                                                   |
| **Finnhub**          | Mega-cap earnings calendar                                                                                             | Free tier OK                   | `FINNHUB_API_KEY`                                                                |
| **Gexbot**           | Dealer gamma/charm/vanna feed for the Periscope, GEX Landscape, GEXBot and Periscope Lottery panels (empty without it) | Check Gexbot pricing           | `GEXBOT_API_KEY`                                                                 |
| **Twilio**           | SMS alerts for 0DTE put/call flow-ratio surges                                                                         | Pay-per-message (~$0.0075/SMS) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_FROM`, `ALERT_PHONE_TO` |
| **Web Push (VAPID)** | PWA browser push notifications                                                                                         | Free (uses FCM relay)          | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`                         |
| **Axiom**            | Per-cron-run events (row counts, data quality) for dashboards and alerts                                               | Free tier                      | `AXIOM_DATASET`, `AXIOM_API_KEY`                                                 |

---

## Cost summary (ballpark, per month)

For an active solo trader running the full stack:

| Tier                            | Monthly cost               |
| ------------------------------- | -------------------------- |
| Vercel Pro                      | $20                        |
| Neon Postgres Pro               | ~$19                       |
| Anthropic (Claude Opus 4.7)     | $50–100                    |
| Unusual Whales Advanced         | ~$120–300 (verify current) |
| Railway (3 services)            | $30–60                     |
| OpenAI embeddings               | <$5                        |
| Upstash / Vercel Blob / Sentry  | Free tier                  |
| Twilio (occasional SMS)         | <$5                        |
| Schwab / FRED / Finnhub / VAPID | Free                       |

**Realistic total: ~$250–500/month**, with UW the biggest line item. Dropping the Railway services gets you to ~$120–180/month. The calculator, the Schwab-backed panels and the AI analysis still work, but every websocket-fed panel goes empty: futures context, Lottery Finder, Silent Boom, dark pool levels, Interval B/A, and the opening-flow and flow-regime signals (all fed by `uw-stream`). You also lose Take-It SHAP flags (`sidecar`). Spread-leg badges come from the exchange's own multi-leg trade code, so they need no extra service.

---

## What you do NOT pay for

- **GitHub** — public repo, free Actions minutes are sufficient.
- **CBOE VIX data** — bundled in `public/vix-data.json` (1990-01-02 to 2026-03-06; updated manually from the CBOE CSV).
- **NYSE market hours table** — bundled in `src/data/`.
- **The 9,102 days of VIX/SPX range data** — bundled.

---

## Getting from "I have the accounts" to "I can run it"

Once you have the env vars, follow [LOCAL_DEV.md](LOCAL_DEV.md) — two paths:

- **Frontend only** (no env needed) — `npm run dev` immediately works.
- **Full stack against prod data** — `vercel env pull` then `npm run dev:full`.

Running the API against an offline Postgres isn't supported today; [LOCAL_DEV.md](LOCAL_DEV.md) explains why.

For deeper reference:

- [README.md](../README.md) — entry-point index
- [LOCAL_DEV.md](LOCAL_DEV.md) — local setup paths, OAuth, pitfalls
- [FEATURES.md](FEATURES.md) — features in full prose
- [ARCHITECTURE.md](ARCHITECTURE.md) — system design, data flow, the math
- [TRADING_WORKFLOW.md](TRADING_WORKFLOW.md) — the 5-phase intraday workflow + 12 structure-selection rules
- [DEPLOYMENT.md](DEPLOYMENT.md) — Vercel + Railway deploy + test catalog
- [INDEX.md](INDEX.md) — design specs + runbooks
- [sidecar/README.md](../sidecar/README.md), [uw-stream/README.md](../uw-stream/README.md), [ml/README.md](../ml/README.md) — Python services
- [CLAUDE.md](../CLAUDE.md) — coding conventions for AI agents working in the repo

---

## Things to verify before relying on these numbers

These figures come from a code-and-config audit, not from billing statements. Confirm them against your own:

- Unusual Whales Advanced tier pricing
- Railway monthly bill across all three services
- Anthropic spend at your current analyze cadence

If any number above is materially off, treat this doc as the structure-and-services map and substitute actual costs.
