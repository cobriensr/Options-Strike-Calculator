import { describe, it, expect } from 'vitest';
import { getPanelRegistry, PANEL_GROUP_ORDER } from '../panel-registry';

describe('getPanelRegistry', () => {
  it('returns only Inputs + base panels for a public visitor (no auth, no data)', () => {
    const ids = getPanelRegistry({
      isAuthenticated: false,
      hasMarketOrSnapshot: false,
    }).map((e) => e.id);

    expect(ids).toEqual([
      'sec-datetime',
      'sec-spot-price',
      'sec-premarket',
      'sec-advanced',
      'sec-iv',
      'sec-risk',
      'sec-regime',
      'sec-history',
      'sec-positions',
      'results',
    ]);
  });

  it('adds sec-charts and sec-periscope-exposure when hasMarketOrSnapshot is true (no auth)', () => {
    const ids = getPanelRegistry({
      isAuthenticated: false,
      hasMarketOrSnapshot: true,
    }).map((e) => e.id);

    expect(ids).toContain('sec-charts');
    expect(ids).toContain('sec-periscope-exposure');
    // auth-only panels still excluded
    expect(ids).not.toContain('sec-futures');
    expect(ids).not.toContain('sec-bwb');
    expect(ids).not.toContain('sec-tracker');
    expect(ids).not.toContain('sec-darkpool'); // needs auth+market
  });

  it('adds auth-only panels when isAuthenticated is true (no market data)', () => {
    const ids = getPanelRegistry({
      isAuthenticated: true,
      hasMarketOrSnapshot: false,
    }).map((e) => e.id);

    expect(ids).toContain('sec-futures');
    expect(ids).toContain('sec-ml-insights');
    expect(ids).toContain('sec-periscope-history');
    expect(ids).toContain('sec-periscope-lessons');
    expect(ids).toContain('sec-tracker');
    expect(ids).toContain('sec-bwb');
    // market+auth panels still excluded
    expect(ids).not.toContain('sec-darkpool');
    expect(ids).not.toContain('sec-gexbot');
  });

  it('returns the full panel set for an authenticated owner with market data', () => {
    const entries = getPanelRegistry({
      isAuthenticated: true,
      hasMarketOrSnapshot: true,
    });
    const ids = entries.map((e) => e.id);

    // Spot-check: every documented panel must appear
    const expected = [
      'sec-datetime',
      'sec-spot-price',
      'sec-premarket',
      'sec-advanced',
      'sec-iv',
      'sec-risk',
      'sec-regime',
      'sec-darkpool',
      'sec-gex-target',
      'sec-gex-landscape',
      'sec-zero-gamma',
      'sec-vega-spikes',
      'sec-interval-ba-history',
      'sec-greek-flow',
      'sec-dealer-regime',
      'sec-strike-battle-map',
      'sec-lottery-finder',
      'sec-greek-heatmap',
      'sec-silent-boom',
      'sec-periscope-lottery',
      'sec-gexbot',
      'sec-gamma-node-detector',
      'sec-futures',
      'sec-charts',
      'sec-history',
      'sec-ml-insights',
      'sec-periscope-exposure',
      'sec-periscope-history',
      'sec-periscope-lessons',
      'sec-positions',
      'sec-tracker',
      'sec-bwb',
      'results',
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
    expect(entries).toHaveLength(expected.length);
  });

  it('includes sec-gexbot and sec-periscope-lessons (previously missing from navSections)', () => {
    // Regression test for the documented side-effect fix: the old inline
    // navSections array in App.tsx was missing both panels even though
    // they rendered in the JSX. The registry restores them.
    const ids = getPanelRegistry({
      isAuthenticated: true,
      hasMarketOrSnapshot: true,
    }).map((e) => e.id);
    expect(ids).toContain('sec-gexbot');
    expect(ids).toContain('sec-periscope-lessons');
  });

  it('assigns every togglable panel id to a group in PANEL_GROUP_ORDER', () => {
    const entries = getPanelRegistry({
      isAuthenticated: true,
      hasMarketOrSnapshot: true,
    }).filter((e) => e.id !== 'results');
    for (const entry of entries) {
      expect(PANEL_GROUP_ORDER).toContain(entry.group);
    }
  });

  it('every panel id matches the server Zod regex /^sec-[a-z0-9-]+$/ (except results)', () => {
    const entries = getPanelRegistry({
      isAuthenticated: true,
      hasMarketOrSnapshot: true,
    });
    const togglable = entries.filter((e) => e.id !== 'results');
    for (const entry of togglable) {
      expect(entry.id).toMatch(/^sec-[a-z0-9-]+$/);
    }
  });
});
