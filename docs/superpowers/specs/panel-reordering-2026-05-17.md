# Panel Reordering (Per-User Drag-to-Sort, Two-Level)

**Date:** 2026-05-17
**Status:** Spec — pending review

## Goal

Let owner and each guest customize the on-screen layout of home-page
panels at **two levels** from the existing Show / Hide Panels modal:

1. **Group order** — drag entire groups (`INPUTS`, `MARKET CONTEXT`, …)
   to reorder whole sections of the page.
2. **Panel order** — drag panels within their group to reorder rows
   inside that section.

Both orderings persist server-side per identity (owner or
`sha256(guest_key)`) and follow the user across devices. Panels cannot
jump groups — that preserves the conceptual buckets the registry defines.

## Current State (verified)

- **Registry:** `src/constants/panel-registry.ts` — flat array of
  `{ id, label, group }` across 6 groups, with `PANEL_GROUP_ORDER`
  controlling group sequence today.
- **Storage:** `panel_prefs` table — `identity TEXT PK`,
  `hidden_panels JSONB`, `updated_at`. Endpoint `GET/PUT
/api/panel-prefs`. Rate-limited 20/caller.
- **Hook:** `usePanelPrefs()` → `{ hidden, isHidden, toggle, reset,
isLoaded }` with optimistic 500ms-debounced PUT.
- **Modal:** `src/components/PanelPrefsModal/PanelPrefsModal.tsx` —
  grouped checkboxes, "Reset (show all)" + "Done".
- **Render:** `src/App.tsx` lines 781–1322 — **30+ hardcoded
  conditional JSX blocks**, not a loop. This is the primary refactor
  surface.

## Design Decisions

### 1. Two-level drag, no cross-group jumps

- **Group drag:** outer `SortableContext` sorts group ids. The user
  grabs a group header and moves the whole group up/down.
- **Panel drag:** inner `SortableContext` (one per group) sorts panel
  ids within that group. Cross-group drops are rejected in
  `onDragEnd`.

This matches the modal's existing visual hierarchy and the page's
existing group buckets — nothing about the conceptual model changes,
only the sequence inside and between groups.

### 2. Storage: two new JSONB columns, sparse encoding

Migration adds two columns to `panel_prefs`:

```sql
ALTER TABLE panel_prefs
  ADD COLUMN panel_order JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN group_order JSONB NOT NULL DEFAULT '[]'::jsonb;
```

- `panel_order`: flat array of panel ids in user order.
- `group_order`: array of group ids in user order (e.g.
  `["Market Context", "Inputs", "Trading", ...]`).

**Sparse semantics (same rule for both):** stored array is the
customized prefix. Any id NOT in the stored array falls back to its
position in the registry / `PANEL_GROUP_ORDER`, appended after the
customized ids. New groups or panels added to the registry auto-appear
in registry order — no reset required.

**Resolvers** (pure, unit-tested):

```ts
resolveGroupOrder(stored: string[], registryGroups: string[]): string[]
resolvePanelOrder(
  stored: string[],
  registry: PanelRegistryEntry[],
  group: string,
): string[]
```

`resolvePanelOrder` is called per group so the resolved panel list
never mixes groups, even if the stored array drifts.

### 3. Drag mechanism: `@dnd-kit/core` + `@dnd-kit/sortable`

**Why not native HTML5 DnD:** weak touch + zero screen-reader
support. The repo's e2e suite gates on axe-core; native DnD would
fail the a11y audit. `@dnd-kit` ships with keyboard sensors (Space to
grab, arrows to move, Space to drop) and live-region announcements.

**Bundle cost:** ~20kb gzipped. Acceptable for a settings-only
feature that isn't on the critical render path (modal is
lazy-mounted).

**Nesting:** dnd-kit supports nested `SortableContext` cleanly. The
outer context's id space (group names) is disjoint from the inner
contexts' id spaces (panel ids), so the sensor only fires on the
context whose item was grabbed.

### 4. Render refactor: extract panels into a renderer map, loop twice

`App.tsx` keeps panel JSX local, but each inline block becomes a
**local memoized renderer** keyed by panel id:

```ts
const panelRenderers: Record<string, () => ReactNode> = {
  'sec-datetime': () => <section id="sec-datetime">...</section>,
  'sec-spot-price': () => <section id="sec-spot-price">...</section>,
  // ... 30 total
};

// Two-level loop replaces the 30 inline conditionals:
{resolvedGroupOrder.map(group => (
  <Fragment key={group}>
    <GroupHeader name={group} />
    {resolvePanelOrder(order, registry, group).map(id => {
      if (panelPrefs.isHidden(id)) return null;
      return <Fragment key={id}>{panelRenderers[id]?.()}</Fragment>;
    })}
  </Fragment>
))}
```

**Why not extract panels into separate files:** each renderer closes
over ~10 hooks from `App.tsx` (`useAppState`, `useMarketData`,
`useChainData`, etc.). Lifting them out would require a giant prop
bag or context, which is a bigger refactor than this feature warrants.

### 5. Reset model: three buttons in the modal footer

- **Reset visibility** — clears `hidden_panels` (existing behavior).
- **Reset panel order** — clears `panel_order` only.
- **Reset group order** — clears `group_order` only.

The user can independently restore any of the three axes (visibility,
panel order within groups, group order). Each button is disabled
when its corresponding state is already empty.

### 6. Drag is modal-only

The home page itself is **read-only** with respect to layout —
panels do not have grip handles or drop zones on the home page. All
reordering happens inside the Show / Hide Panels modal, then the
home page re-renders in the new resolved order. This keeps the
trading view free of accidental drag targets during fast-moving
market hours.

## Phases

### Phase 1 — Backend (1 migration, 1 endpoint update)

- Add migration #110 (or next available) in `db-migrations.ts`:
  `ALTER TABLE panel_prefs ADD COLUMN panel_order JSONB NOT NULL
DEFAULT '[]'::jsonb, ADD COLUMN group_order JSONB NOT NULL DEFAULT
'[]'::jsonb;` (one migration row, atomic).
- Update `api/panel-prefs.ts`:
  - GET returns `{ hiddenPanels, panelOrder, groupOrder }`.
  - PUT accepts optional `panelOrder?: string[]` and
    `groupOrder?: string[]` (Zod-validated, regex `sec-[a-z0-9-]+`
    for panels; group names validated against `PANEL_GROUP_ORDER`
    enum; max 50 entries each; no duplicates).
- Update `api/__tests__/db.test.ts` — add migration to expected list,
  bump SQL call count.
- Update `api/_lib/validation/panel-prefs.ts` Zod schema.

**Files:** 3 modified.

### Phase 2 — Frontend hook + resolvers

- Add `src/utils/panel-order.ts` with two pure helpers:
  - `resolveGroupOrder(stored, registryGroups)`
  - `resolvePanelOrder(stored, registry, group)`
- Unit tests covering: empty stored, sparse stored, removed
  ids in stored, unknown ids in stored, ids added to registry after
  stored, cross-group ids accidentally in `panel_order` (filtered
  out by `group` arg).
- Extend `usePanelPrefs()`:
  - Returns `order: string[]`, `groupOrder: string[]` (raw stored
    arrays).
  - Returns `resolvedGroupOrder: string[]` and
    `getResolvedPanelIds(group: string): string[]` (memoized).
  - Adds `setOrder(ids)`, `setGroupOrder(groups)`,
    `resetPanelOrder()` (clears `panel_order` only),
    `resetGroupOrder()` (clears `group_order` only).

**Files:** 1 created, 1 modified, 1 test created.

### Phase 3 — App.tsx render refactor (highest risk)

- Extract each panel's JSX into a renderer map inside `App.tsx`.
- Replace the 30+ inline conditionals (lines 781–1322) with a
  two-level loop over `resolvedGroupOrder` and per-group resolved
  panel ids, filtered by `isHidden`.
- Group header rendering happens once per group, before its panels.
- Visual snapshot test in `src/__tests__/App.panel-render.test.tsx`
  asserting the **default-order** render (no stored prefs) matches
  pre-refactor output: same panel ids in the same sequence, same
  group headers in the same positions.

**Files:** 1 modified (App.tsx, large), 1 test created.

### Phase 4 — Modal drag UI (two-level)

- `npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`
- Update `PanelPrefsModal.tsx`:
  - Outer `<DndContext>` + `<SortableContext>` over group ids
    (`verticalListSortingStrategy`). Each group header becomes a
    `useSortable` item with a grip-icon button (`aria-label="Drag
to reorder group {group}"`).
  - Inside each group: an inner `<SortableContext>` over panel ids
    in that group. Each panel row gets a grip-icon drag handle in
    addition to its existing checkbox (`aria-label="Drag to
reorder {panel.label}"`).
  - `onDragEnd`:
    - If the dragged item is a group id → call `setGroupOrder()`.
    - If the dragged item is a panel id → call `setOrder()`. Reject
      drops where source group ≠ target group (guards stale
      pointer-cancel races).
  - Drag handles always visible (touch users have no hover state).
- Footer: replace single "Reset (show all)" with three buttons —
  **Reset visibility**, **Reset panel order**, **Reset group
  order**. Each disabled when its corresponding state is already
  empty. Stack vertically on narrow viewports; row on wide.

**Files:** 1 modified (modal), 1 modified (package.json).

### Phase 5 — E2E + a11y verification

- New Playwright spec `e2e/panel-reorder.spec.ts`:
  - **Group reorder** with mouse: drag MARKET CONTEXT above INPUTS,
    close modal, assert group sequence on home page changed.
  - **Panel reorder** with mouse: drag a panel up within its group,
    close modal, assert new order on home page.
  - **Keyboard equivalents** for both (Tab to handle, Space,
    ArrowUp, Space).
  - **Reset panel order** restores per-group registry order without
    touching group order.
  - **Reset group order** restores `PANEL_GROUP_ORDER` without
    touching panel order.
  - **Cross-group drop** is rejected (drag panel from INPUTS down
    into MARKET CONTEXT and back; verify panel stayed in INPUTS).
  - axe-core scan on modal with drag handles visible.
- Update existing e2e specs that hardcode panel order if any.

**Files:** 1 created, 0–2 modified.

## Data Dependencies

- New migration #110 in `db-migrations.ts` (adds two columns in one
  atomic statement).
- New npm deps: `@dnd-kit/core`, `@dnd-kit/sortable`,
  `@dnd-kit/utilities`.

## Open Questions

_All previously open questions resolved 2026-05-17:_

- **Reset model** → **split into three buttons** (visibility / panel
  order / group order). Reflected in Design Decision 5 and Phase 4.
- **Drag scope** → **modal-only**; the home page is read-only with
  respect to layout. Reflected in Design Decision 6.
- **Drag handle visibility** → **always visible** (touch users have
  no hover state).

## Thresholds / Constants

- Max ids in `panel_order` array: **50**.
- Max ids in `group_order` array: **20** (well above the 6 current
  groups).
- Debounce on `setOrder` / `setGroupOrder` PUT: **500ms** (matches
  existing `toggle`).
- Drag activation distance: **5px** (dnd-kit default — avoids
  accidental drags during scroll).

## Verification (Phase 5 acceptance)

- [ ] `npm run review` clean (tsc + eslint + prettier + vitest).
- [ ] New unit tests pass: `resolvePanelOrder` and
      `resolveGroupOrder` each cover their full case matrix.
- [ ] New e2e passes: mouse + keyboard reorder at both levels both
      persist across page reload.
- [ ] axe-core clean on modal with active drag handles.
- [ ] Default-order snapshot test passes on App.tsx refactor.
- [ ] Manual: owner reorders groups + panels; switch to guest key in
      incognito; guest sees registry order (not owner's order) since
      identities are keyed separately.
- [ ] Manual: owner customizes both axes, hits **Reset panel order**
      — group order persists, panel order returns to registry
      defaults. Then **Reset group order** — group order returns to
      `PANEL_GROUP_ORDER`.

## Notes

- Plain text cookie / single-owner auth is unchanged.
- `botid` protect list — `/api/panel-prefs` is already covered; no
  new endpoint, so no `src/main.tsx` change needed.
- The render refactor (Phase 3) is the most code-touching phase but
  also the most mechanical. Snapshot test guards against regression.
- Cross-group panel moves remain disallowed by design; the modal's
  group buckets are the source of truth for which panels belong
  where. If we ever want cross-group, it's a separate spec.
