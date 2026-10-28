import { test, expect } from '@playwright/test';
import {
  chip,
  dateTimeSection,
  openSection,
  setEntryTime,
} from './helpers/calculator';
import { buildApiFetchMock } from './helpers/mock-fetch';

function makeQuotesMock(vix1d: number, vix9d: number) {
  return {
    spy: {
      price: 679,
      open: 678,
      high: 680,
      low: 677,
      prevClose: 676,
      change: 3,
      changePct: 0.44,
    },
    spx: {
      price: 6790,
      open: 6780,
      high: 6800,
      low: 6770,
      prevClose: 6760,
      change: 30,
      changePct: 0.44,
    },
    vix: {
      price: 19,
      open: 19.2,
      high: 19.5,
      low: 18.8,
      prevClose: 19.1,
      change: -0.1,
      changePct: -0.5,
    },
    vix1d: {
      price: vix1d,
      open: vix1d,
      high: vix1d + 1,
      low: vix1d - 1,
      prevClose: vix1d,
      change: 0,
      changePct: 0,
    },
    vix9d: {
      price: vix9d,
      open: vix9d,
      high: vix9d + 0.5,
      low: vix9d - 0.5,
      prevClose: vix9d,
      change: 0,
      changePct: 0,
    },
    vvix: {
      price: 90,
      open: 89,
      high: 92,
      low: 88,
      prevClose: 91,
      change: -1,
      changePct: -1.1,
    },
    marketOpen: true,
    asOf: new Date().toISOString(),
  };
}

/**
 * E2E tests for term structure shape classification.
 * These require mocked live quotes because the shape is computed in
 * useComputedSignals from the live VIX1D/VIX9D values (not the local
 * VIXTermStructure inputs).
 */
test.describe('Market Regime — Term Structure Shape (Mocked API)', () => {
  test('contango shape (VIX1D < VIX < VIX9D)', async ({ page }) => {
    // Mock quotes via addInitScript to work with Vite's PWA plugin
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: makeQuotesMock(14, 21) },
      }),
    );
    await page.goto('/');

    // Wait for auto-fill to fully complete
    await expect(page.getByLabel('SPY Price')).toHaveValue(/\d+/, {
      timeout: 10000,
    });
    // Wait for auto-fill to set the timezone to CT (it always does)
    await expect(chip(dateTimeSection(page), 'CT')).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 10000 },
    );

    // Now override to a valid market time — auto-fill has finished.
    await setEntryTime(page, { minute: '30', tz: 'CT' });

    // After time correction, results should appear
    await expect(
      page.locator('#results').getByText('All Delta Strikes'),
    ).toBeVisible({ timeout: 10000 });

    // The term-structure shape renders in the collapsed-by-default IV section
    await openSection(page, 'Implied Volatility');

    // VIX1D=14 < VIX=19 < VIX9D=21 → contango
    await expect(page.getByText('CONTANGO', { exact: true })).toBeVisible({
      timeout: 10000,
    });
  });

  test('fear-spike shape (VIX1D > VIX > VIX9D)', async ({ page }) => {
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: makeQuotesMock(28, 16) },
      }),
    );
    await page.goto('/');

    await expect(page.getByLabel('SPY Price')).toHaveValue(/\d+/, {
      timeout: 10000,
    });
    await expect(chip(dateTimeSection(page), 'CT')).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 10000 },
    );

    await setEntryTime(page, { minute: '30', tz: 'CT' });

    await expect(
      page.locator('#results').getByText('All Delta Strikes'),
    ).toBeVisible({ timeout: 10000 });

    await openSection(page, 'Implied Volatility');
    await expect(page.getByText('FEAR SPIKE', { exact: true })).toBeVisible({
      timeout: 10000,
    });
  });

  test('flat shape (VIX1D ≈ VIX ≈ VIX9D)', async ({ page }) => {
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: makeQuotesMock(19.2, 18.8) },
      }),
    );
    await page.goto('/');

    await expect(page.getByLabel('SPY Price')).toHaveValue(/\d+/, {
      timeout: 10000,
    });
    await expect(chip(dateTimeSection(page), 'CT')).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 10000 },
    );

    await setEntryTime(page, { minute: '30', tz: 'CT' });

    await expect(
      page.locator('#results').getByText('All Delta Strikes'),
    ).toBeVisible({ timeout: 10000 });

    await openSection(page, 'Implied Volatility');
    await expect(page.getByText('FLAT', { exact: true }).first()).toBeVisible({
      timeout: 5000,
    });
  });
});
