# One CLOSED Badge for the GEXBot Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the close, the three GEXBot panels show the same CLOSED badge, in one style, in each panel's header.

**Architecture:** Today each panel labels the closed state its own way:
- GEXBot Taker Flow: plain muted text in its `SectionBox` header.
- GEX Landscape: a tinted pill inline in `ScrubControls`.
- Periscope: a "Slot Fri 3:00 PM CT · CLOSED" body header.

One new presentational component, `ClosedBadge` in `src/components/ui/`, takes the landscape's pill as the single style. All three panels render it in their header area. The Periscope body header goes back to its in-session form.

**Tech Stack:** React 19, Tailwind CSS 4, the `theme` tokens, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-20-gexbot-after-close-design.md` (label rules under "Panels (client)", plus its "As built" section).

## Decision behind this plan (owner, 2026-11-27)

The final review of the after-close build noted that the CLOSED label looks different in each panel. The owner chose to unify it: one shared component, in the landscape pill's style.

## Global Constraints

- **Text.** `CLOSED · as of <label>`, where `<label>` is `formatClosedLabel(asOf, new Date())` from `src/utils/closed-session.ts`: "Fri 3:00 PM CT", or "Fri Nov 20 3:00 PM CT" more than 6 days on.
- **Never dangling.** The badge renders nothing when `asOf` is null or the label is `''` (an unparseable time). A bare "CLOSED · as of " never shows.
- **Style.** Exactly today's landscape pill, `src/components/ScrubControls.tsx:201-211`:
  - classes `rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold whitespace-nowrap`;
  - `style={{ background: tint(theme.textMuted, '17'), color: theme.textMuted }}`.
  - That is the header CLOSED badge's 9% tint (`StatusBadge`). It measures 5.06:1 in the light theme and 4.53:1 in the dark.
- **Accessibility.** Its text is its accessible name, as the LIVE badge's is. It is not `aria-hidden` and has no `aria-label`, because a role-less span with an ARIA name breaks the repo's `genericElementsWithAriaLabel` rule.
- **When it shows.** Only when closed on the live route. In session it never shows (spec anti-goal 1), and a picked Periscope slot or a scrubbed landscape never shows it.
- **No test-only props.** The component takes no `now` prop; tests pin the clock with `vi.setSystemTime` (CLAUDE.md R3). A `testId` prop is fine: it keeps each panel's existing `data-testid`.
- **Size.** At most 5 files per task. Each task is reviewed and committed, and the two land together.

## Review Focus

1. **A phone-width Periscope header** holding the badge and the SlotPicker. It must wrap, not overflow; `SectionBox`'s header row is `flex flex-wrap justify-end`. Owner: Task 2. Test: the badge sits inside the `SectionBox` header, beside the slot picker.
2. **An unparseable capture time** on any panel renders no badge and leaves the rest of the header unchanged. Owners: Tasks 1 and 2.
3. **The three badges matching.** The same `className` and `style` in all three panels: one test renders each closed and compares them. Owner: Task 2.
4. **A picked Periscope slot after the close** shows no badge. Owner: Task 2.
5. **The open flip.** The badge disappears on the render where `marketOpen` turns true. Owners: the existing panel tests; Task 2 keeps them passing.

---

### Task 1: `ClosedBadge`, and the landscape uses it

**Files:**
- Create: `src/components/ui/ClosedBadge.tsx`
- Create: `src/__tests__/components/ui/ClosedBadge.test.tsx`
- Modify: `src/components/ui/index.tsx` (export it)
- Modify: `src/components/ScrubControls.tsx` (replace the inline pill at ~201-211)

**Interfaces:**
- Produces: `export function ClosedBadge({ asOf, testId }: { asOf?: string | null; testId: string })`, exported from `src/components/ui/index.tsx`.
  - Leave the return type to inference. A bare `JSX.Element` doesn't resolve under `@types/react` 19, so if one is needed, use `React.JSX.Element | null`.
  - `asOf` is optional, so `ScrubControls`' `closedAsOf?: string | null` passes straight through.
- `ScrubControls` keeps its `closedAsOf` prop and its `showClosed` rule (non-null, not scrubbed, non-empty label), which still decides that LIVE and DELAYED hide. It renders `<ClosedBadge asOf={closedAsOf} testId="scrub-closed-badge" />` in place of its inline span.

- [ ] **Step 1: Write the failing tests** in `ClosedBadge.test.tsx`, with `vi.setSystemTime(new Date('2026-11-21T15:00:00Z'))`:

```tsx
it('renders the pill with the capture label', () => {
  render(<ClosedBadge asOf="2026-11-20T21:00:49.000Z" testId="b" />);
  expect(screen.getByTestId('b').textContent).toBe('CLOSED · as of Fri 3:00 PM CT');
});
it('adds the date past 6 days', () => {
  vi.setSystemTime(new Date('2026-11-26T21:00:50Z'));
  render(<ClosedBadge asOf="2026-11-20T21:00:49.000Z" testId="b" />);
  expect(screen.getByTestId('b').textContent).toBe('CLOSED · as of Fri Nov 20 3:00 PM CT');
});
it.each([null, '', 'not a time'])('renders nothing for %s', (asOf) => {
  const { container } = render(<ClosedBadge asOf={asOf} testId="b" />);
  expect(container.firstChild).toBeNull();
});
it('carries the shared style and is not hidden from assistive tech', () => {
  render(<ClosedBadge asOf="2026-11-20T21:00:49.000Z" testId="b" />);
  const el = screen.getByTestId('b');
  expect(el).toHaveClass('rounded', 'px-1.5', 'py-0.5', 'font-mono', 'text-[10px]', 'font-semibold', 'whitespace-nowrap');
  expect(el).not.toHaveAttribute('aria-hidden');
  expect(el).not.toHaveAttribute('aria-label');
  expect(el.style.color).not.toBe('');
  expect(el.style.background).not.toBe('');
});
```

- [ ] **Step 2:** Run `npx vitest run src/__tests__/components/ui/ClosedBadge.test.tsx`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `ClosedBadge`, export it, and swap it into `ScrubControls`. Move the contrast comment from `ScrubControls` onto the component.
- [ ] **Step 4:** Run the new file plus `src/__tests__/components/GexLandscape-HeaderControls.test.tsx` and `src/__tests__/components/GexLandscape.test.tsx`. Expected: PASS. The landscape tests stay as they are: same test ID, same text, same style.
- [ ] **Step 5:** Run the gate, then commit: `refactor(gexbot): Share one CLOSED badge component, starting with the landscape`.

---

### Task 2: The Taker Flow and Periscope headers use the badge

**Files:**
- Modify: `src/components/Gexbot/index.tsx` (replace `ClosedLabel`, ~43-52 and ~64-70)
- Modify: `src/components/Periscope/PeriscopePanel.tsx` (body header ~196-215, `SectionBox` `headerRight`)
- Test: `src/__tests__/GexbotSection.test.tsx`, `src/__tests__/PeriscopePanel.test.tsx`

**Interfaces:**
- Consumes `ClosedBadge` from Task 1.
- **GexbotSection.** `headerRight` is `<ClosedBadge asOf={asOf} testId="gexbot-closed-label" />` when `!marketOpen`, else `undefined`. Delete the local `ClosedLabel`. The badge returns null on an empty label, so no separate `closedLabel === ''` check is needed.
  - Another session's level-ladder work also edits this file, so keep the edit to those lines.
- **PeriscopePanel:**
  - The body header always reads `Slot {formatTimeCT(view.capturedAt)} CT · {view.expiry}`, its in-session form. The closed variant `Slot {label} · CLOSED` is removed.
  - **When:** `isLive && !marketOpen && view != null && error == null`, `headerRight` renders `<ClosedBadge asOf={view.capturedAt} testId="periscope-closed-badge" />` before the existing `<SlotPicker …/>`.
  - **Why the error check:** the hook can hold a picked slot's view while the live route errors. For example: pick 14:50 on Saturday, click live, get a 500. The badge must not label that picked time as the close above an error body.
  - **Spacing:** wrap both in `<div className="flex flex-wrap items-center justify-end gap-2">`. `SectionBox`'s header row has `gap-y-2` only, so without the wrapper the badge butts against the date input.
  - **Comment:** update the file header comment (~lines 18-21) to the new header.
  - A picked slot (`!isLive`) never renders the badge.
  - **Header-row selector for tests:** `SectionBox` renders an anonymous div. Reach it as the parent of the section's toggle button, `screen.getByRole('button', { name: /^Toggle / }).parentElement`, and don't add attributes to `SectionBox`.

- [ ] **Step 1: Write the failing tests.**

```tsx
// PeriscopePanel.test.tsx (closed Saturday, Friday's live view)
it('shows the shared badge in the header and the normal slot header', () => {
  expect(screen.getByTestId('periscope-closed-badge').textContent).toBe('CLOSED · as of Fri 3:00 PM CT');
  expect(screen.getByText(/Slot 3:00 PM CT · 2026-11-20/)).toBeInTheDocument();
  expect(screen.queryByText(/· CLOSED/)).toBeNull();
});
it('puts the badge beside the slot picker in a spaced, wrapping row inside the section header', () => {
  const badge = screen.getByTestId('periscope-closed-badge');
  const headerRow = screen.getByRole('button', { name: /^Toggle / }).parentElement!;
  expect(headerRow).toContainElement(badge);
  expect(badge.parentElement).toHaveClass('flex', 'flex-wrap', 'items-center', 'justify-end', 'gap-2');
  expect(badge.parentElement).toContainElement(screen.getByRole('combobox', { name: 'Periscope slot time' }));
});
it('a picked slot after the close shows no badge', () => { /* selectedSlot set → queryByTestId null */ });
it('no badge over an error body', () => { /* live route, closed, view held (a picked slot's), error 'HTTP 500' → queryByTestId('periscope-closed-badge') null */ });
it('an unparseable capture time shows no badge and the normal header', () => { /* capturedAt: 'not a time' */ });

// GexbotSection.test.tsx: the existing label tests keep passing (same test ID and text), plus:
it('the three closed badges share one className and style', () => {
  // Render GexbotSection (closed, snapshots asOf), ScrubControls (closedAsOf) and
  // PeriscopePanel (closed live view); compare className and style.cssText of the three badges.
});
```

  For the cross-panel test, build a minimal `PeriscopeView` fixture in `GexbotSection.test.tsx`. `makeView` in `PeriscopePanel.test.tsx` isn't exported; copy the fields the panel reads rather than exporting a test helper.
- [ ] **Step 2:** Run `npx vitest run src/__tests__/PeriscopePanel.test.tsx src/__tests__/GexbotSection.test.tsx`. Expected: the new cases FAIL. The old closed-header cases (`Slot Fri 3:00 PM CT · CLOSED`) must be updated to the new expectations, not kept.
- [ ] **Step 3:** Implement both panel changes.
- [ ] **Step 4:** Run both files and `src/__tests__/SlotPicker.test.tsx`. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `refactor(gexbot): Use the shared CLOSED badge in the Taker Flow and Periscope headers`.

## Landing (controller)

- [ ] A whole-branch review, then a rebase onto `origin/main` (the level-ladder session is active in `src/components/Gexbot/`), the gate, and one push. These are client-only changes, with no Railway or nightly paths.
- [ ] Update the spec with Edit, so it doesn't contradict itself:
  - the "As built" Periscope header bullet (`Slot Fri 3:00 PM CT · CLOSED`);
  - the "Left as is" bullet on the label style;
  - the Panels line `Slot 3:00 PM CT · CLOSED` style header.

  Each should say: one shared `ClosedBadge`, in each panel's header.

## Review round (CLAUDE.md, Plan First)

- **Round 1 settled:**
  - the Periscope header wrapper and its spacing, plus a real header-row selector;
  - no badge over an error body;
  - the `ClosedBadge` signature (optional `asOf`, inferred return type);
  - the spec lines to correct at landing;
  - the Goal reworded to "in each panel's header".
- **Owner's call, settled 2026-11-27 ("yes"):** the badge sits in a different place in each header:
  - Landscape: in the controls' status slot, before refresh.
  - Taker Flow: alone at the right.
  - Periscope: to the left of the slot controls.

## As built (2026-11-27)

- **Commits:**
  - Task 1: `af3fe2928`.
  - Task 2: `b45234e35`.
  - Final-review fix wave: `c98b90d8b` and `c95284e05`.
- **Where the Periscope badge gets its time (fix wave).** It is dated from the hook's `asOf`, not `view.capturedAt`. The hook returns `asOf` only for a response read on the live route, so a held picked slot never dates it.
  - Its condition is `isLive && !marketOpen && asOf != null && error == null`.
  - So a closed live response with no SPX spot now shows the badge above "Waiting for SPX spot…".
- **One label rule (fix wave).** `closedLabelOrNull` in `src/utils/closed-session.ts` decides whether a label exists. `ClosedBadge` and `ScrubControls`' LIVE/DELAYED hiding both use it.
