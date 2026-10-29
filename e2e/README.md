# End-to-end tests

Playwright suites for the calculator UI, the analyze flow, the Options Alerts view (Lottery Finder + Silent Boom), Contract Tracker, the Vega Spike feed, the 0DTE regime panel, panel reordering, malformed-payload handling and accessibility. 43 spec files as of 2026-10-29, with three browser projects (chromium, firefox, webkit) in [playwright.config.ts](../playwright.config.ts). CI runs chromium; the nightly job runs all three.

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

The dev server is auto-managed by Playwright (`webServer` block in [playwright.config.ts](../playwright.config.ts)), so you do not need to run `npm run dev` separately. CI sets `reuseExistingServer: false`.

## What's here

- **`a11y-*.spec.ts`**: axe scans of the calculator (`a11y-live-data.spec.ts` covers polling components). Five feature specs (`options-alerts`, `options-alerts-responsive`, `panel-reorder`, `regime-0dte`, `vega-spike-feed`) also end with a scoped axe scan. Every scan uses tags `wcag2a` + `wcag2aa`, disables `color-contrast` (most also `scrollable-region-focusable`), fails only on critical/serious violations, and runs on chromium only.
- **`calculator-flow.spec.ts`**: happy-path strike calculation.
- **`chart-analysis*.spec.ts`**: Anthropic analyze endpoint (mocked).
- **`responsive.spec.ts`**: viewport breakpoint coverage.
- **`*.spec.ts`**: feature-area suites mirroring `src/components/` folders.
- **`helpers/`**: shared utilities. `mock-fetch.ts` exports `buildApiFetchMock`, which stubs `fetch()` responses so suites don't require a populated DB (any `/api/` call a spec doesn't mock fails like an unreachable backend), and `MOCK_QUOTES`. `calculator.ts` finds `Chip` toggles (buttons with `aria-pressed`), opens collapsed sections, sets the entry time inside the Date & Time section, and fills the VIX value.

## Conventions

- Use **semantic selectors**: `getByRole`, `getByLabel`, or `data-testid`. Avoid CSS selectors that couple to Tailwind classes.
- Suites must be deterministic. Pick one way to stub `/api`:
  - `page.route('**/api/**', (route) => route.abort())` when the flow needs no backend (most manual-input specs);
  - `buildApiFetchMock(...)` from `helpers/mock-fetch.ts`, installed with `page.addInitScript` before `page.goto`, when a panel needs data;
  - `route.fulfill` over an in-memory state object for stateful reads and writes (`tracker.spec.ts`).
- Accessibility specs scan with `new AxeBuilder({ page })` from `@axe-core/playwright`. Add new pages to the a11y suite when you add a new section.
- Aim for ≤200 lines per spec (six specs run longer). Split by user journey, not by feature size.

## When a spec fails

1. Run with `--headed --project=chromium` to watch the run.
2. Inspect `playwright-report/` for the HTML report.
3. The `trace: 'on-first-retry'` setting captures a full execution trace on the second attempt; open it with `npx playwright show-trace`.

## CI

- **`.github/workflows/ci.yml`** (job "E2E Tests"): chromium only, on pushes to main, PRs and manual dispatch, when a file the browser loads changes: `src/**`, `e2e/**`, `playwright.config.ts`, `vite.config.ts`, `tsconfig.json`, `index.html`, `public/**`, `package.json`, `package-lock.json` or either workflow file. `api/`-only changes skip it, because the specs stub `/api`. It runs only after the App Quality Gate job passes, and stops after 10 failed tests. In CI, Playwright retries twice on one worker; locally it retries once.
- **`.github/workflows/e2e-nightly.yml`**: all three browsers, weekdays at 23:00 UTC and on manual dispatch, with no path filter and `--max-failures=0`.

## Live DOM gotcha

Many components render conditionally based on time-of-day and market-open state. When asserting attributes on dynamic React UIs, always **read live element state per call** (`max`, `value`, `isChecked`) instead of hardcoding a value the harness might vary.
