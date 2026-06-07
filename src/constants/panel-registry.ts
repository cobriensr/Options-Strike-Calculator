/**
 * Panel registry — single source of truth for the 30 home-page sections.
 *
 * Replaces the inline `navSections` array that previously lived in
 * `src/App.tsx`. Both the section nav and the panel-prefs modal consume
 * this list. Adding a new panel is a one-line registry edit instead of
 * three duplicated lists drifting apart.
 *
 * Two panels (`sec-gexbot`, `sec-periscope-lessons`) render in App.tsx
 * but were missing from the old `navSections` array — they're included
 * here, which has the side benefit of restoring them to the section
 * nav menu.
 *
 * The `group` field is consumed by the PanelPrefsModal to organize
 * checkboxes; the section nav drops it.
 */

export type PanelGroup =
  | 'Inputs'
  | 'Market Context'
  | 'Futures'
  | 'Charts & History'
  | 'Trading'
  | 'Results';

export interface PanelRegistryEntry {
  id: string;
  label: string;
  group: PanelGroup;
}

export interface PanelRegistryContext {
  isAuthenticated: boolean;
  hasMarketOrSnapshot: boolean;
}

/**
 * Returns the panel registry filtered to entries available in the given
 * access/data context. Mirrors the original `navSections` visibility
 * gates so the section-nav menu doesn't list panels the user can't reach.
 */
export function getPanelRegistry(
  ctx: PanelRegistryContext,
): PanelRegistryEntry[] {
  const { isAuthenticated, hasMarketOrSnapshot } = ctx;
  const list: PanelRegistryEntry[] = [
    { id: 'sec-datetime', label: 'Date & Time', group: 'Inputs' },
    { id: 'sec-spot-price', label: 'Spot Price', group: 'Inputs' },
    { id: 'sec-premarket', label: 'Pre-Market Signals', group: 'Inputs' },
    {
      id: 'sec-premarket-futures',
      label: 'Pre-Market Futures Inputs',
      group: 'Inputs',
    },
    { id: 'sec-advanced', label: 'Advanced', group: 'Inputs' },
    { id: 'sec-iv', label: 'Implied Volatility', group: 'Inputs' },
    { id: 'sec-risk', label: 'Risk Calculator', group: 'Inputs' },
    { id: 'sec-regime', label: 'Market Regime', group: 'Market Context' },
    {
      id: 'sec-regime-0dte',
      label: '0DTE Gamma Regime',
      group: 'Market Context',
    },
  ];
  if (isAuthenticated && hasMarketOrSnapshot) {
    list.push(
      {
        id: 'sec-darkpool',
        label: 'Dark Pool Levels',
        group: 'Market Context',
      },
      { id: 'sec-gex-target', label: 'GEX Target', group: 'Market Context' },
      {
        id: 'sec-gex-landscape',
        label: 'GEX Landscape',
        group: 'Market Context',
      },
      { id: 'sec-zero-gamma', label: 'Zero Gamma', group: 'Market Context' },
      {
        id: 'sec-vega-spikes',
        label: 'Dir Vega Spikes',
        group: 'Market Context',
      },
      {
        id: 'sec-interval-ba-history',
        label: 'Interval B/A History',
        group: 'Market Context',
      },
      { id: 'sec-greek-flow', label: 'Greek Flow', group: 'Market Context' },
      {
        id: 'sec-dealer-regime',
        label: 'Dealer Regime',
        group: 'Market Context',
      },
      {
        id: 'sec-strike-battle-map',
        label: 'Strike Battle Map',
        group: 'Market Context',
      },
      {
        id: 'sec-lottery-finder',
        label: 'Lottery Finder',
        group: 'Market Context',
      },
      {
        id: 'sec-greek-heatmap',
        label: '0DTE Greek Heatmap',
        group: 'Market Context',
      },
      {
        id: 'sec-silent-boom',
        label: 'Silent Boom',
        group: 'Market Context',
      },
      {
        id: 'sec-periscope-lottery',
        label: 'Periscope Lottery',
        group: 'Market Context',
      },
      {
        id: 'sec-gexbot',
        label: 'GEXBot Dealer State',
        group: 'Market Context',
      },
      {
        id: 'sec-gamma-node-detector',
        label: 'Gamma-Node Composite Detector',
        group: 'Market Context',
      },
    );
  }
  if (isAuthenticated) {
    list.push({
      id: 'sec-futures',
      label: 'Futures Calculator',
      group: 'Futures',
    });
  }
  if (hasMarketOrSnapshot) {
    list.push({
      id: 'sec-charts',
      label: 'Chart Analysis',
      group: 'Charts & History',
    });
  }
  list.push({
    id: 'sec-history',
    label: 'Analysis History',
    group: 'Charts & History',
  });
  if (isAuthenticated) {
    list.push({
      id: 'sec-ml-insights',
      label: 'ML Insights',
      group: 'Charts & History',
    });
  }
  if (hasMarketOrSnapshot) {
    list.push({
      id: 'sec-periscope-exposure',
      label: 'Periscope MM Exposure',
      group: 'Market Context',
    });
  }
  if (isAuthenticated) {
    list.push(
      {
        id: 'sec-periscope-history',
        label: 'Periscope History',
        group: 'Charts & History',
      },
      {
        id: 'sec-periscope-lessons',
        label: 'Periscope Lesson Library',
        group: 'Charts & History',
      },
    );
  }
  list.push({
    id: 'sec-positions',
    label: 'Position Monitor',
    group: 'Trading',
  });
  if (isAuthenticated) {
    list.push(
      { id: 'sec-tracker', label: 'Contract Tracker', group: 'Trading' },
      { id: 'sec-bwb', label: 'BWB Calculator', group: 'Trading' },
    );
  }
  list.push({ id: 'results', label: 'Results', group: 'Results' });
  return list;
}

export const PANEL_GROUP_ORDER: PanelGroup[] = [
  'Inputs',
  'Market Context',
  'Futures',
  'Charts & History',
  'Trading',
  'Results',
];
