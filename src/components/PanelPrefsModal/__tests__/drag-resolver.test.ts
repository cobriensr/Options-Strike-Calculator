import { describe, it, expect } from 'vitest';
import type { PanelRegistryEntry } from '../../../constants/panel-registry';
import { resolveDragEnd } from '../drag-resolver';

const GROUPS = ['Inputs', 'Market Context', 'Trading'];

const REGISTRY: PanelRegistryEntry[] = [
  { id: 'sec-datetime', label: 'Date & Time', group: 'Inputs' },
  { id: 'sec-spot-price', label: 'Spot Price', group: 'Inputs' },
  { id: 'sec-premarket', label: 'Pre-Market Signals', group: 'Inputs' },
  { id: 'sec-regime', label: 'Market Regime', group: 'Market Context' },
  { id: 'sec-darkpool', label: 'Dark Pool Levels', group: 'Market Context' },
  { id: 'sec-positions', label: 'Position Monitor', group: 'Trading' },
];

const entriesByGroup = new Map<string, PanelRegistryEntry[]>([
  ['Inputs', REGISTRY.filter((e) => e.group === 'Inputs')],
  ['Market Context', REGISTRY.filter((e) => e.group === 'Market Context')],
  ['Trading', REGISTRY.filter((e) => e.group === 'Trading')],
]);

const isGroupId = (id: string) => GROUPS.includes(id);
const groupForPanel = (id: string) => REGISTRY.find((e) => e.id === id)?.group;

function baseInput() {
  return {
    resolvedGroups: GROUPS,
    entriesByGroup,
    isGroupId,
    groupForPanel,
  };
}

describe('resolveDragEnd', () => {
  it('returns noop when overId is null (drop missed any droppable)', () => {
    expect(
      resolveDragEnd({ ...baseInput(), activeId: 'Inputs', overId: null }),
    ).toEqual({ kind: 'noop' });
  });

  it('returns noop when active === over (same id, no movement)', () => {
    expect(
      resolveDragEnd({
        ...baseInput(),
        activeId: 'Inputs',
        overId: 'Inputs',
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('group ↔ group: returns group kind with arrayMove applied', () => {
    expect(
      resolveDragEnd({
        ...baseInput(),
        activeId: 'Trading',
        overId: 'Inputs',
      }),
    ).toEqual({
      kind: 'group',
      nextOrder: ['Trading', 'Inputs', 'Market Context'],
    });
  });

  it('group ↔ group: returns noop when active group is not in resolvedGroups', () => {
    expect(
      resolveDragEnd({
        ...baseInput(),
        activeId: 'UnknownGroup',
        overId: 'Inputs',
        isGroupId: () => true, // force the branch — both classified as groups
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('panel ↔ panel (same group): returns panel kind with new flat order', () => {
    // Move sec-spot-price ABOVE sec-datetime within Inputs.
    const res = resolveDragEnd({
      ...baseInput(),
      activeId: 'sec-spot-price',
      overId: 'sec-datetime',
    });
    expect(res).toEqual({
      kind: 'panel',
      nextOrder: [
        // Inputs (reordered: spot-price → datetime → premarket)
        'sec-spot-price',
        'sec-datetime',
        'sec-premarket',
        // Market Context (unchanged)
        'sec-regime',
        'sec-darkpool',
        // Trading (unchanged)
        'sec-positions',
      ],
    });
  });

  it('panel ↔ panel (cross-group): returns noop (silent reject)', () => {
    expect(
      resolveDragEnd({
        ...baseInput(),
        activeId: 'sec-datetime', // Inputs
        overId: 'sec-regime', // Market Context
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('panel ↔ panel: returns noop when overId is not in the group entries map', () => {
    expect(
      resolveDragEnd({
        ...baseInput(),
        activeId: 'sec-datetime',
        overId: 'sec-deleted', // not in registry
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('mixed (group active, panel over): returns noop', () => {
    expect(
      resolveDragEnd({
        ...baseInput(),
        activeId: 'Inputs',
        overId: 'sec-datetime',
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('mixed (panel active, group over): returns noop', () => {
    expect(
      resolveDragEnd({
        ...baseInput(),
        activeId: 'sec-datetime',
        overId: 'Inputs',
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('panel reorder preserves other groups exactly (no spurious mutation)', () => {
    const res = resolveDragEnd({
      ...baseInput(),
      activeId: 'sec-darkpool',
      overId: 'sec-regime',
    });
    // Inputs and Trading must be unchanged in the flat output.
    expect(res.kind).toBe('panel');
    if (res.kind === 'panel') {
      // Inputs prefix unchanged
      expect(res.nextOrder.slice(0, 3)).toEqual([
        'sec-datetime',
        'sec-spot-price',
        'sec-premarket',
      ]);
      // Trading suffix unchanged
      expect(res.nextOrder.slice(-1)).toEqual(['sec-positions']);
    }
  });

  it('group order is preserved in flat panel output (walks resolvedGroups in order)', () => {
    // Swap group order so Trading comes first
    const res = resolveDragEnd({
      ...baseInput(),
      resolvedGroups: ['Trading', 'Market Context', 'Inputs'],
      activeId: 'sec-spot-price',
      overId: 'sec-datetime',
    });
    expect(res.kind).toBe('panel');
    if (res.kind === 'panel') {
      // Trading appears first in the flat output
      expect(res.nextOrder[0]).toBe('sec-positions');
    }
  });
});
