import { describe, it, expect } from 'vitest';
import type { PanelRegistryEntry } from '../../constants/panel-registry.js';
import {
  resolveGroupOrder,
  resolvePanelOrder,
} from '../../utils/panel-order.js';

const REGISTRY_GROUPS = [
  'Inputs',
  'Market Context',
  'Futures',
  'Trading',
] as const;

const REGISTRY: PanelRegistryEntry[] = [
  { id: 'sec-datetime', label: 'Date & Time', group: 'Inputs' },
  { id: 'sec-spot-price', label: 'Spot Price', group: 'Inputs' },
  { id: 'sec-premarket', label: 'Pre-Market Signals', group: 'Inputs' },
  { id: 'sec-regime', label: 'Market Regime', group: 'Market Context' },
  { id: 'sec-gex-target', label: 'GEX Target', group: 'Market Context' },
  { id: 'sec-futures', label: 'Futures Calculator', group: 'Futures' },
  { id: 'sec-positions', label: 'Position Monitor', group: 'Trading' },
];

describe('resolveGroupOrder', () => {
  it('returns registry order when stored is empty', () => {
    expect(resolveGroupOrder([], REGISTRY_GROUPS)).toEqual([
      'Inputs',
      'Market Context',
      'Futures',
      'Trading',
    ]);
  });

  it('respects stored order then appends unknown registry groups', () => {
    expect(resolveGroupOrder(['Trading', 'Inputs'], REGISTRY_GROUPS)).toEqual([
      'Trading',
      'Inputs',
      'Market Context',
      'Futures',
    ]);
  });

  it('drops stored groups not in registry', () => {
    expect(
      resolveGroupOrder(['DeletedGroup', 'Trading'], REGISTRY_GROUPS),
    ).toEqual(['Trading', 'Inputs', 'Market Context', 'Futures']);
  });

  it('drops duplicate stored groups (defensive — Zod rejects but resolver must be robust)', () => {
    expect(
      resolveGroupOrder(['Trading', 'Trading', 'Inputs'], REGISTRY_GROUPS),
    ).toEqual(['Trading', 'Inputs', 'Market Context', 'Futures']);
  });

  it('returns full registry order when stored matches everything', () => {
    expect(
      resolveGroupOrder(
        ['Futures', 'Trading', 'Market Context', 'Inputs'],
        REGISTRY_GROUPS,
      ),
    ).toEqual(['Futures', 'Trading', 'Market Context', 'Inputs']);
  });
});

describe('resolvePanelOrder', () => {
  it('returns registry order for a group when stored is empty', () => {
    expect(resolvePanelOrder([], REGISTRY, 'Inputs')).toEqual([
      'sec-datetime',
      'sec-spot-price',
      'sec-premarket',
    ]);
  });

  it('respects stored order then appends unknown registry panels', () => {
    expect(
      resolvePanelOrder(['sec-spot-price', 'sec-datetime'], REGISTRY, 'Inputs'),
    ).toEqual(['sec-spot-price', 'sec-datetime', 'sec-premarket']);
  });

  it('filters out stored ids that belong to a different group', () => {
    // sec-regime is Market Context, not Inputs — must not leak in.
    expect(
      resolvePanelOrder(
        ['sec-regime', 'sec-spot-price', 'sec-datetime'],
        REGISTRY,
        'Inputs',
      ),
    ).toEqual(['sec-spot-price', 'sec-datetime', 'sec-premarket']);
  });

  it('drops stored ids that are no longer in registry', () => {
    expect(
      resolvePanelOrder(
        ['sec-deleted-panel', 'sec-spot-price'],
        REGISTRY,
        'Inputs',
      ),
    ).toEqual(['sec-spot-price', 'sec-datetime', 'sec-premarket']);
  });

  it('returns empty when group has no registry entries', () => {
    expect(resolvePanelOrder(['sec-anything'], REGISTRY, 'Charts')).toEqual([]);
  });

  it('handles a registry-extended scenario — user customized 2 of 3, then a 4th panel was added', () => {
    const extended: PanelRegistryEntry[] = [
      ...REGISTRY,
      { id: 'sec-iv', label: 'Implied Volatility', group: 'Inputs' },
    ];
    expect(
      resolvePanelOrder(['sec-spot-price', 'sec-datetime'], extended, 'Inputs'),
    ).toEqual([
      'sec-spot-price',
      'sec-datetime',
      'sec-premarket',
      'sec-iv', // newly registered, appears at the end
    ]);
  });

  it('drops duplicate stored ids', () => {
    expect(
      resolvePanelOrder(
        ['sec-spot-price', 'sec-spot-price', 'sec-datetime'],
        REGISTRY,
        'Inputs',
      ),
    ).toEqual(['sec-spot-price', 'sec-datetime', 'sec-premarket']);
  });
});
