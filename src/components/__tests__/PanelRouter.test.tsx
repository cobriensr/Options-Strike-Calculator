import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { PanelRouter } from '../PanelRouter';
import type { PanelGroup } from '../../constants/panel-registry';

/**
 * Phase 2O of the frontend cleanup spec. PanelRouter owns the two-level
 * iteration extracted from App.tsx — it does NOT own the panel content.
 * These tests exercise the iterator contract with stub render closures,
 * mirroring the way App.tsx will use it in production.
 */

function mkPanelMap(
  ids: readonly string[],
): Map<string, () => ReactNode> {
  const map = new Map<string, () => ReactNode>();
  for (const id of ids) {
    map.set(id, () => <div data-testid={`panel-${id}`}>{id}</div>);
  }
  return map;
}

describe('PanelRouter', () => {
  it('renders panels in the order dictated by resolvedGroups + resolvedPanelsByGroup', () => {
    const resolvedGroups: PanelGroup[] = ['Inputs', 'Market Context'];
    const resolvedPanelsByGroup = new Map<string, readonly string[]>([
      ['Inputs', ['sec-a', 'sec-b']],
      ['Market Context', ['sec-c']],
    ]);
    const panelMap = mkPanelMap(['sec-a', 'sec-b', 'sec-c']);

    const { container } = render(
      <PanelRouter
        panelMap={panelMap}
        resolvedGroups={resolvedGroups}
        resolvedPanelsByGroup={resolvedPanelsByGroup}
        isHidden={() => false}
      />,
    );

    const rendered = Array.from(
      container.querySelectorAll('[data-testid^="panel-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(rendered).toEqual(['panel-sec-a', 'panel-sec-b', 'panel-sec-c']);
  });

  it('reverses panel output when groups are reordered', () => {
    const resolvedPanelsByGroup = new Map<string, readonly string[]>([
      ['Inputs', ['sec-a']],
      ['Market Context', ['sec-b']],
    ]);
    const panelMap = mkPanelMap(['sec-a', 'sec-b']);

    const { container } = render(
      <PanelRouter
        panelMap={panelMap}
        resolvedGroups={['Market Context', 'Inputs']}
        resolvedPanelsByGroup={resolvedPanelsByGroup}
        isHidden={() => false}
      />,
    );

    const rendered = Array.from(
      container.querySelectorAll('[data-testid^="panel-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(rendered).toEqual(['panel-sec-b', 'panel-sec-a']);
  });

  it('skips ids where isHidden returns true', () => {
    const resolvedGroups: PanelGroup[] = ['Inputs'];
    const resolvedPanelsByGroup = new Map<string, readonly string[]>([
      ['Inputs', ['sec-a', 'sec-b', 'sec-c']],
    ]);
    const panelMap = mkPanelMap(['sec-a', 'sec-b', 'sec-c']);

    render(
      <PanelRouter
        panelMap={panelMap}
        resolvedGroups={resolvedGroups}
        resolvedPanelsByGroup={resolvedPanelsByGroup}
        isHidden={(id) => id === 'sec-b'}
      />,
    );

    expect(screen.getByTestId('panel-sec-a')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-sec-b')).not.toBeInTheDocument();
    expect(screen.getByTestId('panel-sec-c')).toBeInTheDocument();
  });

  it('skips ids not present in panelMap without crashing', () => {
    const resolvedGroups: PanelGroup[] = ['Inputs'];
    const resolvedPanelsByGroup = new Map<string, readonly string[]>([
      ['Inputs', ['sec-a', 'sec-stale', 'sec-c']],
    ]);
    // Note: sec-stale is in the group order but missing from panelMap
    // (e.g. registry was updated since the prefs were saved).
    const panelMap = mkPanelMap(['sec-a', 'sec-c']);

    render(
      <PanelRouter
        panelMap={panelMap}
        resolvedGroups={resolvedGroups}
        resolvedPanelsByGroup={resolvedPanelsByGroup}
        isHidden={() => false}
      />,
    );

    expect(screen.getByTestId('panel-sec-a')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-sec-stale')).not.toBeInTheDocument();
    expect(screen.getByTestId('panel-sec-c')).toBeInTheDocument();
  });

  it('renders nothing when resolvedGroups is empty', () => {
    const panelMap = mkPanelMap(['sec-a', 'sec-b']);

    const { container } = render(
      <PanelRouter
        panelMap={panelMap}
        resolvedGroups={[]}
        resolvedPanelsByGroup={
          new Map<string, readonly string[]>([['Inputs', ['sec-a']]])
        }
        isHidden={() => false}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('falls back to empty list when a resolvedGroup has no panels entry', () => {
    const resolvedGroups: PanelGroup[] = ['Inputs', 'Trading'];
    const resolvedPanelsByGroup = new Map<string, readonly string[]>([
      ['Inputs', ['sec-a']],
      // 'Trading' intentionally absent — should be coalesced to [].
    ]);
    const panelMap = mkPanelMap(['sec-a', 'sec-b']);

    const { container } = render(
      <PanelRouter
        panelMap={panelMap}
        resolvedGroups={resolvedGroups}
        resolvedPanelsByGroup={resolvedPanelsByGroup}
        isHidden={() => false}
      />,
    );

    const rendered = Array.from(
      container.querySelectorAll('[data-testid^="panel-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(rendered).toEqual(['panel-sec-a']);
  });

  it('preserves stable order across re-render with the same inputs', () => {
    const resolvedGroups: PanelGroup[] = ['Inputs'];
    const resolvedPanelsByGroup = new Map<string, readonly string[]>([
      ['Inputs', ['sec-a', 'sec-b', 'sec-c']],
    ]);
    const panelMap = mkPanelMap(['sec-a', 'sec-b', 'sec-c']);

    const { container, rerender } = render(
      <PanelRouter
        panelMap={panelMap}
        resolvedGroups={resolvedGroups}
        resolvedPanelsByGroup={resolvedPanelsByGroup}
        isHidden={() => false}
      />,
    );
    const firstA = container.querySelector('[data-testid="panel-sec-a"]');
    const firstB = container.querySelector('[data-testid="panel-sec-b"]');
    const firstC = container.querySelector('[data-testid="panel-sec-c"]');

    rerender(
      <PanelRouter
        panelMap={panelMap}
        resolvedGroups={resolvedGroups}
        resolvedPanelsByGroup={resolvedPanelsByGroup}
        isHidden={() => false}
      />,
    );
    const secondA = container.querySelector('[data-testid="panel-sec-a"]');
    const secondB = container.querySelector('[data-testid="panel-sec-b"]');
    const secondC = container.querySelector('[data-testid="panel-sec-c"]');

    // Fragment keys are the panel IDs — same key + same parent slot ⇒
    // React preserves the underlying DOM node across renders.
    expect(secondA).toBe(firstA);
    expect(secondB).toBe(firstB);
    expect(secondC).toBe(firstC);
  });
});
