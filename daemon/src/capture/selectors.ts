/**
 * Selectors + chart-type constants for the TRACE capture flow.
 *
 * Selectors duplicated from scripts/capture-trace.ts. SoT: capture-trace.ts.
 */

import type { Locator, Page } from '@playwright/test';

export type ChartKey = 'gamma' | 'charm' | 'delta';
export type ChartType = 'Charm Pressure' | 'Delta Pressure' | 'Gamma';

export const CHART_TYPES: Record<ChartKey, ChartType> = {
  gamma: 'Gamma',
  charm: 'Charm Pressure',
  delta: 'Delta Pressure',
};

export const SEL = {
  chartTypeDropdown: (page: Page): Locator =>
    page
      .locator('[role="combobox"]')
      .filter({ hasText: /^(Charm Pressure|Delta Pressure|Gamma)$/ })
      .first(),
  gexToggle: (page: Page): Locator =>
    page
      .locator('label')
      .filter({ has: page.locator('p', { hasText: /^0DTE GEX$/ }) })
      .locator('input[type="checkbox"]'),
  strikeZoomSlider: (page: Page): Locator =>
    page
      .locator(
        'input[type="range"][aria-label*="strike" i], input[type="range"][aria-label*="zoom" i]',
      )
      .first(),
  stabilityGauge: (page: Page): Locator =>
    page.locator('[role="meter"]').first(),
  spxHeader: (page: Page): Locator =>
    page.locator(String.raw`text=/\^SPX:/`).locator('..'),
};

export const SPOT_PRICE_RE = /\^SPX:\s*([\d,.]+)/;
