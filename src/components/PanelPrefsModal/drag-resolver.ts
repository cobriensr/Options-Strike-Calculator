/**
 * Pure resolver for the two-level panel-prefs drag UX. Extracted from
 * the modal so the branch matrix (group reorder / panel reorder /
 * cross-group reject / mixed reject / same-id noop / unknown-id noop)
 * is unit-testable without dragging through a real @dnd-kit harness.
 *
 * The modal's `handleDragEnd` thins down to: build the input shape,
 * call `resolveDragEnd`, then dispatch to `setGroupOrder` / `setOrder`
 * based on the returned discriminant.
 *
 * Spec: docs/superpowers/specs/panel-reordering-2026-05-17.md
 */

import type { PanelRegistryEntry } from '../../constants/panel-registry.js';

export type DragResolution =
  | { kind: 'noop' }
  | { kind: 'group'; nextOrder: string[] }
  | { kind: 'panel'; nextOrder: string[] };

export interface DragInput {
  /** dnd-kit `active.id` (string-coerced). */
  activeId: string;
  /** dnd-kit `over.id` (string-coerced), or null when the drop missed. */
  overId: string | null;
  /**
   * Resolved-group sequence (user-customized prefix + registry
   * fallback). Typed as `string[]` rather than `PanelGroup[]` because
   * the helper operates on opaque ids — the brand only matters at
   * dispatch (where `setGroupOrder` accepts string[] anyway).
   */
  resolvedGroups: string[];
  /** Per-group ordered entries (already filtered to current context). */
  entriesByGroup: Map<string, PanelRegistryEntry[]>;
  /** Membership check — true when the id is one of the registry groups. */
  isGroupId: (id: string) => boolean;
  /** Reverse lookup — which group does this panel id belong to? */
  groupForPanel: (id: string) => string | undefined;
}

/**
 * Resolve a drag-end event into one of three intents:
 *   - `group` — reorder the outer group list (user dragged a group header)
 *   - `panel` — reorder panels within a single group (user dragged a row)
 *   - `noop` — drop landed on the same id, missed, was mixed (group↔panel),
 *     crossed groups, or referenced an unknown id
 *
 * Cross-group rejection is silent by design — the spec keeps panels
 * pinned to their conceptual group bucket. Mixed group↔panel drops
 * are also silent (UI shouldn't permit them in the first place, but
 * the guard prevents bad PUTs if a future dnd-kit upgrade allows them).
 */
export function resolveDragEnd(input: DragInput): DragResolution {
  const {
    activeId,
    overId,
    resolvedGroups,
    entriesByGroup,
    isGroupId,
    groupForPanel,
  } = input;

  if (!overId || activeId === overId) return { kind: 'noop' };

  const activeIsGroup = isGroupId(activeId);
  const overIsGroup = isGroupId(overId);

  if (activeIsGroup && overIsGroup) {
    const oldIndex = resolvedGroups.indexOf(activeId);
    const newIndex = resolvedGroups.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return { kind: 'noop' };
    return {
      kind: 'group',
      nextOrder: arrayMove(resolvedGroups, oldIndex, newIndex),
    };
  }

  if (!activeIsGroup && !overIsGroup) {
    // Cross-group drop is rejected silently — panels stay in their
    // conceptual bucket.
    const activeGroup = groupForPanel(activeId);
    const overGroup = groupForPanel(overId);
    if (!activeGroup || activeGroup !== overGroup) return { kind: 'noop' };

    const entries = entriesByGroup.get(activeGroup) ?? [];
    const ids = entries.map((e) => e.id);
    const oldIndex = ids.indexOf(activeId);
    const newIndex = ids.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return { kind: 'noop' };
    const newIdsInGroup = arrayMove(ids, oldIndex, newIndex);

    // Build the new flat panel_order by walking resolved groups and
    // substituting the active group's reordered ids. This preserves
    // every other group's existing order in the flat list.
    const nextOrder: string[] = [];
    for (const g of resolvedGroups) {
      if (g === activeGroup) {
        nextOrder.push(...newIdsInGroup);
      } else {
        const groupEntries = entriesByGroup.get(g) ?? [];
        nextOrder.push(...groupEntries.map((e) => e.id));
      }
    }
    return { kind: 'panel', nextOrder };
  }

  // Mixed group↔panel drop — no-op by design.
  return { kind: 'noop' };
}

/**
 * Local arrayMove — pulled inline to keep this module free of
 * @dnd-kit imports so the test file can import it without pulling the
 * drag library into the jsdom unit-test environment.
 */
function arrayMove<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = [...arr];
  const [item] = out.splice(from, 1);
  if (item !== undefined) out.splice(to, 0, item);
  return out;
}
