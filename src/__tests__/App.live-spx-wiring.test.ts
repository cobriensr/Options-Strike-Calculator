import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Guards App.tsx's half of the live rows' SPX price context. Live
 * market_snapshots rows carry the SPX open, high, low, previous close and gap
 * only when App hands useComputedSignals the live SPX quote, and only keep a
 * past date, or a quote from outside the cash session, out of them when it
 * also hands it the date-based backtest flag and the quotes payload's
 * marketOpen. Each compiles with the argument missing (liveSpx is optional,
 * and the flags can be passed as a wrong value), and the hooks' own tests pass
 * the values by prop, so only this test pins the wiring. Mounting <App /> in
 * jsdom is too heavy (see App.panel-render.test.tsx), so this reads the source
 * the way App.cluster-mult-wiring.test.ts does. The flag's own definition,
 * `analysisIsBacktest`, is pinned in App.date-clock-wiring.test.ts.
 */
const appSource = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf-8');

/** App.tsx without comments, so a comment that names a field doesn't count. */
const appCode = appSource
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

/** The argument object of `<name>({ ... })`, up to its closing brace. */
function callArgs(name: string): string {
  const match = new RegExp(String.raw`\b${name}\(\{([\s\S]*?)\n\s*\}\)`).exec(
    appCode,
  );
  if (!match) throw new Error(`Could not locate ${name}({ ... }) in App.tsx`);
  return match[1]!;
}

describe('App live SPX price context wiring', () => {
  it("hands useComputedSignals the live SPX quote's open, high, low and previous close", () => {
    expect(callArgs('useComputedSignals')).toContain(
      'liveSpx: market.data.quotes?.spx ?? undefined,',
    );
  });

  it("hands useComputedSignals the quotes payload's marketOpen, which keeps a pre-open or post-close quote out of the rows", () => {
    expect(callArgs('useComputedSignals')).toContain(
      'quotesMarketOpen: market.data.quotes?.marketOpen ?? false,',
    );
  });

  it('hands useComputedSignals the date-based backtest flag that keeps that quote off a past date', () => {
    expect(callArgs('useComputedSignals')).toContain(
      'isBacktest: analysisIsBacktest,',
    );
  });

  it("reads the quotes payload's marketOpen nowhere else: every poll and panel gate is the clock-and-access flag", () => {
    // The quote's flag says whether the quote is a live RTH print. As a
    // polling gate it stays true after the close once quotes starts failing,
    // and is false all session when the tab loaded logged out. The mounted
    // gate values are pinned in App.market-open-gate.test.tsx; this keeps a
    // new panel from reaching for the old flag.
    expect(appCode.match(/quotes\?\.marketOpen/g)).toHaveLength(1);
  });
});
