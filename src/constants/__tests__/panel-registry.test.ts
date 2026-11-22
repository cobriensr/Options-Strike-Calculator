import { describe, it, expect } from 'vitest';
import { getPanelRegistry, PANEL_GROUP_ORDER } from '../panel-registry';

// The three viewers the registry tells apart: `isAuthenticated` is true for a
// guest as well as the owner, `isOwner` only for the owner.
const PUBLIC = { isAuthenticated: false, isOwner: false } as const;
const GUEST = { isAuthenticated: true, isOwner: false } as const;
const OWNER = { isAuthenticated: true, isOwner: true } as const;

describe('getPanelRegistry', () => {
  it('returns only Inputs + base panels for a public visitor (no auth, no data)', () => {
    const ids = getPanelRegistry({
      ...PUBLIC,
      hasMarketOrSnapshot: false,
    }).map((e) => e.id);

    expect(ids).toEqual([
      'sec-datetime',
      'sec-spot-price',
      'sec-advanced',
      'sec-iv',
      'sec-risk',
      'sec-regime',
      'results',
    ]);
  });

  // Pre-Market Futures Inputs mounts PreMarketInput only when `market.hasData`,
  // which is never true for a public visitor, and Position Monitor renders null
  // for anyone but the owner. Either one listed for a viewer who cannot see it
  // is a nav and prefs entry that opens an empty anchor.
  it('omits sec-premarket-futures and sec-positions for a public visitor, with or without market data', () => {
    for (const hasMarketOrSnapshot of [true, false]) {
      const ids = getPanelRegistry({
        ...PUBLIC,
        hasMarketOrSnapshot,
      }).map((e) => e.id);
      expect(ids).not.toContain('sec-premarket-futures');
      expect(ids).not.toContain('sec-positions');
    }
  });

  it('lists sec-premarket-futures but not sec-positions for a guest, with or without market data', () => {
    for (const hasMarketOrSnapshot of [true, false]) {
      const ids = getPanelRegistry({ ...GUEST, hasMarketOrSnapshot }).map(
        (e) => e.id,
      );
      expect(ids).toContain('sec-premarket-futures');
      expect(ids).not.toContain('sec-positions');
    }
  });

  it('keeps sec-premarket-futures and sec-positions in their old places for the owner, with or without market data', () => {
    for (const hasMarketOrSnapshot of [true, false]) {
      const entries = getPanelRegistry({ ...OWNER, hasMarketOrSnapshot });
      const ids = entries.map((e) => e.id);

      // Right after Pre-Market Signals, before Advanced.
      expect(ids.indexOf('sec-premarket-futures')).toBe(
        ids.indexOf('sec-premarket') + 1,
      );
      expect(ids.indexOf('sec-advanced')).toBe(
        ids.indexOf('sec-premarket-futures') + 1,
      );
      // First of the Trading group, ahead of the tracker and BWB.
      const trading = entries
        .filter((e) => e.group === 'Trading')
        .map((e) => e.id);
      expect(trading).toEqual(['sec-positions', 'sec-tracker', 'sec-bwb']);
      expect(entries.find((e) => e.id === 'sec-positions')).toEqual({
        id: 'sec-positions',
        label: 'Position Monitor',
        group: 'Trading',
      });
    }
  });

  // Both cards in Pre-Market Signals (the opening-flow signal and the pin
  // setup) read owner-or-guest endpoints, so nothing public is left in it: a
  // public visitor gets no panel, nav or prefs entry, and the panel's hooks
  // never mount to fetch.
  it('omits sec-premarket for a public visitor, with or without market data', () => {
    for (const hasMarketOrSnapshot of [true, false]) {
      const ids = getPanelRegistry({
        ...PUBLIC,
        hasMarketOrSnapshot,
      }).map((e) => e.id);
      expect(ids).not.toContain('sec-premarket');
    }
  });

  it('keeps sec-premarket between sec-spot-price and sec-premarket-futures for an owner or guest, with or without market data', () => {
    for (const viewer of [OWNER, GUEST]) {
      for (const hasMarketOrSnapshot of [true, false]) {
        const entries = getPanelRegistry({ ...viewer, hasMarketOrSnapshot });
        const inputs = entries.filter((e) => e.group === 'Inputs');
        expect(inputs.map((e) => e.id)).toEqual([
          'sec-datetime',
          'sec-spot-price',
          'sec-premarket',
          'sec-premarket-futures',
          'sec-advanced',
          'sec-iv',
          'sec-risk',
        ]);
        expect(inputs.find((e) => e.id === 'sec-premarket')).toEqual({
          id: 'sec-premarket',
          label: 'Pre-Market Signals',
          group: 'Inputs',
        });
      }
    }
  });

  // /api/regime-0dte is withDbReader(..., 'owner-or-guest'): the panel is never
  // mounted for a public visitor, who could only get a placeholder or a 401.
  it('omits sec-regime-0dte for a public visitor, with or without market data', () => {
    for (const hasMarketOrSnapshot of [true, false]) {
      const ids = getPanelRegistry({
        ...PUBLIC,
        hasMarketOrSnapshot,
      }).map((e) => e.id);
      expect(ids).not.toContain('sec-regime-0dte');
    }
  });

  it('puts sec-regime-0dte right after sec-regime for an owner or guest, with or without market data', () => {
    for (const viewer of [OWNER, GUEST]) {
      for (const hasMarketOrSnapshot of [true, false]) {
        const ids = getPanelRegistry({ ...viewer, hasMarketOrSnapshot }).map(
          (e) => e.id,
        );
        expect(ids.indexOf('sec-regime-0dte')).toBe(
          ids.indexOf('sec-regime') + 1,
        );
      }
    }
  });

  // Chart Analysis asks /api/analyses (owner-or-guest) on mount, and
  // `market.data` stays set after a drop to public, so `hasMarketOrSnapshot`
  // alone would leave a now-public visitor with the panel and its request.
  it('omits sec-charts for a public visitor even with market data', () => {
    const ids = getPanelRegistry({
      ...PUBLIC,
      hasMarketOrSnapshot: true,
    }).map((e) => e.id);

    expect(ids).not.toContain('sec-charts');
    // auth-only panels stay excluded too
    expect(ids).not.toContain('sec-futures');
    expect(ids).not.toContain('sec-bwb');
    expect(ids).not.toContain('sec-tracker');
    expect(ids).not.toContain('sec-darkpool'); // needs auth+market
  });

  it.each([
    ['an owner', OWNER],
    ['a guest', GUEST],
  ])(
    'puts sec-charts first in Charts & History for %s with market data',
    (_who, viewer) => {
      const entries = getPanelRegistry({
        ...viewer,
        hasMarketOrSnapshot: true,
      });
      const charts = entries.filter((e) => e.group === 'Charts & History');

      expect(charts[0]).toEqual({
        id: 'sec-charts',
        label: 'Chart Analysis',
        group: 'Charts & History',
      });
    },
  );

  it.each([
    ['an owner', OWNER],
    ['a guest', GUEST],
  ])('omits sec-charts for %s with no market data', (_who, viewer) => {
    const ids = getPanelRegistry({
      ...viewer,
      hasMarketOrSnapshot: false,
    }).map((e) => e.id);

    expect(ids).not.toContain('sec-charts');
  });

  // The component renders nothing for a guest and /api/analyses is
  // owner-or-guest, so only the owner gets a panel, a nav entry and a prefs
  // entry; a guest used to get the last two for an empty anchor.
  it('lists sec-history for the owner, with or without market data', () => {
    for (const hasMarketOrSnapshot of [true, false]) {
      const entries = getPanelRegistry({ ...OWNER, hasMarketOrSnapshot });

      expect(entries.find((e) => e.id === 'sec-history')).toEqual({
        id: 'sec-history',
        label: 'Analysis History',
        group: 'Charts & History',
      });
    }
  });

  it('puts sec-history right after sec-charts for the owner with market data', () => {
    const ids = getPanelRegistry({
      ...OWNER,
      hasMarketOrSnapshot: true,
    }).map((e) => e.id);

    expect(ids.indexOf('sec-history')).toBe(ids.indexOf('sec-charts') + 1);
  });

  it.each([
    ['a guest', GUEST],
    ['a public visitor', PUBLIC],
  ])(
    'omits sec-history for %s, with or without market data',
    (_who, viewer) => {
      for (const hasMarketOrSnapshot of [true, false]) {
        const ids = getPanelRegistry({ ...viewer, hasMarketOrSnapshot }).map(
          (e) => e.id,
        );
        expect(ids).not.toContain('sec-history');
      }
    },
  );

  it('differs between the owner and a guest by sec-history and sec-positions alone', () => {
    // The two panels that render nothing for a guest.
    const ownerOnly = new Set(['sec-history', 'sec-positions']);
    for (const hasMarketOrSnapshot of [true, false]) {
      const owner = getPanelRegistry({ ...OWNER, hasMarketOrSnapshot });
      const guest = getPanelRegistry({ ...GUEST, hasMarketOrSnapshot });

      expect(guest).toEqual(owner.filter((e) => !ownerOnly.has(e.id)));
    }
  });

  // Both /api/periscope-map and /api/periscope-exposure sit behind
  // guardOwnerOrGuestEndpoint, so a public visitor must not get a nav or
  // prefs entry for the panel they back, market data or not.
  it('omits sec-periscope-exposure for a public visitor even with market data', () => {
    for (const hasMarketOrSnapshot of [true, false]) {
      const ids = getPanelRegistry({
        ...PUBLIC,
        hasMarketOrSnapshot,
      }).map((e) => e.id);
      expect(ids).not.toContain('sec-periscope-exposure');
    }
  });

  it('adds sec-periscope-exposure for an owner or guest with market data, last in Market Context', () => {
    for (const viewer of [OWNER, GUEST]) {
      const entries = getPanelRegistry({
        ...viewer,
        hasMarketOrSnapshot: true,
      });
      const marketContext = entries
        .filter((e) => e.group === 'Market Context')
        .map((e) => e.id);

      expect(marketContext).toContain('sec-periscope-exposure');
      expect(marketContext.at(-1)).toBe('sec-periscope-exposure');
      expect(marketContext.slice(-2)[0]).toBe('sec-gamma-node-detector');
    }
  });

  it('omits sec-periscope-exposure for an owner or guest with no market data (App renders it only under hasMarketContext)', () => {
    for (const viewer of [OWNER, GUEST]) {
      const ids = getPanelRegistry({
        ...viewer,
        hasMarketOrSnapshot: false,
      }).map((e) => e.id);
      expect(ids).not.toContain('sec-periscope-exposure');
    }
  });

  it('adds auth-only panels when isAuthenticated is true (no market data)', () => {
    for (const viewer of [OWNER, GUEST]) {
      const ids = getPanelRegistry({
        ...viewer,
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
    }
  });

  it('returns the full panel set for an authenticated owner with market data', () => {
    const entries = getPanelRegistry({
      ...OWNER,
      hasMarketOrSnapshot: true,
    });
    const ids = entries.map((e) => e.id);

    // Spot-check: every documented panel must appear
    const expected = [
      'sec-datetime',
      'sec-spot-price',
      'sec-premarket',
      'sec-premarket-futures',
      'sec-advanced',
      'sec-iv',
      'sec-risk',
      'sec-regime',
      'sec-regime-0dte',
      'sec-darkpool',
      'sec-gex-target',
      'sec-gex-landscape',
      'sec-zero-gamma',
      'sec-vega-spikes',
      'sec-interval-ba-history',
      'sec-greek-flow',
      'sec-dealer-regime',
      'sec-strike-battle-map',
      'sec-greek-heatmap',
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
      ...OWNER,
      hasMarketOrSnapshot: true,
    }).map((e) => e.id);
    expect(ids).toContain('sec-gexbot');
    expect(ids).toContain('sec-periscope-lessons');
  });

  it('assigns every togglable panel id to a group in PANEL_GROUP_ORDER', () => {
    const entries = getPanelRegistry({
      ...OWNER,
      hasMarketOrSnapshot: true,
    }).filter((e) => e.id !== 'results');
    for (const entry of entries) {
      expect(PANEL_GROUP_ORDER).toContain(entry.group);
    }
  });

  it('every panel id matches the server Zod regex /^sec-[a-z0-9-]+$/ (except results)', () => {
    const entries = getPanelRegistry({
      ...OWNER,
      hasMarketOrSnapshot: true,
    });
    const togglable = entries.filter((e) => e.id !== 'results');
    for (const entry of togglable) {
      expect(entry.id).toMatch(/^sec-[a-z0-9-]+$/);
    }
  });

  it('relabels the GEXBot panel as taker flow without changing its id', () => {
    const entry = getPanelRegistry({
      ...OWNER,
      hasMarketOrSnapshot: true,
    }).find((e) => e.id === 'sec-gexbot');
    expect(entry?.label).toBe('GEXBot Taker Flow');
  });
});
