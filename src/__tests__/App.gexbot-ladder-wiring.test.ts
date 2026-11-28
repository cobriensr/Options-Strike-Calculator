import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Guards App.tsx's half of the GEXBot level ladder (phase 3a). The ladder's
 * three App-supplied inputs each compile with the wrong value, and
 * GexbotSection.test.tsx and LevelLadder.test.tsx pass them by prop, so only
 * this test pins what App hands <GexbotSection />:
 *
 *   - `allDeltas` must be null in backtest mode. The calculator then describes
 *     a past moment (a scrubbed entry time, yesterday's date) while the levels
 *     and the expected move are live, so without the gate the ladder prints
 *     CLEAR and odds for strikes from a past spot against today's levels.
 *   - `quotesFetchedAt` is the age the ladder's stale-quote rule reads. Drop it
 *     and the quote never goes stale: a lapsed login keeps freezing the ladder
 *     on its last Schwab price instead of falling back to GEXBot's spot.
 *   - `session` is the other half of that rule: a quote's age only counts in
 *     a session where quotes are still polled.
 *
 * This file reads the source, the way App.live-spx-wiring.test.ts does, so the
 * wiring stays visible without the three dozen module mocks a mounted <App />
 * needs. The backtest flag's own definition is pinned in
 * App.date-clock-wiring.test.ts.
 */
const appSource = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf-8');

/** App.tsx without comments, so a comment that names a prop doesn't count. */
const appCode = appSource
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

/** The props of the one `<GexbotSection ... />` element, up to its `/>`. */
function gexbotSectionProps(): string {
  expect(appCode.match(/<GexbotSection\b/g)).toHaveLength(1);
  const match = /<GexbotSection\b([\s\S]*?)\/>/.exec(appCode);
  if (!match)
    throw new Error('Could not locate <GexbotSection ... /> in App.tsx');
  return match[1]!;
}

describe('App GEXBot level ladder wiring', () => {
  it('hands the section no calculator rows in backtest mode', () => {
    // Whitespace-tolerant: prettier wraps the prop onto its own lines when the
    // expression grows.
    expect(gexbotSectionProps()).toMatch(
      /\ballDeltas=\{\s*backtestMode \? null : \(results\?\.allDeltas \?\? null\)\s*\}/,
    );
  });

  it("hands the section the quotes' last successful fetch time, which ages the quote", () => {
    expect(gexbotSectionProps()).toMatch(
      /\bquotesFetchedAt=\{\s*market\.quotesFetchedAt\s*\}/,
    );
  });

  it('hands the section the current equity session', () => {
    expect(gexbotSectionProps()).toMatch(/\bsession=\{\s*market\.session\s*\}/);
  });
});
