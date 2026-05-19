/**
 * PanelPrefsModal — gear-icon modal for choosing which home-page
 * sections render and in what order.
 *
 * Three axes of preference are exposed via separate UI controls:
 *
 *   1. Visibility — per-row checkbox + footer "Reset visibility"
 *   2. Panel order — per-row drag handle (within a group) + footer
 *      "Reset panel order"
 *   3. Group order — per-group-header drag handle + footer "Reset
 *      group order"
 *
 * Panels cannot cross groups — `onDragEnd` rejects cross-group drops
 * silently. Group order honors the same registry-as-fallback rule as
 * panel order: stored prefix first, then unknown groups appended.
 *
 * Drag is `@dnd-kit/sortable` for keyboard parity (Space to grab,
 * arrows to move, Space to drop, live-region announcements). Native
 * HTML5 DnD has weak touch + zero screen-reader support and would
 * fail the e2e axe-core gate.
 *
 * Reads the panel registry filtered by the caller's `(isAuthenticated,
 * hasMarketOrSnapshot)` context so a guest never sees a checkbox for
 * the Futures Calculator they couldn't reach anyway. The `results`
 * panel is included like every other registered entry — users can
 * hide the strike-calculator output if they're using the page for
 * non-calculator workflows (e.g. monitoring only). Prior versions
 * excluded it; reverted by user request.
 *
 * Specs:
 *   - docs/superpowers/specs/panel-prefs-2026-05-17.md (visibility)
 *   - docs/superpowers/specs/panel-reordering-2026-05-17.md (orders)
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  getPanelRegistry,
  PANEL_GROUP_ORDER,
  type PanelGroup,
  type PanelRegistryEntry,
} from '../../constants/panel-registry';
import { resolveGroupOrder, resolvePanelOrder } from '../../utils/panel-order';
import type { PanelPrefs } from '../../hooks/usePanelPrefs';
import { resolveDragEnd } from './drag-resolver';

const GRIP_LABEL_PREFIX_GROUP = 'Drag to reorder group';
const GRIP_LABEL_PREFIX_PANEL = 'Drag to reorder';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  panelPrefs: PanelPrefs;
  isAuthenticated: boolean;
  hasMarketOrSnapshot: boolean;
}

/**
 * One row inside a group's panel list — the existing
 * checkbox/label/id-chip layout plus a drag handle.
 */
function SortablePanelRow({
  entry,
  visible,
  onToggle,
}: {
  entry: PanelRegistryEntry;
  visible: boolean;
  onToggle: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <li ref={setNodeRef} style={style}>
      <div className="border-edge hover:bg-surface-alt flex items-center gap-2 rounded-md border px-2 py-2 text-sm transition-colors">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`${GRIP_LABEL_PREFIX_PANEL} ${entry.label}`}
          className="text-tertiary hover:text-secondary flex h-6 w-6 shrink-0 cursor-grab items-center justify-center rounded active:cursor-grabbing"
        >
          {/* unicode grip icon — six dots in 2 cols */}
          <span aria-hidden="true">⠿</span>
        </button>
        <label className="flex flex-1 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={visible}
            onChange={onToggle}
            className="accent-accent h-4 w-4 cursor-pointer"
            aria-label={`${visible ? 'Hide' : 'Show'} ${entry.label}`}
          />
          <span className="text-primary flex-1">{entry.label}</span>
          <span className="text-tertiary font-mono text-[10px]">
            {entry.id}
          </span>
        </label>
      </div>
    </li>
  );
}

/**
 * A whole group block — the header (draggable) and the panel list
 * (its own SortableContext for within-group reordering).
 */
function SortableGroupSection({
  group,
  entries,
  isHidden,
  onToggle,
}: {
  group: string;
  entries: PanelRegistryEntry[];
  isHidden: (id: string) => boolean;
  onToggle: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const panelIds = entries.map((e) => e.id);

  return (
    <section ref={setNodeRef} style={style} className="mb-4 last:mb-0">
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`${GRIP_LABEL_PREFIX_GROUP} ${group}`}
          className="text-tertiary hover:text-secondary flex h-5 w-5 shrink-0 cursor-grab items-center justify-center rounded active:cursor-grabbing"
        >
          <span aria-hidden="true">⠿</span>
        </button>
        <h3 className="text-tertiary font-sans text-[11px] font-semibold tracking-wider uppercase">
          {group}
        </h3>
      </div>
      <SortableContext items={panelIds} strategy={verticalListSortingStrategy}>
        <ul className="space-y-1">
          {entries.map((entry) => (
            <SortablePanelRow
              key={entry.id}
              entry={entry}
              visible={!isHidden(entry.id)}
              onToggle={() => onToggle(entry.id)}
            />
          ))}
        </ul>
      </SortableContext>
    </section>
  );
}

export function PanelPrefsModal({
  isOpen,
  onClose,
  panelPrefs,
  isAuthenticated,
  hasMarketOrSnapshot,
}: Props) {
  const doneButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    // Stash whatever owned focus when the modal opened (the gear button,
    // typically) so we can restore focus on close per WCAG 2.4.3.
    triggerRef.current = document.activeElement as HTMLElement | null;
    doneButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      triggerRef.current?.focus();
    };
  }, [isOpen, onClose]);

  const sensors = useSensors(
    // 5px activation distance avoids accidental drag on a row click.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Build the registry view filtered by context + grouped + ordered.
  const registry = useMemo(
    () => getPanelRegistry({ isAuthenticated, hasMarketOrSnapshot }),
    [isAuthenticated, hasMarketOrSnapshot],
  );

  const registryGroups: PanelGroup[] = useMemo(
    () => [...PANEL_GROUP_ORDER],
    [],
  );

  const resolvedGroups = useMemo(
    () => resolveGroupOrder(panelPrefs.groupOrder, registryGroups),
    [panelPrefs.groupOrder, registryGroups],
  );

  // Per-group ordered entries (entries, not just ids) — pre-computed
  // once so onDragEnd and the render loop both read from the same map.
  const entriesByGroup = useMemo(() => {
    const byId = new Map(registry.map((e) => [e.id, e]));
    const out = new Map<string, PanelRegistryEntry[]>();
    for (const group of resolvedGroups) {
      const ids = resolvePanelOrder(panelPrefs.order, registry, group);
      out.set(
        group,
        ids
          .map((id) => byId.get(id))
          .filter((e): e is PanelRegistryEntry => !!e),
      );
    }
    return out;
  }, [resolvedGroups, panelPrefs.order, registry]);

  // Which group does a given panel id belong to (within the
  // currently-shown registry)? Used to reject cross-group drops.
  const groupForPanel = useCallback(
    (id: string): string | undefined =>
      registry.find((e) => e.id === id)?.group,
    [registry],
  );

  const isGroupId = useCallback(
    (id: string): boolean => registryGroups.includes(id as PanelGroup),
    [registryGroups],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const res = resolveDragEnd({
        activeId: String(active.id),
        overId: over == null ? null : String(over.id),
        resolvedGroups,
        entriesByGroup,
        isGroupId,
        groupForPanel,
      });
      if (res.kind === 'group') panelPrefs.setGroupOrder(res.nextOrder);
      else if (res.kind === 'panel') panelPrefs.setOrder(res.nextOrder);
      // 'noop' falls through silently — see drag-resolver.ts for cases.
    },
    [isGroupId, groupForPanel, resolvedGroups, entriesByGroup, panelPrefs],
  );

  const handleResetVisibility = useCallback(
    () => panelPrefs.reset(),
    [panelPrefs],
  );
  const handleResetPanelOrder = useCallback(
    () => panelPrefs.resetPanelOrder(),
    [panelPrefs],
  );
  const handleResetGroupOrder = useCallback(
    () => panelPrefs.resetGroupOrder(),
    [panelPrefs],
  );

  if (!isOpen) return null;

  const totalHidden = registry.filter((e) => panelPrefs.isHidden(e.id)).length;
  const totalVisible = registry.length - totalHidden;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="panel-prefs-title"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4 py-6"
      onClick={onClose}
    >
      <div
        className="bg-surface border-edge-strong flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2
              id="panel-prefs-title"
              className="text-primary font-serif text-lg font-bold"
            >
              Show / Hide / Reorder Panels
            </h2>
            <p className="text-secondary mt-1 text-sm">
              Pick which sections appear and drag the grip handles to reorder.
              Your selection is saved server-side and follows you across
              devices.
            </p>
          </div>
          <span className="text-tertiary shrink-0 font-mono text-xs whitespace-nowrap">
            {totalVisible}/{registry.length} visible
          </span>
        </div>

        <div className="-mr-2 flex-1 overflow-y-auto pr-2">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={resolvedGroups}
              strategy={verticalListSortingStrategy}
            >
              {resolvedGroups.map((group) => {
                const entries = entriesByGroup.get(group) ?? [];
                if (entries.length === 0) return null;
                return (
                  <SortableGroupSection
                    key={group}
                    group={group}
                    entries={entries}
                    isHidden={panelPrefs.isHidden}
                    onToggle={panelPrefs.toggle}
                  />
                );
              })}
            </SortableContext>
          </DndContext>
        </div>

        <div className="border-edge mt-4 flex flex-col gap-2 border-t pt-4 sm:flex-row">
          <button
            type="button"
            onClick={handleResetVisibility}
            disabled={totalHidden === 0}
            className="border-edge-strong text-primary hover:bg-surface-alt flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset visibility
          </button>
          <button
            type="button"
            onClick={handleResetPanelOrder}
            disabled={panelPrefs.order.length === 0}
            className="border-edge-strong text-primary hover:bg-surface-alt flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset panel order
          </button>
          <button
            type="button"
            onClick={handleResetGroupOrder}
            disabled={panelPrefs.groupOrder.length === 0}
            className="border-edge-strong text-primary hover:bg-surface-alt flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset group order
          </button>
          <button
            ref={doneButtonRef}
            type="button"
            onClick={onClose}
            className="bg-accent flex-1 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
