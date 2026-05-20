import { Fragment, memo, type ReactNode } from 'react';
import type { PanelGroup } from '../constants/panel-registry';

/**
 * Two-level panel iterator extracted from App.tsx (Phase 2O of the
 * frontend cleanup spec). The renderer closures still live in App.tsx
 * because each one captures ~15 local hooks; only the iteration /
 * hidden-skip / group-header logic moved out.
 *
 * Contract: for each group in `resolvedGroups`, look up its panel ids
 * in `resolvedPanelsByGroup`, skip any id where `isHidden(id)` returns
 * true or the `panelMap` has no renderer, and emit the renderer's
 * ReactNode wrapped in a `<Fragment key={id}>`. Iteration order
 * matches the existing App.tsx contract exactly.
 *
 * Memoized so we only re-iterate when one of the four inputs changes.
 * The caller is responsible for `useMemo`-stabilizing `panelMap` and
 * `isHidden` so the memo barrier actually holds.
 */
export interface PanelRouterProps {
  panelMap: ReadonlyMap<string, () => ReactNode>;
  resolvedGroups: readonly PanelGroup[];
  resolvedPanelsByGroup: ReadonlyMap<string, readonly string[]>;
  isHidden: (id: string) => boolean;
}

function PanelRouterImpl({
  panelMap,
  resolvedGroups,
  resolvedPanelsByGroup,
  isHidden,
}: PanelRouterProps): ReactNode {
  const out: ReactNode[] = [];
  for (const group of resolvedGroups) {
    const ids = resolvedPanelsByGroup.get(group) ?? [];
    for (const id of ids) {
      if (isHidden(id)) continue;
      const render = panelMap.get(id);
      if (!render) continue;
      out.push(<Fragment key={id}>{render()}</Fragment>);
    }
  }
  return out;
}

export const PanelRouter = memo(PanelRouterImpl);
