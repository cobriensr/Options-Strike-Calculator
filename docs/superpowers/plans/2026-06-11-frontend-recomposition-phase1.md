# Frontend Recomposition — Phase 1 Implementation Plan (Card Tiers + Section-Shell Consolidation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give panels visual hierarchy via a `tier` system (primary / standard / quiet), un-nest GexTarget's five child SectionBoxes onto a new `SubPanel` primitive, consolidate the four hand-rolled collapse headers, and make SkeletonSection share the card shell — per Phase 1 of `docs/superpowers/specs/2026-06-11-frontend-recomposition-design.md` (rev 2).

**Architecture:** Panels render their own `SectionBox` internally (44 files — verified), so tier flows from the panel registry through a React context provided per-panel by `PanelRouter`; `SectionBox` resolves `prop ?? context ?? 'standard'`. No panel component's props change. The accent top-border becomes exclusive to `primary`.

**Tech Stack:** React 19, Tailwind 4 tokens (Phase 0 must be landed: `text-sm`=11px, `text-md`=13px semantics are assumed below), Vitest + Testing Library.

**PREREQUISITE:** Phase 0 plan completed and pushed. Verify: `grep -n 'text-display' src/index.css` returns a hit.

**Execution-environment rules:** Same as the Phase 0 plan — never run bare `npm run review` while other sessions have WIP (`prettier --write` only on touched files), surgical `git add`, single-quoted commit messages, push after each commit.

---

### Task 1: `tier` on SectionBox + PanelTierContext + exported shell class

**Files:**
- Create: `src/components/panel-tier-context.ts`
- Modify: `src/components/ui/SectionBox.tsx`
- Test: `src/components/ui/__tests__/SectionBox.tier.test.tsx` (create)

- [ ] **Step 1: Create the context** — `src/components/panel-tier-context.ts`:

```ts
import { createContext } from 'react';

export type PanelTier = 'primary' | 'standard' | 'quiet';

/**
 * Per-panel tier provided by PanelRouter from the panel registry.
 * SectionBox resolves `tier` prop ?? this context ?? 'standard', so
 * panel components don't need a threaded prop, while nested/child
 * SectionBoxes can still override explicitly.
 */
export const PanelTierContext = createContext<PanelTier>('standard');
```

- [ ] **Step 2: Write the failing test** — `src/components/ui/__tests__/SectionBox.tier.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SectionBox } from '../SectionBox';
import { PanelTierContext } from '../../panel-tier-context';

function shell(label: string) {
  return screen.getByRole('region', { name: label });
}

describe('SectionBox tiers', () => {
  it('defaults to standard: uniform border, no accent top', () => {
    render(<SectionBox label="Std">x</SectionBox>);
    const cls = shell('Std').className;
    expect(cls).not.toContain('border-t-accent');
    expect(cls).toContain('border-edge');
  });

  it('primary keeps the accent top border', () => {
    render(
      <SectionBox label="Pri" tier="primary">
        x
      </SectionBox>,
    );
    const cls = shell('Pri').className;
    expect(cls).toContain('border-t-accent');
    expect(cls).toContain('border-t-[3px]');
  });

  it('quiet drops the card chrome', () => {
    render(
      <SectionBox label="Qt" tier="quiet">
        x
      </SectionBox>,
    );
    const cls = shell('Qt').className;
    expect(cls).not.toContain('bg-surface');
    expect(cls).not.toContain('rounded-[14px]');
  });

  it('reads tier from PanelTierContext when no prop is given', () => {
    render(
      <PanelTierContext.Provider value="primary">
        <SectionBox label="Ctx">x</SectionBox>
      </PanelTierContext.Provider>,
    );
    expect(shell('Ctx').className).toContain('border-t-accent');
  });

  it('prop overrides context', () => {
    render(
      <PanelTierContext.Provider value="primary">
        <SectionBox label="Ovr" tier="standard">
          x
        </SectionBox>
      </PanelTierContext.Provider>,
    );
    expect(shell('Ovr').className).not.toContain('border-t-accent');
  });
});
```

- [ ] **Step 3: Run it — expect FAIL** (`npx vitest run src/components/ui/__tests__/SectionBox.tier.test.tsx` — unknown prop `tier`, class assertions fail).

- [ ] **Step 4: Implement in `SectionBox.tsx`.** Add to imports: `import { PanelTierContext, type PanelTier } from '../panel-tier-context';`. Add `tier?: PanelTier;` to the props interface (after `badgeColor`). Inside the component:

```tsx
  const contextTier = useContext(PanelTierContext);
  const resolvedTier: PanelTier = tier ?? contextTier;
```

Export the shell classes (top-level, above SectionTitle) so SkeletonSection can share them (Task 6):

```tsx
/** Card-shell classes per tier. Shared with SkeletonSection so the
 *  loading shell can't drift from the loaded one. */
export const SECTION_SHELL: Record<PanelTier, string> = {
  primary:
    'bg-surface border-edge border-t-accent rounded-[14px] border-[1.5px] border-t-[3px] p-[18px] pb-4 shadow-[var(--shadow-subtle)]',
  standard:
    'bg-surface border-edge rounded-[14px] border-[1.5px] p-[18px] pb-4 shadow-[var(--shadow-subtle)]',
  quiet: 'pb-2',
};
```

Replace the `<section>` className (currently the hardcoded string at the return) with:

```tsx
      className={
        'animate-fade-in-up flex flex-col ' +
        SECTION_SHELL[resolvedTier] +
        (fill ? '' : ' mt-6 first:mt-0') +
        (isOpen ? (fill ? '' : ' h-full') : ' self-start')
      }
```

For the quiet tier's hairline rule, change the header-row div className expression to:

```tsx
        className={
          (isOpen ? 'mb-3.5 ' : '') +
          (resolvedTier === 'quiet' ? 'border-edge border-b pb-2 ' : '') +
          'flex items-center justify-between'
        }
```

(Note: `shadow-[var(--shadow-subtle)]` replaces the previous hardcoded `shadow-[0_1px_4px_rgba(0,0,0,0.03)]` — same value, token-sourced, per the spec.)

- [ ] **Step 5: Run the new test + the full ui tests** (`npx vitest run src/components/ui src/__tests__`). Expected: new test PASS. Pre-existing tests asserting the old class string (if any assert `border-t-accent` on default SectionBox) must be updated to `tier="primary"` expectations — check `src/components/ZeroGammaPanel/__tests__/ZeroGammaPanel.test.tsx` and any SectionBox snapshot.

- [ ] **Step 6: Verify + commit**

```bash
npx tsc --noEmit && npx eslint src --max-warnings=0
npx prettier --write src/components/panel-tier-context.ts src/components/ui/SectionBox.tsx src/components/ui/__tests__/SectionBox.tier.test.tsx
git add src/components/panel-tier-context.ts src/components/ui/SectionBox.tsx src/components/ui/__tests__/SectionBox.tier.test.tsx
git commit -m 'feat(design): Add tier prop + PanelTierContext to SectionBox

primary keeps the accent top border, standard (new default) gets a
uniform border, quiet drops card chrome for a header + hairline rule.
Tier resolves prop ?? context ?? standard so PanelRouter can assign
tiers from the registry without threading props through 44 panels.

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 2: Registry `tier` field + PanelRouter provider

**Files:**
- Modify: `src/constants/panel-registry.ts`, `src/components/PanelRouter.tsx`, `src/App.tsx` (tierById memo + PanelRouter prop)
- Test: `src/constants/__tests__/panel-registry.test.ts`, `src/__tests__/App.panel-render.test.tsx` (extend)

- [ ] **Step 1: Write the failing registry test** — extend `src/constants/__tests__/panel-registry.test.ts`:

```ts
  it('assigns tiers: primary for trading surfaces, quiet for archives', () => {
    const list = getPanelRegistry({
      isAuthenticated: true,
      hasMarketOrSnapshot: true,
    });
    const tierOf = (id: string) => list.find((e) => e.id === id)?.tier;
    expect(tierOf('results')).toBe('primary');
    expect(tierOf('sec-regime')).toBe('primary');
    expect(tierOf('sec-regime-0dte')).toBe('primary');
    expect(tierOf('sec-history')).toBe('quiet');
    expect(tierOf('sec-periscope-lessons')).toBe('quiet');
    expect(tierOf('sec-darkpool')).toBeUndefined(); // standard = absent
  });
```

- [ ] **Step 2: Run — expect FAIL** (no `tier` field).

- [ ] **Step 3: Implement in `panel-registry.ts`.** Extend the interface:

```ts
import type { PanelTier } from '../components/panel-tier-context';

export interface PanelRegistryEntry {
  id: string;
  label: string;
  group: PanelGroup;
  /** Visual tier; absent = 'standard'. Only primary/quiet are declared. */
  tier?: PanelTier;
}
```

Add `tier: 'primary'` to the `sec-regime` (line ~58) and `sec-regime-0dte` (line ~60-63) entries and the `results` push (line ~180); add `tier: 'quiet'` to `sec-history` (line ~136-140) and `sec-periscope-lessons` (line ~162-166).

- [ ] **Step 4: PanelRouter provider.** In `src/components/PanelRouter.tsx`, add to the props interface:

```ts
  /** Panel id → tier; panels absent from the map render as 'standard'. */
  tierById: ReadonlyMap<string, PanelTier>;
```

with `import { PanelTierContext, type PanelTier } from './panel-tier-context';`, and change the emit line (currently `out.push(<Fragment key={id}>{render()}</Fragment>);`) to:

```tsx
      out.push(
        <PanelTierContext.Provider
          key={id}
          value={tierById.get(id) ?? 'standard'}
        >
          {render()}
        </PanelTierContext.Provider>,
      );
```

(`Fragment` import becomes unused — remove it.)

- [ ] **Step 5: App.tsx wiring.** Next to the `panelRegistry` memo (App.tsx ~line 686), add:

```tsx
  const tierById = useMemo(
    () =>
      new Map(
        panelRegistry
          .filter((p) => p.tier)
          .map((p) => [p.id, p.tier as PanelTier]),
      ),
    [panelRegistry],
  );
```

(import `type PanelTier` from `./components/panel-tier-context`) and pass `tierById={tierById}` to `<PanelRouter …>` (~line 1604). This adds ZERO entries to the panelMap dependency array — tier never touches the closures.

- [ ] **Step 6: Extend the App render test** — in `src/__tests__/App.panel-render.test.tsx`, add an assertion that a primary panel's section element carries the accent class and an input panel's does not (follow the file's existing render/query patterns; target `screen.getByRole('region', { name: /market regime/i })` if rendered in that harness, else assert via the registry+PanelRouter unit composition).

- [ ] **Step 7: Verify + commit**

```bash
npx vitest run src/constants src/__tests__/App.panel-render.test.tsx src/components/ui
npx tsc --noEmit && npx eslint src --max-warnings=0
npx prettier --write src/constants/panel-registry.ts src/components/PanelRouter.tsx src/App.tsx src/constants/__tests__/panel-registry.test.ts src/__tests__/App.panel-render.test.tsx
git add <those five files>
git commit -m 'feat(design): Assign panel tiers from the registry via PanelRouter

Registry entries gain an optional tier field; PanelRouter wraps each
panel in PanelTierContext.Provider. Accent top border is now exclusive
to Results, Market Regime, and 0DTE Gamma Regime; Analysis History and
the Periscope Lesson Library go quiet.

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 3: `SubPanel` primitive

**Files:**
- Create: `src/components/ui/SubPanel.tsx`
- Modify: `src/components/ui/index.tsx` (barrel export)
- Test: `src/components/ui/__tests__/SubPanel.test.tsx` (create)

- [ ] **Step 1: Failing test:**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SubPanel } from '../SubPanel';

describe('SubPanel', () => {
  it('renders a labeled tile without card chrome', () => {
    render(<SubPanel label="Target Strike">body</SubPanel>);
    const tile = screen.getByRole('group', { name: 'Target Strike' });
    expect(tile.className).toContain('rounded-lg');
    expect(tile.className).not.toContain('rounded-[14px]'); // not a card
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('renders headerRight content', () => {
    render(
      <SubPanel label="X" headerRight={<button type="button">hr</button>}>
        y
      </SubPanel>,
    );
    expect(screen.getByRole('button', { name: 'hr' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — FAIL (module not found).**

- [ ] **Step 3: Implement** `src/components/ui/SubPanel.tsx`:

```tsx
import { memo, type ReactNode } from 'react';

/**
 * SubPanel — a titled tile INSIDE a SectionBox panel. Replaces nested
 * SectionBoxes (which inflate the visual hierarchy — see the SectionBox
 * doc comment). Tile chrome: soft alt surface, small rounded corner,
 * 11px caps title. No collapse, no accent, no shadow.
 */
export const SubPanel = memo(function SubPanel({
  label,
  headerRight,
  className,
  children,
}: {
  label: string;
  headerRight?: ReactNode;
  /** Extra classes on the tile root (e.g. mt-3, h-full). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={
        'border-edge bg-surface-alt/40 flex min-h-0 flex-col rounded-lg border p-3' +
        (className ? ` ${className}` : '')
      }
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-tertiary font-sans text-sm font-bold tracking-[0.1em] uppercase">
          {label}
        </h3>
        {headerRight}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
});
```

Add to `src/components/ui/index.tsx` barrel: `export { SubPanel } from './SubPanel';`.

- [ ] **Step 4: Run test — PASS; commit**

```bash
npx vitest run src/components/ui
npx prettier --write src/components/ui/SubPanel.tsx src/components/ui/index.tsx src/components/ui/__tests__/SubPanel.test.tsx
git add src/components/ui/SubPanel.tsx src/components/ui/index.tsx src/components/ui/__tests__/SubPanel.test.tsx
git commit -m 'feat(ui): Add SubPanel primitive for titled tiles inside panels

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 4: Un-nest GexTarget's five child SectionBoxes

**Files:**
- Modify: `src/components/GexTarget/TargetTile.tsx`, `UrgencyPanel.tsx`, `SparklinePanel.tsx`, `PriceChart.tsx`, `StrikeBox/index.tsx`, `index.tsx`

- [ ] **Step 1:** In each of the five children, replace the root `<SectionBox label="…">…</SectionBox>` with `<SubPanel label="…" className="h-full">…</SubPanel>` (import `SubPanel` from `'../ui'` — adjust relative depth for `StrikeBox/index.tsx` to `'../../ui'`). Where a child passed `headerRight` to SectionBox (check `PriceChart.tsx` — it has the interval toggle), pass the same node to SubPanel's `headerRight`. Remove the now-unused `SectionBox` imports.

- [ ] **Step 2:** In `GexTarget/index.tsx` (~line 355), the left column wrapper `className="flex flex-col [&>section]:mt-0"` → `className="flex flex-col gap-3"` (SubPanels are divs with no mt; gap supplies rhythm). The outer `<SectionBox label="GEX TARGET" …>` at the bottom of the file stays — it is the panel root and now the ONLY SectionBox in the folder.

- [ ] **Step 3: Run GexTarget tests + visual build**

```bash
npx vitest run src/components/GexTarget
npx tsc --noEmit && npx eslint src --max-warnings=0 && npm run build
```

Expected: PASS. If tests query `getByRole('region', { name: 'TARGET STRIKE' })`, update to `'group'` role.

- [ ] **Step 4: Commit**

```bash
npx prettier --write src/components/GexTarget
git add src/components/GexTarget
git commit -m 'ref(design): Un-nest GexTarget child panels onto SubPanel

Five nested SectionBoxes (TargetTile, UrgencyPanel, SparklinePanel,
PriceChart, StrikeBox) become SubPanel tiles; drops the
[&>section]:mt-0 patch. One panel, one card, five tiles.

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 5: `CollapseHeader` primitive + adopt in the four clones

**Files:**
- Create: `src/components/ui/CollapseHeader.tsx` (+ barrel export)
- Modify: `src/components/ResultsSection.tsx:59-86`, `src/components/IronCondorSection/index.tsx:54-81`, `src/components/BWBSection/index.tsx:57-84`, `src/components/FuturesCalculator/CalcHeader.tsx`
- Test: `src/components/ui/__tests__/CollapseHeader.test.tsx` (create)

- [ ] **Step 1: Failing test:**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CollapseHeader } from '../CollapseHeader';

describe('CollapseHeader', () => {
  it('is a real button with aria-expanded and toggles on click', async () => {
    const onToggle = vi.fn();
    render(
      <CollapseHeader
        label="Iron Condor (20-pt wings)"
        collapsed={false}
        onToggle={onToggle}
      />,
    );
    const btn = screen.getByRole('button', {
      name: 'Toggle Iron Condor (20-pt wings)',
    });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('rotates the chevron when collapsed', () => {
    render(<CollapseHeader label="X" collapsed onToggle={() => {}} />);
    expect(
      screen.getByRole('button', { name: 'Toggle X' }),
    ).toHaveAttribute('aria-expanded', 'false');
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `src/components/ui/CollapseHeader.tsx`:

```tsx
import { memo, type ReactNode } from 'react';

/**
 * CollapseHeader — the shared chevron + caps-title collapse toggle used
 * by in-panel sub-sections (Results' strike table, Iron Condor, BWB,
 * Futures calc). A real <button> (the four prior hand-rolls used
 * role="button" divs). Visual parity with SectionBox's header.
 */
export const CollapseHeader = memo(function CollapseHeader({
  label,
  collapsed,
  onToggle,
  accent = true,
  className,
  headerRight,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Accent-colored title (the sub-section convention). */
  accent?: boolean;
  className?: string;
  /** Non-toggling content on the right (e.g. Clear button, chips). */
  headerRight?: ReactNode;
}) {
  return (
    <div
      className={
        (collapsed ? '' : 'mb-2.5 ') +
        'flex items-center justify-between gap-2' +
        (className ? ` ${className}` : '')
      }
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={`Toggle ${label}`}
        aria-expanded={!collapsed}
        className={
          'flex flex-1 cursor-pointer items-center gap-2.5 text-left font-sans text-sm font-bold tracking-[0.12em] uppercase select-none ' +
          (accent ? 'text-accent' : 'text-tertiary')
        }
      >
        <span
          className="text-muted text-sm transition-transform duration-200"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          aria-hidden="true"
        >
          &#x25BE;
        </span>
        <span>{label}</span>
      </button>
      {headerRight}
    </div>
  );
});
```

Barrel-export it from `src/components/ui/index.tsx`.

- [ ] **Step 4: Adopt at the four sites.** Each replacement removes the hand-rolled `role="button"` div + chevron span + onKeyDown handler:
  - `ResultsSection.tsx:59-86` → `<CollapseHeader label="All Delta Strikes" collapsed={collapsed} onToggle={toggle} />` (its CollapseAllContext effect at lines 44-50 stays untouched).
  - `IronCondorSection/index.tsx:54-81` → `<CollapseHeader label={`Iron Condor (${wingWidth}-pt wings)`} collapsed={collapsed} onToggle={toggleCollapse} />`.
  - `BWBSection/index.tsx:57-84` → same pattern with its broken-wing label.
  - `FuturesCalculator/CalcHeader.tsx` → keep the component (it owns the Clear button + symbol chips row); replace its title row (the `role="button"` div wrapper + chevron + h2, lines ~33-67) with `<CollapseHeader label="Futures P&L Calculator" accent={false} collapsed={collapsed} onToggle={onToggleCollapse} headerRight={<ClearButton…/>} />` where the Clear button keeps its `e.stopPropagation()`-free onClick (it's outside the toggle button now — drop the stopPropagation). The symbol-chips row stays below, outside CollapseHeader; remove the outer div's onClick/role/tabIndex/onKeyDown so chips no longer toggle the panel.

- [ ] **Step 5: Run the affected tests**

```bash
npx vitest run src/components/ui src/__tests__ src/components/FuturesCalculator src/components/IronCondorSection src/components/BWBSection
npx tsc --noEmit && npx eslint src --max-warnings=0
```

Update any test selecting the old `role="button"` divs by aria-label — names are unchanged (`Toggle …`), only the role semantics improved, so `getByRole('button', { name: 'Toggle …' })` keeps working.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/components/ui/CollapseHeader.tsx src/components/ui/index.tsx src/components/ui/__tests__/CollapseHeader.test.tsx src/components/ResultsSection.tsx src/components/IronCondorSection/index.tsx src/components/BWBSection/index.tsx src/components/FuturesCalculator/CalcHeader.tsx
git add <those files>
git commit -m 'ref(design): Consolidate four hand-rolled collapse headers

ResultsSection, IronCondorSection, BWBSection, and CalcHeader adopt a
shared CollapseHeader primitive — a real button (the clones used
role=button divs), one chevron implementation, consistent typography.

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 6: SkeletonSection shares the shell

**Files:**
- Modify: `src/components/SkeletonSection.tsx`

- [ ] **Step 1:** Replace the hardcoded card classes (line ~28: `"border-edge border-t-edge-strong bg-surface mt-6 rounded-[14px] border-[1.5px] border-t-[3px] p-[18px] pb-4 first:mt-0"`) with the shared constant:

```tsx
import { SECTION_SHELL } from './ui/SectionBox';
…
    <div
      aria-busy="true"
      className={`${SECTION_SHELL.standard} mt-6 first:mt-0`}
    >
```

(Loading shells are tier-agnostic: standard. The `border-t-[3px] border-t-edge-strong` heavier top disappears with the tier system — intended.)

- [ ] **Step 2: Verify + commit**

```bash
npx vitest run src/__tests__ && npx tsc --noEmit && npx eslint src --max-warnings=0
npx prettier --write src/components/SkeletonSection.tsx
git add src/components/SkeletonSection.tsx
git commit -m 'ref(design): SkeletonSection renders from the shared section shell

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 7: Phase-end verification + review

- [ ] **Step 1:** `git status` — if other sessions' WIP exists, run scoped checks (`npx tsc --noEmit && npx eslint src --max-warnings=0 && npx vitest run src && npm run build`); else full `npm run review`.
- [ ] **Step 2:** Dispatch the `code-reviewer` agent over the Phase 1 commit range; apply `continue` feedback.
- [ ] **Step 3:** Screenshot pass in both themes: confirm only Results / Market Regime / 0DTE Gamma Regime carry the accent top border; GexTarget renders one card with five tiles; Analysis History is quiet.
