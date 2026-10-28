# End-to-end tests

Playwright suites covering the calculator UI, analyze flow, and a11y compliance. 40 specs across 3 browsers (chromium, firefox, webkit).

## Run

```bash
# Once: install browsers
npx playwright install

# All suites
npm run test:e2e

# A single spec
npx playwright test e2e/calculator-flow.spec.ts

# Headed mode (watch it run)
npx playwright test --headed --project=chromium
```

The dev server is auto-managed by Playwright (`webServer` block in [playwright.config.ts](../playwright.config.ts)) — you do not need to run `npm run dev` separately. CI sets `reuseExistingServer: false`.

## What's here

- **`a11y-*.spec.ts`** — `@axe-core/playwright` against key sections. `a11y-live-data.spec.ts` covers polling components.
- **`calculator-flow.spec.ts`** — happy-path strike calculation.
- **`chart-analysis-*.spec.ts`** — Anthropic analyze endpoint (mocked).
- **`responsive.spec.ts`** — viewport breakpoint coverage.
- **`*.spec.ts`** — feature-area suites mirroring `src/components/` folders.
- **`helpers/`** — shared utilities. `mock-fetch.ts` stubs `fetch()` responses so suites don't require a populated DB; any `/api/` call a spec doesn't mock fails like an unreachable backend. `calculator.ts` finds `Chip` toggles (buttons with `aria-pressed`), opens collapsed sections and sets the entry time.

## Conventions

- Use **semantic selectors** — `getByRole`, `getByLabel`, or `data-testid`. Avoid CSS selectors that couple to Tailwind classes.
- Suites must be deterministic. If a feature polls live data, mock it via `helpers/mock-fetch.ts`.
- Accessibility specs scan with `new AxeBuilder({ page })` from `@axe-core/playwright`. Add new pages to the a11y suite when you add a new section.
- Keep specs ≤200 lines. Split by user journey, not by feature size.

## When a spec fails

1. Run with `--headed --project=chromium` to watch the run.
2. Inspect `playwright-report/` for the HTML report.
3. The `trace: 'on-first-retry'` setting captures a full execution trace on the second attempt — open via `npx playwright show-trace`.

## CI

- **`.github/workflows/ci.yml`** (job "E2E Tests"): chromium only, on pushes to main, PRs and manual dispatch, when a file the browser loads changes: `src/**`, `e2e/**`, `playwright.config.ts`, `vite.config.ts`, `tsconfig.json`, `index.html`, `public/**`, `package.json`, `package-lock.json` or either workflow file. `api/`-only changes skip it, because the specs stub `/api`. It stops after 10 failed tests.
- **`.github/workflows/e2e-nightly.yml`**: all three browsers, weekdays at 23:00 UTC and on manual dispatch, with no path filter and `--max-failures=0`.

## Live DOM gotcha

Many components render conditionally based on time-of-day and market-open state. When asserting attributes on dynamic React UIs, always **read live element state per call** (`max`, `value`, `isChecked`) instead of hardcoding a value the harness might vary. See feedback memory `feedback_read_live_dom_state` for the underlying incident.
