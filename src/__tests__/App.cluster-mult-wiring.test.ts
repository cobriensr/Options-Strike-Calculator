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
    expect(appCode).not.toMatch(/setClusterMult/);
  });

  it('computes it from the VIX, spot and the history-else-live yesterday', () => {
    const args = callArgs('useClusterMultiplier');
    expect(args).toContain('Number.parseFloat(dVix)');
    expect(args).toContain('spot: results?.spot');
    expect(args).toContain(
      'historySnapshot?.yesterday ?? market.data.yesterday?.yesterday',
    );
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

  it('hands the Market Regime card the hook result, not a setter', () => {
    const card = /<MarketRegimeSection([\s\S]*?)\/>/.exec(appCode);
    if (!card) throw new Error('Could not locate <MarketRegimeSection>');
    expect(card[1]).toContain('cluster={cluster}');
    expect(card[1]).not.toContain('onClusterMultChange');
  });
});
