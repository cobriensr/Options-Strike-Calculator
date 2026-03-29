import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

const SAMPLE_CSV = `\ufeffThis document was exported from the paperMoney platform.

Options
Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark,Mark Value
SPX,SPXW260317P6660,17 MAR 26,6660,PUT,+20,.925,.225,$450.00
SPX,SPXW260317P6680,17 MAR 26,6680,PUT,-20,1.575,.325,($650.00)
,OVERALL TOTALS,,,,,,,"($200.00)"
`;

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
    // Mock API routes via addInitScript to work with Vite's PWA plugin
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/positions': {
          body: MOCK_POSITIONS_SUCCESS,
          method: 'POST',
        },
      }),
    );

    await page.goto('/');
    // Wait for quotes to load and Chart Analysis section to render
    await expect(
      page.locator('section[aria-label="Chart Analysis"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  async function uploadChartImage(page: import('@playwright/test').Page) {
    const pngBuffer = createMinimalPNG();
    const tmpImg = path.join(
      os.tmpdir(),
      `test-chart-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
    );
    fs.writeFileSync(tmpImg, pngBuffer);

    // Use setInputFiles directly on the hidden file input to avoid
    // flaky filechooser events in Firefox/WebKit
    const fileInput = page.locator(
      'input[type="file"][accept="image/*"][multiple]',
    );
    // Ensure the input is interactable (un-hide for setInputFiles compatibility)
    await fileInput.evaluate((el) => el.classList.remove('hidden'));
    await fileInput.setInputFiles(tmpImg);

    try {
      fs.unlinkSync(tmpImg);
    } catch {
      /* ignore */
    }

    // Wait for the CSV upload button to appear (it shows after image added)
    await expect(
      page.getByRole('button', { name: /Upload paperMoney/ }),
    ).toBeVisible({ timeout: 5000 });
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

    // Un-hide the CSV input for setInputFiles compatibility on Firefox/WebKit
    const csvInput = page.getByLabel('Upload paperMoney CSV');
    await csvInput.evaluate((el) => el.classList.remove('hidden'));
    await csvInput.setInputFiles(csvPath);

    await expect(page.getByText(/1 spread saved from paperMoney/)).toBeVisible(
      { timeout: 5000 },
    );
  });

  test('uploading CSV shows error on API failure', async ({ browser }) => {
    // Need a fresh context so we can install a different mock for /api/positions
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/positions': {
          body: { error: 'No SPX options found in CSV' },
          status: 400,
          method: 'POST',
        },
      }),
    );

    await page.goto('/');
    await expect(
      page.locator('section[aria-label="Chart Analysis"]'),
    ).toBeVisible({ timeout: 5000 });

    await uploadChartImage(page);

    // Un-hide the CSV input for setInputFiles compatibility on Firefox/WebKit
    const csvInput = page.getByLabel('Upload paperMoney CSV');
    await csvInput.evaluate((el) => el.classList.remove('hidden'));
    await csvInput.setInputFiles(csvPath);

    await expect(page.getByText(/No SPX options found/)).toBeVisible({
      timeout: 5000,
    });

    await context.close();
  });
});

function createMinimalPNG(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  );
}
