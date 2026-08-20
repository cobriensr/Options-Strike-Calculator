/**
 * E2E helper for expanding collapsible sections.
 *
 * `src/components/ui/SectionBox.tsx` renders collapsible sections with a
 * toggle button (`aria-label="Toggle ${label}"`, `aria-expanded`) and
 * UNMOUNTS the children while collapsed. Several sections are
 * default-collapsed in `src/App.tsx` (`defaultCollapsed`):
 *
 *   - Implied Volatility  (IVInputSection — VIX Value / Direct IV inputs)
 *   - Advanced            (put skew, iron condor, contracts, wing width)
 *   - Risk Calculator
 *   - Market Regime
 *   - Chart Analysis
 *   - Analysis History
 *   - Position Monitor
 *   - Settlement Pin Calculator (BWBCalculator)
 *
 * Any spec that touches an input inside one of these sections must call
 * `expandSection(page, label)` first, or the locator will never resolve.
 */
import { expect, type Page } from '@playwright/test';

/** Labels of default-collapsed sections (open list — any SectionBox label works). */
export type SectionLabel =
  | 'Implied Volatility'
  | 'Advanced'
  | 'Risk Calculator'
  | 'Market Regime'
  | 'Chart Analysis'
  | 'Analysis History'
  | 'Position Monitor'
  | 'Settlement Pin Calculator'
  | (string & {});

/**
 * Expand a collapsible SectionBox by its label if it is currently
 * collapsed, then wait until it reports expanded. Safe to call on an
 * already-expanded section (no-op click is skipped).
 */
export async function expandSection(
  page: Page,
  label: SectionLabel,
): Promise<void> {
  const toggle = page.getByRole('button', {
    name: `Toggle ${label}`,
    exact: true,
  });
  // Lazy-loaded sections (Suspense) may not have mounted yet.
  await toggle.waitFor({ state: 'visible' });
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
