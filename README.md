# 0DTE Options Strike Calculator

Production-grade 0DTE SPX options analysis platform: Black-Scholes pricing, AI-powered chart analysis (Claude Opus 4.7), live market data (Schwab + Unusual Whales), position tracking, and a multi-phase ML pipeline. Single-owner tool with optional guest read access. Live at [theta-options.com](https://theta-options.com).

## What's where

| Topic                                                        | Doc                                                                                                                                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First read** — what's in here, accounts you'll need, costs | [docs/ONBOARDING.md](docs/ONBOARDING.md)                                                                                                                                                 |
| Run it locally                                               | [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md)                                                                                                                                                   |
| Features (chart analysis, regime intelligence, positions, …) | [docs/FEATURES.md](docs/FEATURES.md)                                                                                                                                                     |
| Architecture, project structure, data flow, security, math   | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                                                                                                                             |
| Deployment + testing                                         | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)                                                                                                                                                 |
| Trading workflow + position sizing rules                     | [docs/TRADING_WORKFLOW.md](docs/TRADING_WORKFLOW.md)                                                                                                                                     |
| Design specs and runbooks                                    | [docs/INDEX.md](docs/INDEX.md)                                                                                                                                                           |
| Subprojects                                                  | [sidecar/README.md](sidecar/README.md), [ml/README.md](ml/README.md), [uw-stream/README.md](uw-stream/README.md), [scripts/README.md](scripts/README.md), [e2e/README.md](e2e/README.md) |
| Conventions for AI coding agents                             | [CLAUDE.md](CLAUDE.md), [AGENTS.md](AGENTS.md)                                                                                                                                           |

## Quick start

```bash
git clone https://github.com/cobriensr/Options-Strike-Calculator.git
cd Options-Strike-Calculator
cp .env.example .env.local      # see docs/LOCAL_DEV.md for which vars to fill
npm install
npm run dev                      # frontend only,  http://localhost:5173
npm run dev:full                 # full stack via vercel dev,  http://localhost:3000
```

[.env.example](.env.example) is the canonical env reference, kept in sync with [api/\_lib/env.ts](api/_lib/env.ts). Three setup paths (frontend-only / live prod data / offline docker) are documented in [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md).

## Stack

- **Frontend** — React 19 (strict mode), Vite, Tailwind CSS 4
- **Backend** — Vercel Serverless Functions on Node 24 (Fluid Compute)
- **Data** — Neon Postgres (`@neondatabase/serverless`), Upstash Redis
- **AI** — Anthropic Claude Opus 4.7 (analyze), OpenAI text-embedding-3-large (lessons dedup)
- **Market data** — Schwab Trader/Market Data API, Unusual Whales, Databento (sidecar)
- **Python services** — `sidecar/` (Databento + Theta on Railway), `uw-stream/` (UW websocket on Railway), `ml/` (nightly pipeline)
- **Observability** — Sentry, pino structured logs, Vercel Speed Insights

## What this app does

Given a SPY/SPX price, VIX, and time, the calculator produces delta-targeted strike tables, full iron condor / BWB P&L with skew-adjusted fat-tail PoP, a delta ceiling recommendation backed by 9,102 days of historical VIX-to-SPX range data, and a catalog of regime signals (VIX term structure, opening range, volatility clustering, dark pool levels, GEX walls, event-day warnings). An AI analyze endpoint reads up to 4 chart screenshots (Market Tide, Net Flow, Periscope) and returns a structure / delta / entry plan / management rules / hedge recommendation, with active "lessons learned" injected from a self-improving weekly curation pipeline. Live data ingestion, ML feature engineering, and Claude vision analysis of nightly plots all run on schedule. See [docs/FEATURES.md](docs/FEATURES.md) for the full surface.

## Tests

```bash
npm run review        # tsc + eslint + prettier + vitest --coverage
npm run test:run      # vitest unit tests (no env vars required)
npm run test:e2e      # Playwright e2e + a11y across chromium/firefox/webkit
```

6,897 unit tests across 277 files; 34 Playwright specs across 3 browsers. ML pipeline has 14 pytest files. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full breakdown.

## License

[GNU General Public License v3.0](LICENSE.md).
