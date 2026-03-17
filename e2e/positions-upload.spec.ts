import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const SAMPLE_CSV = `\ufeffThis document was exported from the paperMoney platform.

Options
Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark,Mark Value
SPX,SPXW260317P6660,17 MAR 26,6660,PUT,+20,.925,.225,$450.00
SPX,SPXW260317P6680,17 MAR 26,6680,PUT,-20,1.575,.325,($650.00)
,OVERALL TOTALS,,,,,,,"($200.00)"
`;

/** Mock quotes response so market.hasData = true and Chart Analysis renders */
const MOCK_QUOTES = {
  spy: {
    price: 679,
    open: 678,
    high: 680,
    low: 677,
    prevClose: 678,
    change: 1,
    changePct: 0.15,
  },
  spx: {
    price: 6790,
    open: 6780,
    high: 6800,
    low: 6770,
    prevClose: 6780,
    change: 10,
    changePct: 0.15,
  },
  vix: {
    price: 19,
    open: 19,
    high: 20,
    low: 18,
    prevClose: 19,
    change: 0,
    changePct: 0,
  },
  vix1d: {
    price: 16,
    open: 16,
    high: 17,
    low: 15,
    prevClose: 16,
    change: 0,
    changePct: 0,
  },
  vix9d: {
    price: 18,
    open: 18,
    high: 19,
    low: 17,
    prevClose: 18,
    change: 0,
    changePct: 0,
  },
  vvix: {
    price: 90,
    open: 90,
    high: 92,
    low: 88,
    prevClose: 90,
    change: 0,
    changePct: 0,
  },
  marketOpen: true,
  asOf: new Date().toISOString(),
};

const MOCK_POSITIONS_SUCCESS = {
  positions: {
    summary: '=== Open SPX 0DTE Positions (1 spread) ===',
    legs: [
      { strike: 6680, putCall: 'PUT', quantity: -20 },
      { strike: 6660, putCall: 'PUT', quantity: 20 },
    ],
    spreads: [{ type: 'PUT CREDIT SPREAD', width: 20 }],
    stats: {
      totalSpreads: 1,
      callSpreads: 0,
      putSpreads: 1,
      netDelta: 0,
      netTheta: 0,
      netGamma: 0,
      totalCredit: 1300,
      currentValue: 200,
      unrealizedPnl: 1100,
    },
  },
  saved: true,
  fetchTime: '10:00',
  source: 'paperMoney',
};

/**
 * Tests for the paperMoney CSV position upload feature.
 * The upload button appears in the Chart Analysis section
 * after at least one image has been added.
 */
test.describe('PaperMoney Position Upload', () => {
  const csvPath = path.join(os.tmpdir(), `test-papermoney-${process.pid}.csv`);

  test.beforeEach(async ({ page }) => {
    // Ensure CSV file exists for each worker
    fs.writeFileSync(csvPath, SAMPLE_CSV);
    // Mock all API routes to provide enough data for Chart Analysis to render
    await page.route('**/api/**', (route) => {
      const url = route.request().url();

      // Positions POST — CSV upload
      if (
        url.includes('/api/positions') &&
        route.request().method() === 'POST'
      ) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_POSITIONS_SUCCESS),
        });
      }

      // Quotes — needed for hasData = true so Chart Analysis renders
      if (url.includes('/api/quotes')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_QUOTES),
        });
      }

      // Everything else — abort
      return route.abort();
    });

    await page.goto('/');
    // Wait for quotes to load and Chart Analysis to render
    await expect(page.getByText('Chart Analysis')).toBeVisible({
      timeout: 5000,
    });
  });

  async function uploadChartImage(page: import('@playwright/test').Page) {
    const pngBuffer = createMinimalPNG();
    const tmpImg = path.join(
      os.tmpdir(),
      `test-chart-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
    );
    fs.writeFileSync(tmpImg, pngBuffer);

    // Use setInputFiles directly on the hidden file input to avoid
    // flaky filechooser events in Firefox
    const fileInput = page.locator(
      'input[type="file"][accept="image/*"][multiple]',
    );
    await fileInput.setInputFiles(tmpImg);

    try {
      fs.unlinkSync(tmpImg);
    } catch {
      /* ignore */
    }

    // Wait for the CSV upload button to appear (it shows after image added)
    await expect(
      page.getByRole('button', { name: /Upload paperMoney/ }),
    ).toBeVisible({ timeout: 3000 });
  }

  test('upload button is visible after adding a chart image', async ({
    page,
  }) => {
    await uploadChartImage(page);
    await expect(
      page.getByRole('button', { name: /Upload paperMoney/ }),
    ).toBeVisible();
  });

  test('uploading CSV shows success message with spread count', async ({
    page,
  }) => {
    await uploadChartImage(page);

    // Use setInputFiles directly on the hidden CSV input to avoid flaky filechooser in Firefox
    const csvInput = page.getByLabel('Upload paperMoney CSV');
    await csvInput.setInputFiles(csvPath);

    await expect(page.getByText(/1 spread loaded from paperMoney/)).toBeVisible(
      { timeout: 5000 },
    );
  });

  test('uploading CSV shows error on API failure', async ({ page }) => {
    // Override positions POST to return an error
    await page.route('**/api/positions**', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'No SPX options found in CSV' }),
        });
      }
      return route.fallback();
    });

    await uploadChartImage(page);

    // Use setInputFiles directly on the hidden CSV input to avoid flaky filechooser in Firefox
    const csvInput = page.getByLabel('Upload paperMoney CSV');
    await csvInput.setInputFiles(csvPath);

    await expect(page.getByText(/No SPX options found/)).toBeVisible({
      timeout: 5000,
    });
  });
});

function createMinimalPNG(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  );
}
