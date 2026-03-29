import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

function createMinimalPNG(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  );
}

/**
 * Stub createImageBitmap + OffscreenCanvas so the image compression
 * step inside useChartAnalysis works with our minimal 1x1 PNG in
 * all browser engines under Playwright.
 */
const STUB_IMAGE_COMPRESSION = `
  (function() {
    // Make createImageBitmap return a minimal bitmap-like object
    var _origCreateImageBitmap = window.createImageBitmap;
    window.createImageBitmap = function(source) {
      // If source is a Blob/File, return a fake bitmap
      if (source instanceof Blob || source instanceof File) {
        return Promise.resolve({ width: 100, height: 100, close: function() {} });
      }
      return _origCreateImageBitmap.apply(window, arguments);
    };

    // Make OffscreenCanvas return a canvas that produces a valid JPEG blob
    var _OrigOffscreenCanvas = window.OffscreenCanvas;
    window.OffscreenCanvas = function(w, h) {
      var canvas;
      try { canvas = new _OrigOffscreenCanvas(w, h); } catch(e) {
        // Fallback: create a regular canvas-like object
        canvas = { width: w, height: h };
      }
      canvas.getContext = function() {
        return { drawImage: function() {} };
      };
      canvas.convertToBlob = function() {
        // Return a tiny valid JPEG blob
        return Promise.resolve(new Blob(['fake-jpeg-data'], { type: 'image/jpeg' }));
      };
      return canvas;
    };
  })();
`;

const MOCK_ANALYZE_SUCCESS = {
  analysis: {
    mode: 'entry',
    structure: 'IRON CONDOR',
    suggestedDelta: 10,
    confidence: 'HIGH',
    reasoning:
      'VIX at 19 with flat term structure suggests standard IC positioning at 10-delta.',
    entryPlan: {
      entry1: {
        timing: 'After 30-min OR confirms',
        sizePercent: 50,
        delta: 10,
        structure: 'IRON CONDOR',
        note: 'Sell 10-delta IC with 20-pt wings.',
      },
    },
    hedge: {
      recommendation: 'LONG PUT',
      description: 'Hold 2x 5-delta puts as downside hedge.',
      rationale: 'Protects against sudden VIX spike.',
      estimatedCost: '$0.40/contract',
    },
    managementRules: {
      profitTarget: 'Close at 50% max profit.',
      stopConditions: ['Short strike breached by 5 pts'],
      timeRules: 'Close by 3:30 PM ET regardless.',
    },
    observations: ['Flat term structure', 'Low VVIX'],
    risks: ['Earnings after close'],
    structureRationale: 'Balanced premium on both sides with VIX at 19.',
  },
};

/**
 * Tests for the full Chart Analysis lifecycle:
 * image upload, confirmation dialog, loading, results, and error handling.
 */
test.describe('Chart Analysis Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(STUB_IMAGE_COMPRESSION);
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/analyze': {
          body: MOCK_ANALYZE_SUCCESS,
          method: 'POST',
        },
      }),
    );
    await page.goto('/');
    await expect(
      page.locator('section[aria-label="Chart Analysis"]'),
    ).toBeVisible({ timeout: 15000 });
  });

  async function uploadChartImage(page: import('@playwright/test').Page) {
    const pngBuffer = createMinimalPNG();
    const tmpImg = path.join(
      os.tmpdir(),
      `test-chart-flow-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
    );
    fs.writeFileSync(tmpImg, pngBuffer);

    const fileInput = page.locator(
      'input[type="file"][accept="image/*"][multiple]',
    );
    await fileInput.evaluate((el) => el.classList.remove('hidden'));
    await fileInput.setInputFiles(tmpImg);

    try {
      fs.unlinkSync(tmpImg);
    } catch {
      /* ignore */
    }
  }

  test('uploading images shows confirmation dialog', async ({ page }) => {
    await uploadChartImage(page);

    const section = page.locator('section[aria-label="Chart Analysis"]');

    // The "Analyze" button should appear after image upload
    await expect(
      section.getByRole('button', { name: /Analyze 1 chart/ }),
    ).toBeVisible({ timeout: 5000 });

    // Click analyze to trigger confirmation
    await section.getByRole('button', { name: /Analyze 1 chart/ }).click();

    // Confirmation dialog should appear
    await expect(section.getByText(/Send 1 image.* to Opus/)).toBeVisible({
      timeout: 3000,
    });
    await expect(
      section.getByRole('button', { name: 'Confirm' }),
    ).toBeVisible();
    await expect(
      section.getByRole('button', { name: 'Go Back' }),
    ).toBeVisible();
  });

  test('clicking Go Back dismisses confirmation', async ({ page }) => {
    await uploadChartImage(page);

    const section = page.locator('section[aria-label="Chart Analysis"]');

    // Click analyze to trigger confirmation
    await section.getByRole('button', { name: /Analyze 1 chart/ }).click();
    await expect(section.getByText(/Send 1 image.* to Opus/)).toBeVisible({
      timeout: 3000,
    });

    // Click Go Back
    await section.getByRole('button', { name: 'Go Back' }).click();

    // Confirmation should disappear
    await expect(section.getByText(/Send 1 image.* to Opus/)).not.toBeVisible();

    // The analyze button should still be visible (images remain)
    await expect(
      section.getByRole('button', { name: /Analyze 1 chart/ }),
    ).toBeVisible();
  });

  test('full analyze flow shows results', async ({ page }) => {
    await uploadChartImage(page);

    const section = page.locator('section[aria-label="Chart Analysis"]');

    // Click analyze then confirm
    await section.getByRole('button', { name: /Analyze 1 chart/ }).click();
    await expect(section.getByRole('button', { name: 'Confirm' })).toBeVisible({
      timeout: 3000,
    });
    await section.getByRole('button', { name: 'Confirm' }).click();

    // Wait for results to appear (mock responds immediately)
    // Structure badge: "IRON CONDOR" (first match is the primary heading)
    await expect(section.getByText('IRON CONDOR').first()).toBeVisible({
      timeout: 15000,
    });

    // Confidence chip: "HIGH"
    await expect(section.getByText('HIGH').first()).toBeVisible();

    // Delta chip: 10-delta
    await expect(section.getByText('10\u0394').first()).toBeVisible();

    // Reasoning text
    await expect(
      section.getByText(/VIX at 19 with flat term structure/),
    ).toBeVisible();
  });

  test('analyze error shows error message', async ({ page }) => {
    // Create a new page with the analyze endpoint returning an error
    const errorPage = await page.context().newPage();
    await errorPage.addInitScript(STUB_IMAGE_COMPRESSION);
    await errorPage.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/analyze': {
          body: { error: 'Rate limited' },
          status: 429,
          method: 'POST',
        },
      }),
    );
    await errorPage.goto('/');
    await expect(
      errorPage.locator('section[aria-label="Chart Analysis"]'),
    ).toBeVisible({ timeout: 15000 });

    // Upload an image on the error page
    const pngBuffer = createMinimalPNG();
    const tmpImg = path.join(os.tmpdir(), `test-chart-err-${Date.now()}.png`);
    fs.writeFileSync(tmpImg, pngBuffer);
    const fileInput = errorPage.locator(
      'input[type="file"][accept="image/*"][multiple]',
    );
    await fileInput.evaluate((el) => el.classList.remove('hidden'));
    await fileInput.setInputFiles(tmpImg);
    try {
      fs.unlinkSync(tmpImg);
    } catch {
      /* ignore */
    }

    const section = errorPage.locator('section[aria-label="Chart Analysis"]');

    // Click analyze then confirm
    await section.getByRole('button', { name: /Analyze 1 chart/ }).click();
    await expect(section.getByRole('button', { name: 'Confirm' })).toBeVisible({
      timeout: 3000,
    });
    await section.getByRole('button', { name: 'Confirm' }).click();

    // Error message should appear
    await expect(section.getByText('Rate limited')).toBeVisible({
      timeout: 15000,
    });

    await errorPage.close();
  });
});
