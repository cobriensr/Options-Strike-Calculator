import { test, expect, type Locator, type Page } from '@playwright/test';
import type {
  ExpectedMoveRow,
  ExpectedMoveStrikeIv,
  SnapshotsLatestRow,
} from '../src/hooks/useGexbotData';
import type { QuotesResponse } from '../src/types/api';
import { FULL_SESSION_NOW, fillVix, setEntryTime } from './helpers/calculator';
import { MOCK_QUOTES } from './helpers/mock-fetch';

/**
 * Rows that don't wrap run past their card on a phone. These now wrap:
 *
 *   - a SectionBox header whose controls don't fit beside the title, e.g.
 *     the Futures panel once its data loads and a time badge joins the
 *     title (the controls drop to their own right-aligned line);
 *   - the hedge calculator's IC Δ chips in the strike results card;
 *   - the GEXBot level ladder's rows, whose two columns (chips, then the odds
 *     line) drop under one another. Its describe sits below the first one.
 *
 * Tables that sit behind a disclosure are the other trap: their visually
 * hidden text (the "(gain)/(loss)" spans, a SrHint) is position: absolute,
 * and a horizontal scroller that is not positioned does not contain it, so
 * opening the table can widen the page. The last describe opens each one.
 */

/** The card's content edge: its right side minus border and padding. */
async function contentRight(card: Locator) {
  return card.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      box.right -
      Number.parseFloat(style.borderRightWidth) -
      Number.parseFloat(style.paddingRight)
    );
  });
}

async function expectInsideCard(card: Locator, controls: Locator[]) {
  const edge = await contentRight(card);
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box, 'control laid out').not.toBeNull();
    if (box) expect(box.x + box.width).toBeLessThanOrEqual(edge + 0.5);
  }
}

async function expectNoSidewaysScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test.describe('Panels on a phone', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
  });

  test('the Futures header keeps its controls in the card once data loads', async ({
    page,
  }) => {
    // Registered after the abort-everything route, so matched first
    await page.route('**/api/futures/snapshot**', (route) =>
      route.fulfill({
        json: {
          snapshots: [],
          vixTermStructure: null,
          esSpxBasis: null,
          updatedAt: new Date().toISOString(),
          oldestTs: '2026-10-01T14:30:00Z',
          requestedAt: null,
        },
      }),
    );
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const futures = page.getByRole('region', { name: 'Futures', exact: true });
    // The update time joins the title as a badge
    await expect(
      futures.getByRole('button', { name: 'Toggle Futures' }),
    ).toContainText(/\d{1,2}:\d{2}\s?[AP]M/);
    await expectInsideCard(futures, [
      futures.getByLabel('Historical futures timestamp'),
      // Exact: a substring would pass on the old "Reset to live data" name
      futures.getByRole('button', {
        name: 'Now: reset to live data',
        exact: true,
      }),
      // A poll puts the button in its loading state, which renames it
      futures.getByRole('button', {
        name: /^(Refresh|Loading\.\.\. refreshing) futures data$/,
      }),
    ]);
    await expectNoSidewaysScroll(page);
  });

  test('the hedge calculator chips stay in the strike results card at 320px', async ({
    page,
  }) => {
    // Pinned to a full session so the run doesn't depend on the day CI runs
    // it (see the constant).
    await page.clock.setFixedTime(new Date(FULL_SESSION_NOW));
    await page.setViewportSize({ width: 320, height: 640 }); // iPhone SE
    await page.goto('/');
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await fillVix(page, '19');

    const results = page.getByRole('region', {
      name: 'Strike results for all deltas',
    });
    // IC Δ, Hedge Δ and DTE chips are toggles (aria-pressed)
    const chips = results.locator('button[aria-pressed]');
    await expect(chips.first()).toBeVisible();
    await expectInsideCard(results, await chips.all());
    await expectNoSidewaysScroll(page);
  });
});

/**
 * The level ladder (src/components/Gexbot/LevelLadder.tsx) mounts only for an
 * owner or guest with market context (quotes answered), and prices odds only
 * while the market is open, so it needs a fixture the tests above don't have:
 * quotes, both GEXBot views it reads, and a clock inside a regular session.
 * The abort-everything route keeps every other call failing like an
 * unreachable backend, the section's other tiles included. The dev server
 * counts as an owner (`getAccessMode`), so no cookie is set.
 */

/**
 * Wednesday 2026-06-24, 10:00 AM CT: five hours left in a full regular
 * session. Pinned, like FULL_SESSION_NOW, so the run doesn't depend on the day
 * CI runs it; it is inside the session, so `marketOpen` is true.
 */
const OPEN_SESSION_NOW = '2026-06-24T15:00:00Z';
const agoIso = (seconds: number) =>
  new Date(Date.parse(OPEN_SESSION_NOW) - seconds * 1000).toISOString();

// VIX1D and VIX9D left out: the calculator then prices from the VIX alone
const OPEN_QUOTES: QuotesResponse = {
  ...MOCK_QUOTES,
  vix1d: null,
  vix9d: null,
  vvix: null,
  asOf: OPEN_SESSION_NOW,
};

/**
 * All nine levels, with spot at 6790 (the quote's SPX). Two of them, 6740, sit
 * on the put candidate's strike, so that row carries the most chips. One is
 * past the ladder's +60 pts reach and one under its window, so each edge line
 * lists a level too.
 */
const LEVELS_ROW: SnapshotsLatestRow = {
  ticker: 'SPX',
  capturedAt: agoIso(30),
  spot: 6790.4,
  zeroGamma: 6788.4, // off the strike grid: a marker line, not a chip
  zMlgamma: 6820,
  zMsgamma: 6770,
  zcvr: null,
  zgr: null,
  zvanna: null,
  zcharm: null,
  oMlgamma: null,
  oMsgamma: null,
  ocvr: null,
  ogr: null,
  ovanna: null,
  ocharm: null,
  oneDexoflow: null,
  oneGexoflow: null,
  oneCvroflow: null,
  zeroMcall: 6830,
  zeroMput: 6740,
  majorPosVol: 6800,
  majorPosOi: 6860,
  majorNegVol: 6740,
  majorNegOi: 6700,
  minDte: 0,
};

/** Call and put IV at every strike from 6650 to 7000: a skew that falls with the strike. */
const STRIKE_IVS: ExpectedMoveStrikeIv[] = Array.from(
  { length: 71 },
  (_, i) => {
    const strike = 6650 + 5 * i;
    const x = (strike - 6790) / 6790;
    const iv = Math.round((0.2 - 0.8 * x + 8 * x * x) * 1e4) / 1e4;
    return { strike, callIv: iv, putIv: iv };
  },
);

/** E = 6790.4 × 0.20 × √(0.2083 ÷ 365) = 32.4 pts: a ±1σ band of 6758 to 6822.8. */
const MOVE_ROW: ExpectedMoveRow = {
  ticker: 'SPX',
  capturedAt: agoIso(10),
  asOf: agoIso(10),
  spot: 6790.4,
  minDte: 0,
  atmStrike: 6790,
  atmIv: 0.2,
  dteFraction: 0.2083,
  expectedMove: 32.4,
  lower: 6758,
  upper: 6822.8,
  unavailable: null,
  strikeIvs: STRIKE_IVS,
};

/** The quotes and the two GEXBot views the ladder reads, as the real routes shape them. */
async function stubLadderApis(page: Page) {
  // Registered after the abort-everything route, so matched first
  await page.route('**/api/quotes**', (route) =>
    route.fulfill({ json: OPEN_QUOTES }),
  );
  await page.route('**/api/gexbot**', async (route) => {
    const view = new URL(route.request().url()).searchParams.get('view');
    if (view === 'snapshots-latest') {
      await route.fulfill({
        json: { rows: [LEVELS_ROW], asOf: LEVELS_ROW.capturedAt },
      });
    } else if (view === 'expected-move') {
      await route.fulfill({ json: { rows: [MOVE_ROW] } });
    } else {
      // The section's other views stay unanswered, like the rest of /api
      await route.fallback();
    }
  });
}

/** The card's own right edge is inside a viewport `width` px wide. */
async function expectInsideViewport(card: Locator, width: number) {
  const box = await card.boundingBox();
  expect(box, 'card laid out').not.toBeNull();
  if (box) expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
}

/** Names every element inside `card` that ends past the card's right edge. */
async function expectNothingPastRightEdge(card: Locator) {
  const offenders = await card.evaluate((el) => {
    const edge = el.getBoundingClientRect().right;
    return [...el.querySelectorAll('*')]
      .filter((child) => child.getBoundingClientRect().right > edge + 0.5)
      .map(
        (child) =>
          `<${child.tagName.toLowerCase()}> ${child.textContent?.slice(0, 50) ?? ''}`,
      );
  });
  expect(offenders, 'elements past the ladder edge').toEqual([]);
}

test.describe('The level ladder on a phone', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await stubLadderApis(page);
    await page.clock.setFixedTime(new Date(OPEN_SESSION_NOW));
  });

  for (const { width, height, device } of [
    { width: 375, height: 812, device: 'iPhone X' },
    { width: 320, height: 640, device: 'iPhone SE' },
  ]) {
    test(`stays inside its card at ${width}px (${device}) with every level, both candidates and an edge line`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');

      // The quotes fill the calculator at SPX 6790. Its SPX is then set 60 pts
      // higher, so the 10Δ put (6740) lands 50 pts under the ladder's spot,
      // inside its window, and the 10Δ call (6955) 165 pts over it, beyond
      // the +60 pts reach: the call's odds print on the Above line.
      // The override lasts about a minute. In a live session useAutoFill puts
      // the quote's SPX back on every new quotes payload, `spxEdited` or not,
      // and the next payload is the 60 s poll; the test takes seconds. The
      // SPX Price assertion below names the cause if a stalled run loses it.
      await expect(page.getByLabel('SPY Price')).toHaveValue('679.00');
      await page.getByLabel(/SPX Price/).fill('6850');

      const ladder = page.getByRole('group', {
        name: 'Level Ladder',
        exact: true,
      });
      await expect(ladder).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('level-ladder-header')).toContainText(
        'spot 6,790.0 · levels 09:59 CT',
      );

      // The widest row: the candidate, two levels, and its odds line
      const putRow = ladder
        .getByRole('listitem')
        .filter({ hasText: 'CANDIDATE · 10Δ PUT' });
      await expect(putRow).toBeVisible();
      await expect(putRow).toContainText('State major put');
      await expect(putRow).toContainText('Classic major negative · volume');
      // Laid out, not just in the DOM: the odds line is visible
      await expect(
        putRow.getByText(/σ · touch .+ · finish beyond /),
      ).toBeVisible();
      // The other candidate is past the window: odds and "priced" on its line
      const edgeAbove = page.getByTestId('level-ladder-edge-above');
      await expect(edgeAbove).toBeVisible();
      await expect(edgeAbove).toContainText(
        /^Above: .*Call [\d,]+ \(.+ · touch .+ · finish beyond .+\) · priced odds/,
      );
      const edgeBelow = page.getByTestId('level-ladder-edge-below');
      await expect(edgeBelow).toBeVisible();
      await expect(edgeBelow).toContainText(
        'Classic major negative · OI 6,700',
      );
      // The state above still rests on the calculator's SPX override
      await expect(page.getByLabel(/SPX Price/)).toHaveValue(/^6850(\.00)?$/);

      await expectInsideViewport(ladder, width);
      await expectNothingPastRightEdge(ladder);
      await expectNoSidewaysScroll(page);
    });
  }
});

test.describe('Tables behind a disclosure on a phone', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.setViewportSize({ width: 375, height: 812 }); // iPhone X
    await page.goto('/');
    await setEntryTime(page);
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await fillVix(page, '19');
    await expect(
      page.locator('#results').getByText('All Delta Strikes'),
    ).toBeVisible({ timeout: 5000 });
    // Baseline: the results alone fit, so a failure below is the table
    await expectNoSidewaysScroll(page);
  });

  test('the hedge scenario tables fit once "Show P&L Scenario Table" opens them', async ({
    page,
  }) => {
    const results = page.locator('#results');
    await results
      .getByRole('button', { name: /Show.*P&L Scenario Table/ })
      .click();

    await expect(
      results.getByRole('table', { name: 'Hedge P&L crash scenarios' }),
    ).toBeVisible();
    await expect(
      results.getByRole('table', { name: 'Hedge P&L rally scenarios' }),
    ).toBeVisible();
    await expectNoSidewaysScroll(page);
  });

  test('the iron condor legs and P&L tables fit', async ({ page }) => {
    const results = page.locator('#results');
    await expect(
      results.getByRole('table', { name: 'Iron condor legs by delta' }),
    ).toBeVisible();
    await expect(
      results.getByRole('table', { name: 'Iron condor P&L by delta' }),
    ).toBeVisible();
    await expectNoSidewaysScroll(page);
  });

  test('the BWB legs and P&L tables fit once "Show BWB" opens them', async ({
    page,
  }) => {
    // Advanced starts collapsed and its Show BWB chip is the only switch
    await page.getByRole('button', { name: 'Show BWB' }).click();

    const results = page.locator('#results');
    await expect(
      results.getByRole('table', { name: 'BWB legs by delta' }),
    ).toBeVisible();
    await expect(
      results.getByRole('table', { name: 'BWB P&L by delta' }),
    ).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});
