# 0DTE Options Strike Calculator

Production-grade 0DTE SPX options analysis platform: Black-Scholes pricing, AI-powered chart analysis (Claude Opus 4.7), live market data (Schwab, Unusual Whales, GEXBot), dealer-positioning dashboards, intraday unusual-options alerts, position tracking, and an ML research pipeline. Single-owner tool with optional guest read access. Live at [theta-options.com](https://theta-options.com).

## What's where

| Topic                                                        | Doc                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First read** — what's in here, accounts you'll need, costs | [docs/ONBOARDING.md](docs/ONBOARDING.md)                                                                                                                                                                                               |
| Run it locally                                               | [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md)                                                                                                                                                                                                 |
| Features (chart analysis, regime intelligence, positions, …) | [docs/FEATURES.md](docs/FEATURES.md)                                                                                                                                                                                                   |
| Architecture, project structure, data flow, security, math   | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                                                                                                                                                                           |
| Deployment + testing                                         | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)                                                                                                                                                                                               |
| Trading workflow + position sizing rules                     | [docs/TRADING_WORKFLOW.md](docs/TRADING_WORKFLOW.md)                                                                                                                                                                                   |
| Design specs and runbooks                                    | [docs/INDEX.md](docs/INDEX.md)                                                                                                                                                                                                         |
| Subprojects                                                  | [sidecar/README.md](sidecar/README.md), [ml/README.md](ml/README.md), [uw-stream/README.md](uw-stream/README.md), [scripts/README.md](scripts/README.md), [e2e/README.md](e2e/README.md) |
| Conventions for AI coding agents                             | [CLAUDE.md](CLAUDE.md), [AGENTS.md](AGENTS.md)                                                                                                                                                                                         |

## Quick start

```bash
git clone https://github.com/cobriensr/Options-Strike-Calculator.git
cd Options-Strike-Calculator
cp .env.example .env.local      # see docs/LOCAL_DEV.md for which vars to fill
npm install
npm run dev                      # frontend only,  http://localhost:5173
npm run dev:full                 # full stack via vercel dev,  http://localhost:3000
```

[.env.example](.env.example) is the starting template for `.env.local`. [api/\_lib/env.ts](api/_lib/env.ts) validates the core server vars (database, Redis, auth, API keys, Twilio, observability); some optional integrations read `process.env` directly. Two setup paths (frontend only, or full stack against live data) are documented in [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md).

## Stack

- **Frontend** — React 19 (strict mode), Vite, Tailwind CSS 4, installable PWA
- **Backend** — Vercel Serverless Functions on Node 24 (Fluid Compute)
- **Data** — Neon Postgres (`@neondatabase/serverless`), Upstash Redis, Vercel Blob
- **AI** — Anthropic Claude Opus 4.7 (chart analysis, weekly lesson curation) with Sonnet 4.6 as its fallback and for the pre-check, Periscope lesson curation and plot analysis; OpenAI text-embedding-3-large (lesson dedup, analog-day retrieval)
- **Market data** — Schwab Trader/Market Data API, Unusual Whales (REST + websocket, including per-trade option prints and CME futures bars), GEXBot (dealer gamma/charm/vanna state), FRED + Finnhub (economic and earnings calendar)
- **Python services** — `uw-stream/` (UW websocket on Railway), `sidecar/` (Take-It SHAP, frozen archive on Railway), `ml/` (research pipeline)
- **Observability** — Sentry, pino structured logs, Axiom (cron-run events), Vercel Analytics + Speed Insights

Multi-leg trades are flagged from the exchange's own trade code on the anchor print (`api/_lib/anchor-legs.ts`); the former Railway classifier is retired ([design](docs/superpowers/specs/2026-10-28-classifier-replacement-design.md)).

## What this app does

Given a SPY/SPX price, VIX, and time, the calculator produces delta-targeted strike tables, full iron condor / BWB P&L with skew-adjusted fat-tail PoP, and a delta ceiling recommendation backed by 9,102 days of historical VIX-to-SPX range data. A Market Regime section adds VIX regime and term structure, opening range, volatility clustering, pre-trade signals and event-day warnings.

Owner and guest sessions add live dashboards: dealer gamma and exposure (0DTE gamma regime, GEX Target, GEX Landscape, zero gamma, Strike Battle Map, 0DTE Greek heatmap, GEXBot dealer state, a rule-based Periscope exposure map), flow (Greek flow, dark pool levels, directional vega spikes, Interval B/A history), setup detectors (Periscope Lottery, gamma-node detector), futures, a position monitor and a contract tracker. A separate **Options Alerts** view runs two intraday unusual-options feeds, **Lottery Finder** and **Silent Boom**, over the per-trade tape that `uw-stream` ingests. Each alert carries a **Take-It** probability from calibrated gradient-boosted models scored in TypeScript, with SHAP flags from the sidecar.

An owner-only AI analyze endpoint reads up to 2 Periscope screenshots (gamma and charm) plus structured flow, GEX, futures and positions data, and returns a structure / delta / entry plan / management rules / hedge recommendation, with active "lessons learned" injected from a self-improving weekly curation pipeline. Live data ingestion (Vercel crons plus the `uw-stream` websocket service) and ML feature building run on schedule; the GitHub Actions ML pipeline behind the research plots is paused. See [docs/FEATURES.md](docs/FEATURES.md) for the full surface.

## Tests

```bash
npm run review        # type-check + eslint + prettier --write + build + build-output check + vitest --coverage + coverage floors
npm run test:run      # vitest unit tests (no env vars required)
npm run test:e2e      # Playwright e2e + a11y across chromium/firefox/webkit
```

As of 2026-10-29: about 14,960 Vitest tests in 686 files; 41 Playwright specs (chromium on every CI run, all three browsers nightly); 88 CI-gated pytest files across `ml/`, `sidecar/` and `uw-stream/`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full breakdown.

## License

[GNU Affero General Public License v3.0](LICENSE.md).
