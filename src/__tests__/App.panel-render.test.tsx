import { describe, it, expect } from 'vitest';
import { getPanelRegistry } from '../constants/panel-registry';
import { resolveGroupOrder, resolvePanelOrder } from '../utils/panel-order';
import {
  PANEL_GROUP_ORDER,
  type PanelGroup,
} from '../constants/panel-registry';

/**
 * Guards the default-order render contract after the Phase-3
 * App.tsx refactor (spec: panel-reordering-2026-05-17.md):
 *
 *   - With empty stored panel_order + group_order, the two-level
 *     resolver must emit panel ids in the exact registry sequence.
 *   - Group order matches PANEL_GROUP_ORDER + Results.
 *
 * Mounting <App /> in jsdom is too heavy here (it would pull in
 * websockets, lazy chunks, and live API calls). Instead we exercise
 * the same resolver pipeline App.tsx uses internally — the
 * `resolvedGroups` + `resolvedPanelsByGroup` machinery — and assert
 * the output sequence. If a future App.tsx change deviates from the
 * resolver contract, the lint+typecheck pass will surface it; this
 * test guards the resolver inputs/outputs that drive the render.
 */
describe('Default-order panel render contract', () => {
  const registryGroups: PanelGroup[] = [...PANEL_GROUP_ORDER, 'Results'];

  it('owner with full market context: groups + panels match registry order', () => {
    const registry = getPanelRegistry({
      isAuthenticated: true,
      hasMarketOrSnapshot: true,
    });
    const groups = resolveGroupOrder([], registryGroups);
    expect(groups).toEqual([
      'Inputs',
      'Market Context',
      'Futures',
      'Charts & History',
      'Trading',
      'Results',
    ]);

    const sequence: string[] = [];
    for (const group of groups) {
      sequence.push(...resolvePanelOrder([], registry, group));
    }
    // First few should be Inputs in registry order
    expect(sequence.slice(0, 6)).toEqual([
      'sec-datetime',
      'sec-spot-price',
      'sec-premarket',
      'sec-advanced',
      'sec-iv',
      'sec-risk',
    ]);
    // Last id must be results
    expect(sequence.at(-1)).toBe('results');
  });

  it('public visitor (no auth, no market): hides auth/market-only panels', () => {
    const registry = getPanelRegistry({
      isAuthenticated: false,
      hasMarketOrSnapshot: false,
    });
    const groups = resolveGroupOrder([], registryGroups);
    const sequence: string[] = [];
    for (const group of groups) {
      sequence.push(...resolvePanelOrder([], registry, group));
    }
    // Auth-only panels must NOT appear
    expect(sequence).not.toContain('sec-futures');
    expect(sequence).not.toContain('sec-tracker');
    expect(sequence).not.toContain('sec-bwb');
    expect(sequence).not.toContain('sec-ml-insights');
    expect(sequence).not.toContain('sec-periscope-history');
    expect(sequence).not.toContain('sec-periscope-lessons');
    // Market-only panels must NOT appear
    expect(sequence).not.toContain('sec-darkpool');
    expect(sequence).not.toContain('sec-gex-target');
    expect(sequence).not.toContain('sec-charts');
    expect(sequence).not.toContain('sec-periscope-exposure');
    // Always-on panels still appear
    expect(sequence).toContain('sec-datetime');
    expect(sequence).toContain('sec-regime');
    expect(sequence).toContain('sec-history');
    expect(sequence).toContain('sec-positions');
    expect(sequence).toContain('results');
  });

  it('user-reordered groups: outer loop honors stored group_order', () => {
    const groups = resolveGroupOrder(
      ['Trading', 'Market Context'],
      registryGroups,
    );
    expect(groups[0]).toBe('Trading');
    expect(groups[1]).toBe('Market Context');
    // Unspecified groups append in registry order
    expect(groups.slice(2)).toEqual([
      'Inputs',
      'Futures',
      'Charts & History',
      'Results',
    ]);
  });

  it('user-reordered panels: inner loop honors stored panel_order', () => {
    const registry = getPanelRegistry({
      isAuthenticated: true,
      hasMarketOrSnapshot: true,
    });
    const inputs = resolvePanelOrder(
      ['sec-spot-price', 'sec-iv', 'sec-datetime'],
      registry,
      'Inputs',
    );
    expect(inputs).toEqual([
      'sec-spot-price',
      'sec-iv',
      'sec-datetime',
      'sec-premarket', // unspecified, registry order from here
      'sec-advanced',
      'sec-risk',
    ]);
  });
});
