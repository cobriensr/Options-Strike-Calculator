import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Guards App.tsx's half of the cluster multiplier fix (F24). The multiplier
 * was state that only the Volatility Clustering panel set, and the panel sits
 * in the collapsed Market Regime card, so every page load used and saved 1.
 * Mounting <App /> in jsdom is too heavy (see App.panel-render.test.tsx), so
 * this reads the source the way App.iv-mode-wiring.test.ts does.
 * useClusterMultiplier.test.ts covers the hook's half: its value is right on
 * its own, with no panel mounted.
 */
const appSource = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf-8');

/** App.tsx without comments, so a comment that names a symbol doesn't count. */
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

describe('App cluster multiplier wiring', () => {
  it('takes clusterMult from useClusterMultiplier, not from state', () => {
    expect(appCode).toContain('const clusterMult = cluster.signal.mult;');
    expect(appCode).toMatch(/const cluster = useClusterMultiplier\(/);
  });

  it('computes it from the VIX, spot and the one resolved yesterday', () => {
    const args = callArgs('useClusterMultiplier');
    expect(args).toContain('Number.parseFloat(dVix)');
    expect(args).toContain('spot: results?.spot');
    expect(args).toMatch(/\byesterday,/);
  });

  it('resolves yesterday once: history first, the live feed only for today', () => {
    // resolveYesterday(snapshot's, live feed's, selected date is past)
    expect(appCode).toMatch(
      /const yesterday = resolveYesterday\(\s*historySnapshot\?\.yesterday,\s*market\.data\.yesterday\?\.yesterday,\s*analysisIsBacktest,\s*\);/,
    );
  });

  it('feeds that same yesterday to the signals, so the tilt and the multiplier agree', () => {
    const args = callArgs('useComputedSignals');
    for (const field of ['High', 'Low', 'Open', 'Close']) {
      expect(args).toContain(
        `liveYesterday${field}: yesterday?.${field.toLowerCase()},`,
      );
    }
  });

  it("gives the pre-market gap preview the resolved yesterday's close, and re-renders on it", () => {
    // A past date's Globex close must not meet today's prior close.
    const preview = /<PreMarketInput([\s\S]*?)\/>/.exec(appCode);
    if (!preview) throw new Error('Could not locate <PreMarketInput>');
    expect(preview[1]).toContain('prevClose={yesterday?.close}');
    // The panel map is memoized: its deps must carry the resolved value.
    expect(appCode).toMatch(/\n\s+yesterday,\s*\n\s*\],\s*\n\s*\);/);
  });

  it('scopes the owner edit to the selected date', () => {
    expect(callArgs('useClusterMultiplier')).toContain(
      'scope: vix.selectedDate',
    );
  });

  it.each(['useComputedSignals', 'buildSnapshotMeta', 'useAnalysisContext'])(
    '%s gets the derived clusterMult',
    (name) => {
      expect(callArgs(name)).toMatch(/\bclusterMult,/);
    },
  );

  it('hands the Market Regime card the hook result', () => {
    const card = /<MarketRegimeSection([\s\S]*?)\/>/.exec(appCode);
    if (!card) throw new Error('Could not locate <MarketRegimeSection>');
    expect(card[1]).toContain('cluster={cluster}');
  });
});
