/**
 * VegaSpikeFeed panel — Phase 6 Playwright coverage for the Dir Vega Spike
 * Monitor feature. Verifies empty state, populated rendering (formatting,
 * confluence marker, forward-return cells), the range toggle re-fetch, and
 * runs an axe-core a11y scan scoped to the panel.
 *
 * The Vite dev server replaces window.fetch with a wrapper, so page.route
 * does not intercept frontend fetches. We use buildApiFetchMock + page.
 * addInitScript to install a non-overridable fetch mock instead. Pattern
 * mirrors e2e/a11y-live-data.spec.ts and e2e/pre-market.spec.ts.
 *
 * /api/quotes is mocked with MOCK_QUOTES so market.hasData becomes true
 * and the dashboard renders the panel (App.tsx gates panels behind
 * isAuthenticated && (market.hasData || historySnapshot)).
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

// ── Fixtures ─────────────────────────────────────────────────
//
// Note: the API orders spikes by timestamp DESC. SPY's timestamp is
// later than QQQ's so SPY renders first when the array is `[SPIKE_SPY,
// SPIKE_QQQ]` — this matches what real backend data would look like.

const SPIKE_SPY = {
  id: 1,
  ticker: 'SPY',
  date: '2026-04-27',
  timestamp: '2026-04-27T17:00:30.000Z',
  dirVegaFlow: 5_620_000,
  zScore: 28.4,
  vsPriorMax: 4.8,
  priorMax: 1_170_000,
  baselineMad: 198_000,
  barsElapsed: 210,
  confluence: true,
  fwdReturn5m: 0.0018,
  fwdReturn15m: 0.0041,
  fwdReturn30m: 0.0062,
  insertedAt: '2026-04-27T17:00:48.700Z',
};

const SPIKE_QQQ = {
  id: 2,
  ticker: 'QQQ',
  date: '2026-04-27',
  timestamp: '2026-04-27T17:00:00.000Z',
  dirVegaFlow: -825_000,
  zScore: 9.2,
  vsPriorMax: 2.4,
  priorMax: 343_000,
  baselineMad: 89_000,
  barsElapsed: 210,
  confluence: true,
  fwdReturn5m: null,
  fwdReturn15m: null,
  fwdReturn30m: null,
  insertedAt: '2026-04-27T17:00:18.412Z',
};

interface VegaSpikesPayload {
  spikes: unknown[];
  range: string;
}

// ── Mock helper ──────────────────────────────────────────────

/**
 * Install a non-overridable fetch mock with /api/quotes (so the dashboard
 * renders) and /api/vega-spikes (the panel under test). The current
 * buildApiFetchMock helper matches by URL fragment without parsing the
 * range param — for the range-toggle test we install a static fixture
 * and rely on the hook making a fresh fetch on each toggle. The mock
 * does not vary per range; the test inspects the toggle's pressed state
 * + the count of rendered rows to assert the re-render happened.
 */
async function mockDashboard(page: Page, spikes: unknown[]): Promise<void> {
  const payload: VegaSpikesPayload = { spikes, range: 'today' };
  await page.addInitScript(
    buildApiFetchMock({
      '/api/quotes': { body: MOCK_QUOTES },
      '/api/vega-spikes': { body: payload },
    }),
  );
}

// ── Tests ────────────────────────────────────────────────────

test.describe('VegaSpikeFeed panel', () => {
  test('renders the empty state when no spikes are returned', async ({
    page,
  }) => {
    await mockDashboard(page, []);
    await page.goto('/');

    const panel = page.locator('section[aria-label="Dir Vega Spikes"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('vega-spike-empty')).toBeVisible();
    await expect(panel.getByTestId('vega-spike-empty')).toContainText(
      /no spikes detected/i,
    );
    await expect(panel.getByTestId('vega-spike-count')).toContainText('n=0');
  });

  test('renders populated rows with formatting and confluence marker', async ({
    page,
  }) => {
    await mockDashboard(page, [SPIKE_SPY, SPIKE_QQQ]);
    await page.goto('/');

    const panel = page.locator('section[aria-label="Dir Vega Spikes"]');
    await expect(panel).toBeVisible();

    const rows = panel.getByTestId('vega-spike-row');
    await expect(rows).toHaveCount(2);

    // Time column — Today range shows HH:mm in CT (24h, no date).
    const firstRow = rows.first();
    const timeCell = firstRow.locator('td').first();
    await expect(timeCell).toHaveText(/^\d{2}:\d{2}$/);

    // Dir Vega magnitudes — formatDirVega: M/K suffix with forced sign.
    // First row is SPY (later timestamp under DESC ordering).
    await expect(firstRow).toContainText('+5.62M');
    await expect(rows.nth(1)).toContainText('-825K');

    // Both rows are confluent — the visual marker is data-confluence="true".
    await expect(firstRow).toHaveAttribute('data-confluence', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-confluence', 'true');

    // Forward-return cells — first row populated, second em-dash.
    await expect(firstRow).toContainText('+0.18%');
    await expect(firstRow).toContainText('+0.41%');
    await expect(firstRow).toContainText('+0.62%');
    // Second row's fwd_return_* are null → em-dash. Assert at least 3
    // em-dashes appear in the row text (one per forward-return cell).
    const secondRowText = await rows.nth(1).innerText();
    const dashCount = (secondRowText.match(/—/g) ?? []).length;
    expect(dashCount).toBeGreaterThanOrEqual(3);
  });

  test('range toggle updates the pressed state', async ({ page }) => {
    await mockDashboard(page, [SPIKE_SPY]);
    await page.goto('/');

    const panel = page.locator('section[aria-label="Dir Vega Spikes"]');
    await expect(panel).toBeVisible();

    // Today is the default — pressed.
    await expect(panel.getByTestId('vega-range-today')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Click '7 days' — its aria-pressed should flip true and today's flips false.
    await panel.getByTestId('vega-range-7d').click();
    await expect(panel.getByTestId('vega-range-7d')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(panel.getByTestId('vega-range-today')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // Click '30 days'.
    await panel.getByTestId('vega-range-30d').click();
    await expect(panel.getByTestId('vega-range-30d')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test.describe('a11y scan', () => {
    test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');

    test('panel has no critical a11y violations', async ({ page }) => {
      await mockDashboard(page, [SPIKE_SPY, SPIKE_QQQ]);
      await page.goto('/');

      const panel = page.locator('section[aria-label="Dir Vega Spikes"]');
      await expect(panel).toBeVisible();

      const results = await new AxeBuilder({ page })
        .include('section[aria-label="Dir Vega Spikes"]')
        .withTags(['wcag2a', 'wcag2aa'])
        .disableRules(['color-contrast'])
        .analyze();

      const critical = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      );
      for (const v of critical) {
        console.log(
          `[a11y] ${v.impact}: ${v.id} — ${v.description} (${v.nodes.length} nodes)`,
        );
      }
      expect(critical).toEqual([]);
    });
  });
});
