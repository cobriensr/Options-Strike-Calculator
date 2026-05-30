# Options Alerts View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-screen "Options Alerts" view — a fixed 50/50 vertical split with Lottery Finder on top and Silent Boom on the bottom, each pane scrolling independently — reached via a hash-based header toggle, and remove both feeds from the main calculator scroll.

**Architecture:** No router. A `useViewMode` hook reads/writes `window.location.hash` (`#alerts`) to pick between two top-level views. `App.tsx` conditionally renders the existing calculator body **or** a new `OptionsAlertsView`. The view is a bounded `h-dvh` flex column; each pane is `flex-1 min-h-0 overflow-y-auto` so the browser splits the height 50/50 and each pane owns its scroll. The two feeds relocate their lazy imports out of `App.tsx` into `OptionsAlertsView` and are removed from the panel registry.

**Tech Stack:** React 19, TypeScript (strict), Tailwind CSS 4, Vitest + @testing-library/react, Vite lazy chunks.

**Spec:** `docs/superpowers/specs/2026-05-30-options-alerts-view-design.md`

---

## File Structure

**Phase 1 — Navigation + relocation**

- Create `src/utils/handle-stale-chunk.ts` — shared lazy-import rejection handler (extracted from `App.tsx`). Test: `src/__tests__/handle-stale-chunk.test.ts`.
- Create `src/hooks/useViewMode.ts` — hash-backed view-mode state. Test: `src/__tests__/useViewMode.test.ts`.
- Create `src/components/ViewToggle.tsx` — the Calculator|Options Alerts segmented control. Test: `src/__tests__/ViewToggle.test.tsx`.
- Create `src/components/OptionsAlerts/index.tsx` — the split-pane alerts view (`OptionsAlertsView`). Test: `src/__tests__/OptionsAlertsView.test.tsx`.
- Modify `src/components/AppHeader/index.tsx` — accept `view` + `onViewChange`, render `<ViewToggle>`. Test: `src/__tests__/AppHeader.test.tsx` (factory update).
- Modify `src/App.tsx` — import the util/hook/view, conditional render, remove feed lazy consts + panelMap closures.
- Modify `src/constants/panel-registry.ts` — drop `sec-lottery-finder` + `sec-silent-boom`. Test: `src/constants/__tests__/panel-registry.test.ts`.

**Phase 2 — Compact chrome**

- Create `src/components/ui/CompactDisclosure.tsx` — sticky collapsible header wrapper. Test: `src/__tests__/CompactDisclosure.test.tsx`.
- Modify `src/components/LotteryFinder/index.tsx` + `src/components/SilentBoom/index.tsx` — add `compact?: boolean`; wrap toolbar in `CompactDisclosure` when compact.
- Modify `src/components/OptionsAlerts/index.tsx` — pass `compact`.

**Phase 3 — Polish (optional)**

- Create `e2e/options-alerts.spec.ts` — view-switch + independent-scroll + axe pass.
- Modify `src/components/AppHeader/index.tsx` — hide calculator-only controls (Collapse) in alerts mode.

---

## PHASE 1 — Navigation skeleton + relocation

### Task 1: Extract `handleStaleChunk` into a shared util

`App.tsx` defines `handleStaleChunk` locally (lines 91–101) and uses it in 8 lazy imports. `OptionsAlertsView` (Task 5) needs the same handler for its relocated feed imports. Extract it once.

**Files:**
- Create: `src/utils/handle-stale-chunk.ts`
- Create: `src/__tests__/handle-stale-chunk.test.ts`
- Modify: `src/App.tsx:88-101` (remove local fn), `src/App.tsx:1-10` (add import)

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/handle-stale-chunk.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleStaleChunk } from '../utils/handle-stale-chunk';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleStaleChunk', () => {
  it('rethrows a non-chunk error without prompting', () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const err = new Error('some unrelated error');
    expect(() => handleStaleChunk(err)).toThrow('some unrelated error');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('prompts and reloads on a chunk-load TypeError when confirmed', () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const reloadSpy = vi.fn();
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({
      ...globalThis.location,
      reload: reloadSpy,
    } as unknown as Location);
    const err = new TypeError('Failed to fetch dynamically imported module: /x.js');
    expect(() => handleStaleChunk(err)).toThrow();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the user declines the prompt', () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    const reloadSpy = vi.fn();
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({
      ...globalThis.location,
      reload: reloadSpy,
    } as unknown as Location);
    const err = new TypeError('error during fetch for module');
    expect(() => handleStaleChunk(err)).toThrow();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/handle-stale-chunk.test.ts`
Expected: FAIL — `Cannot find module '../utils/handle-stale-chunk'`.

- [ ] **Step 3: Create the util (verbatim from the current App.tsx definition)**

```typescript
// src/utils/handle-stale-chunk.ts
/**
 * Rejection handler for lazy `import()` calls. After a deploy, a stale
 * service-worker-cached chunk throws on import; prompt the user to reload
 * instead of silently failing inside Suspense. Matches the pattern in the
 * BWBSection / IronCondorSection export buttons.
 */
export function handleStaleChunk(err: unknown): never {
  const isChunkError =
    err instanceof TypeError &&
    /dynamically imported module|fetch/i.test(err.message);
  if (isChunkError) {
    if (confirm('A new version is available. Reload now?')) {
      globalThis.location.reload();
    }
  }
  throw err;
}
```

- [ ] **Step 4: Rewire App.tsx to import the util**

In `src/App.tsx`, delete the local function (the block at lines 88–101, the comment + `function handleStaleChunk(...) { ... }`). Add this import near the other util imports (e.g. after line 12 `import { buildChevronUrl } from './utils/ui-utils';`):

```typescript
import { handleStaleChunk } from './utils/handle-stale-chunk';
```

The 8 existing `.catch(handleStaleChunk)` call sites are unchanged — only the definition source moved.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/__tests__/handle-stale-chunk.test.ts && npx tsc --noEmit`
Expected: test PASS; tsc clean (no "handleStaleChunk is not defined" in App.tsx).

- [ ] **Step 6: Commit**

```bash
git add src/utils/handle-stale-chunk.ts src/__tests__/handle-stale-chunk.test.ts src/App.tsx
git commit -m "refactor(app): extract handleStaleChunk into shared util"
```

---

### Task 2: `useViewMode` hook

**Files:**
- Create: `src/hooks/useViewMode.ts`
- Create: `src/__tests__/useViewMode.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/useViewMode.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useViewMode } from '../hooks/useViewMode';

beforeEach(() => {
  // Reset to a clean URL with no hash before each case.
  history.replaceState(null, '', '/');
});

describe('useViewMode', () => {
  it('defaults to calculator when there is no hash', () => {
    const { result } = renderHook(() => useViewMode());
    expect(result.current.view).toBe('calculator');
  });

  it('reads alerts when the initial hash is #alerts', () => {
    history.replaceState(null, '', '/#alerts');
    const { result } = renderHook(() => useViewMode());
    expect(result.current.view).toBe('alerts');
  });

  it('setView("alerts") sets the hash and updates the view', () => {
    const { result } = renderHook(() => useViewMode());
    act(() => result.current.setView('alerts'));
    expect(window.location.hash).toBe('#alerts');
    expect(result.current.view).toBe('alerts');
  });

  it('setView("calculator") clears the hash and updates the view', () => {
    history.replaceState(null, '', '/#alerts');
    const { result } = renderHook(() => useViewMode());
    act(() => result.current.setView('calculator'));
    expect(window.location.hash).toBe('');
    expect(result.current.view).toBe('calculator');
  });

  it('responds to external hashchange events (back/forward)', () => {
    const { result } = renderHook(() => useViewMode());
    expect(result.current.view).toBe('calculator');
    act(() => {
      history.replaceState(null, '', '/#alerts');
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(result.current.view).toBe('alerts');
  });

  it('removes its hashchange listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useViewMode());
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('hashchange', expect.any(Function));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/useViewMode.test.ts`
Expected: FAIL — `Cannot find module '../hooks/useViewMode'`.

- [ ] **Step 3: Implement the hook**

```typescript
// src/hooks/useViewMode.ts
import { useCallback, useEffect, useState } from 'react';

export type ViewMode = 'calculator' | 'alerts';

const ALERTS_HASH = '#alerts';

function readViewFromHash(): ViewMode {
  return globalThis.location?.hash === ALERTS_HASH ? 'alerts' : 'calculator';
}

/**
 * Top-level view switch backed by `window.location.hash`.
 *
 *   - `#alerts`            → 'alerts'
 *   - empty / anything else → 'calculator' (default)
 *
 * Subscribes to `hashchange` so browser back/forward and bookmarked
 * `#alerts` deep-links stay in sync. `setView` is the imperative path
 * (header toggle); it writes the hash AND sets state so the update is
 * deterministic even though clearing the hash via replaceState does not
 * emit a `hashchange`.
 */
export function useViewMode(): {
  view: ViewMode;
  setView: (view: ViewMode) => void;
} {
  const [view, setViewState] = useState<ViewMode>(readViewFromHash);

  useEffect(() => {
    const onHashChange = () => setViewState(readViewFromHash());
    globalThis.addEventListener('hashchange', onHashChange);
    return () => globalThis.removeEventListener('hashchange', onHashChange);
  }, []);

  const setView = useCallback((next: ViewMode) => {
    if (next === 'alerts') {
      // Setting a new hash emits `hashchange`; the effect would also catch
      // it, but we set state directly for an immediate, deterministic update.
      globalThis.location.hash = 'alerts';
    } else {
      // Clear the hash without leaving a bare "#" or scroll-jumping.
      globalThis.history.replaceState(
        null,
        '',
        globalThis.location.pathname + globalThis.location.search,
      );
    }
    setViewState(next);
  }, []);

  return { view, setView };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/useViewMode.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useViewMode.ts src/__tests__/useViewMode.test.ts
git commit -m "feat(nav): add useViewMode hash-backed view switch"
```

---

### Task 3: `ViewToggle` component

A small, self-contained segmented control. Isolating it keeps `AppHeader` untouched in structure and makes the toggle trivially testable.

**Files:**
- Create: `src/components/ViewToggle.tsx`
- Create: `src/__tests__/ViewToggle.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/__tests__/ViewToggle.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewToggle } from '../components/ViewToggle';

describe('ViewToggle', () => {
  it('renders both view tabs', () => {
    render(<ViewToggle view="calculator" onViewChange={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /calculator/i })).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /options alerts/i }),
    ).toBeInTheDocument();
  });

  it('marks the active view with aria-selected', () => {
    render(<ViewToggle view="alerts" onViewChange={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /options alerts/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /calculator/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('calls onViewChange with the clicked view', () => {
    const onViewChange = vi.fn();
    render(<ViewToggle view="calculator" onViewChange={onViewChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /options alerts/i }));
    expect(onViewChange).toHaveBeenCalledWith('alerts');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ViewToggle.test.tsx`
Expected: FAIL — `Cannot find module '../components/ViewToggle'`.

- [ ] **Step 3: Implement the component**

```tsx
// src/components/ViewToggle.tsx
import type { ViewMode } from '../hooks/useViewMode';

interface ViewToggleProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
}

const TABS: Array<{ value: ViewMode; label: string }> = [
  { value: 'calculator', label: 'Calculator' },
  { value: 'alerts', label: 'Options Alerts' },
];

/**
 * Always-visible header segmented control switching between the calculator
 * workspace and the dedicated Options Alerts view. Wired to `useViewMode`
 * by the parent (AppHeader → App).
 */
export function ViewToggle({ view, onViewChange }: ViewToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="Application view"
      className="border-edge-strong bg-surface flex items-center rounded-lg border-[1.5px] p-0.5"
    >
      {TABS.map((tab) => {
        const active = view === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onViewChange(tab.value)}
            className={`min-h-[36px] rounded-md px-2.5 font-sans text-[11px] font-semibold transition-colors duration-200 ${
              active
                ? 'bg-accent text-white'
                : 'text-secondary hover:text-primary'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ViewToggle.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/ViewToggle.tsx src/__tests__/ViewToggle.test.tsx
git commit -m "feat(nav): add ViewToggle segmented control"
```

---

### Task 4: Wire `ViewToggle` into `AppHeader`

**Files:**
- Modify: `src/components/AppHeader/index.tsx` (props interface + render)
- Modify: `src/__tests__/AppHeader.test.tsx` (factory + one assertion)

- [ ] **Step 1: Update the AppHeader test factory to fail compile/run first**

In `src/__tests__/AppHeader.test.tsx`, add the import at the top (after line 5):

```tsx
import type { ViewMode } from '../hooks/useViewMode';
```

Add the two new props to the `renderHeader` factory `props` object (inside the object literal around lines 67–86, e.g. right after `accessMode: 'owner',`):

```tsx
    view: 'calculator' as ViewMode,
    onViewChange: vi.fn(),
```

Add a new test inside the `describe('AppHeader', ...)` block:

```tsx
  it('renders the view toggle and switches view on click', () => {
    const onViewChange = vi.fn();
    renderHeader({ onViewChange });
    const alertsTab = screen.getByRole('tab', { name: /options alerts/i });
    expect(alertsTab).toBeInTheDocument();
    fireEvent.click(alertsTab);
    expect(onViewChange).toHaveBeenCalledWith('alerts');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/AppHeader.test.tsx`
Expected: FAIL — `view`/`onViewChange` are not on `AppHeaderProps` (type error) and/or no tab found.

- [ ] **Step 3: Add the props to AppHeader and render ViewToggle**

In `src/components/AppHeader/index.tsx`:

Add the import (after line 34 `import SchwabAuthLink from './SchwabAuthLink';`):

```tsx
import { ViewToggle } from '../ViewToggle';
import type { ViewMode } from '../../hooks/useViewMode';
```

Add to the `AppHeaderProps` interface (after `onOpenPanelPrefs: () => void;`, before the closing brace ~line 77):

```tsx
  /** Active top-level view (calculator vs alerts). */
  view: ViewMode;
  /** Switches the top-level view. */
  onViewChange: (view: ViewMode) => void;
```

Add `view,` and `onViewChange,` to the destructured params (in the `export default function AppHeader({ ... })` list, e.g. after `onOpenPanelPrefs,`).

Render the toggle as the first child of the right-side control cluster. Change line 117 from:

```tsx
        <div className="flex items-center gap-1.5 sm:gap-2">
```

to:

```tsx
        <div className="flex items-center gap-1.5 sm:gap-2">
          <ViewToggle view={view} onViewChange={onViewChange} />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/AppHeader.test.tsx`
Expected: PASS (all prior tests + the new toggle test).

- [ ] **Step 5: Commit**

```bash
git add src/components/AppHeader/index.tsx src/__tests__/AppHeader.test.tsx
git commit -m "feat(nav): render ViewToggle in AppHeader"
```

---

### Task 5: `OptionsAlertsView` split-pane component

Renders the two feeds in a fixed 50/50 vertical split, each pane independently scrollable, with a gated empty state. Owns the relocated lazy feed imports. (Phase 1 renders the feeds in their current, non-compact form — the `compact` prop arrives in Phase 2.)

**Files:**
- Create: `src/components/OptionsAlerts/index.tsx`
- Create: `src/__tests__/OptionsAlertsView.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/__tests__/OptionsAlertsView.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OptionsAlertsView } from '../components/OptionsAlerts';

// Stub the heavy lazy feeds so the split-pane structure is what's under test.
vi.mock('../components/LotteryFinder', () => ({
  LotteryFinderSection: () => <div data-testid="lottery">lottery</div>,
}));
vi.mock('../components/SilentBoom', () => ({
  SilentBoomSection: () => <div data-testid="silent-boom">silent boom</div>,
}));

describe('OptionsAlertsView', () => {
  it('shows a gated message when there is no market context', () => {
    render(<OptionsAlertsView marketOpen={false} hasMarketContext={false} />);
    expect(screen.getByText(/need live market context/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: /lottery finder alerts/i }),
    ).not.toBeInTheDocument();
  });

  it('renders both feed panes when market context is present', async () => {
    render(<OptionsAlertsView marketOpen hasMarketContext />);
    expect(
      screen.getByRole('region', { name: /lottery finder alerts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /silent boom alerts/i }),
    ).toBeInTheDocument();
    expect(await screen.findByTestId('lottery')).toBeInTheDocument();
    expect(await screen.findByTestId('silent-boom')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/OptionsAlertsView.test.tsx`
Expected: FAIL — `Cannot find module '../components/OptionsAlerts'`.

- [ ] **Step 3: Implement the component**

```tsx
// src/components/OptionsAlerts/index.tsx
import { lazy, Suspense } from 'react';
import SkeletonSection from '../SkeletonSection';
import { handleStaleChunk } from '../../utils/handle-stale-chunk';

// Feed code stays code-split; only this lightweight wrapper is eager.
const LotteryFinderSection = lazy(() =>
  import('../LotteryFinder')
    .then((m) => ({ default: m.LotteryFinderSection }))
    .catch(handleStaleChunk),
);
const SilentBoomSection = lazy(() =>
  import('../SilentBoom')
    .then((m) => ({ default: m.SilentBoomSection }))
    .catch(handleStaleChunk),
);

export interface OptionsAlertsViewProps {
  /** Live market-open flag, threaded to each feed's polling gate. */
  marketOpen: boolean;
  /** Owner/guest + market-or-snapshot gate (mirrors the calculator gate). */
  hasMarketContext: boolean;
}

/**
 * Full-screen alerts view: a fixed 50/50 vertical split with Lottery Finder
 * on top and Silent Boom on the bottom, each pane scrolling independently.
 *
 * Layout: the root is `flex-1 min-h-0` inside App's `h-dvh` alerts shell, so
 * it fills the viewport beneath the header. Each pane is `flex-1 min-h-0
 * overflow-y-auto` — `min-h-0` lets a flex child shrink below its content
 * height, which is what gives each pane its own bounded scroll region
 * instead of growing the page.
 */
export function OptionsAlertsView({
  marketOpen,
  hasMarketContext,
}: OptionsAlertsViewProps) {
  if (!hasMarketContext) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
        <p className="text-secondary max-w-md text-sm">
          Options alerts need live market context. Sign in or load a snapshot to
          see Lottery Finder and Silent Boom fires.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section
        aria-label="Lottery Finder alerts"
        className="border-edge min-h-0 flex-1 overflow-y-auto border-b"
      >
        <Suspense fallback={<SkeletonSection lines={6} />}>
          <LotteryFinderSection marketOpen={marketOpen} />
        </Suspense>
      </section>
      <section
        aria-label="Silent Boom alerts"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <Suspense fallback={<SkeletonSection lines={6} />}>
          <SilentBoomSection marketOpen={marketOpen} />
        </Suspense>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/OptionsAlertsView.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/OptionsAlerts/index.tsx src/__tests__/OptionsAlertsView.test.tsx
git commit -m "feat(alerts): add OptionsAlertsView split-pane component"
```

---

### Task 6: Wire the view switch into `App.tsx`

After this task the toggle works: alerts mode renders `OptionsAlertsView`. The feeds are **still** in the calculator scroll at this point (removed in Task 7) so nothing is ever orphaned in a committed state.

**Files:**
- Modify: `src/App.tsx` (import view + hook; add `useViewMode`; restructure the `return`)

- [ ] **Step 1: Add imports**

In `src/App.tsx`, after the `handleStaleChunk` import added in Task 1, add:

```typescript
import { useViewMode } from './hooks/useViewMode';
import { OptionsAlertsView } from './components/OptionsAlerts';
```

- [ ] **Step 2: Call the hook in the component body**

Near the other top-level hook calls in the `StrikeCalculator` component (anywhere before the `return`, e.g. just after `const hasMarketContext = ...` at line 684), add:

```typescript
  const { view, setView } = useViewMode();
```

- [ ] **Step 3: Extract shared header/banners/modal as consts, then restructure the return**

Replace the existing `return ( ... )` block (currently lines ~1460–1604, from `return (` through `</CollapseAllContext.Provider>\n  );`) with the structure below. The calculator branch is the **existing** markup verbatim — only the wrapping changes. Copy your current `<a href="#results" …>` skip link and the entire `<div className="lg:flex lg:items-start"> … </div>` block into the marked slot unchanged.

```tsx
  const topBars = (
    <>
      <AlertBanner
        alerts={alertState.alerts}
        onAcknowledge={alertState.acknowledge}
      />
      <IntervalBAAlertBanner
        alerts={intervalBAAlertState.alerts}
        onAcknowledge={intervalBAAlertState.acknowledge}
        muted={intervalBAMute.muted}
        onToggleMute={intervalBAMute.toggle}
      />
    </>
  );

  const appHeader = (
    <AppHeader
      accessMode={accessMode}
      isOwner={isOwner}
      isBacktestMode={isBacktestMode}
      market={market}
      historyData={historyData}
      vix={vix}
      vixFileInputRef={vixFileInputRef}
      vixHandleFileUpload={vixHandleFileUpload}
      onVixCsvClick={handleVixCsvClick}
      collapseSignal={collapseSignal}
      onCollapseAll={handleCollapseAll}
      onRunMigrations={handleRunMigrations}
      migrateRunning={migrateRunning}
      onBackfillFeatures={handleBackfillFeatures}
      backfillRunning={backfillRunning}
      darkMode={darkMode}
      onDarkModeToggle={handleDarkModeToggle}
      onOpenPanelPrefs={() => setPanelPrefsOpen(true)}
      view={view}
      onViewChange={setView}
    />
  );

  const prefsModal = (
    <PanelPrefsModal
      isOpen={panelPrefsOpen}
      onClose={() => setPanelPrefsOpen(false)}
      panelPrefs={panelPrefs}
      isAuthenticated={isAuthenticated}
      hasMarketOrSnapshot={hasMarketOrSnapshot}
    />
  );

  return (
    <CollapseAllContext.Provider value={collapseSignal}>
      {view === 'alerts' ? (
        <div
          id="app-shell"
          className="text-primary flex h-dvh flex-col overflow-hidden font-serif transition-[background-color,color] duration-[250ms]"
        >
          {topBars}
          {appHeader}
          {prefsModal}
          <OptionsAlertsView
            marketOpen={market.data.quotes?.marketOpen ?? false}
            hasMarketContext={hasMarketContext}
          />
        </div>
      ) : (
        <>
          {topBars}
          <div
            id="app-shell"
            className="text-primary min-h-dvh font-serif transition-[background-color,color] duration-[250ms]"
          >
            {/* ── PASTE the existing skip link <a href="#results" …> here ── */}
            {appHeader}
            {prefsModal}
            {/* ── PASTE the existing <div className="lg:flex lg:items-start"> … </div> block here, unchanged ── */}
          </div>
          <BackToTop />
          <UpdateAvailableBanner pushedUp={historySnapshot != null} />
          {historySnapshot != null && (
            <BacktestDiag
              snapshot={historySnapshot}
              history={historyData}
              timeHour={timeHour}
              timeMinute={timeMinute}
              timeAmPm={timeAmPm}
              timezone={timezone}
            />
          )}
        </>
      )}
      <Analytics />
      <SpeedInsights />
    </CollapseAllContext.Provider>
  );
```

Notes:
- The old `return` had `<AlertBanner>`/`<IntervalBAAlertBanner>` and `<AppHeader>`/`<PanelPrefsModal>` inline; they are now the `topBars`/`appHeader`/`prefsModal` consts, reused in both branches — delete the inline copies so they aren't duplicated.
- `id="app-shell"` now appears in both branches; harmless (it is not a panel id and the nav-anchors test only treats panel ids specially).

- [ ] **Step 4: Typecheck + run the App-level guard tests**

Run: `npx tsc --noEmit && npx vitest run src/__tests__/App.nav-anchors.test.ts src/__tests__/App.panel-render.test.tsx`
Expected: tsc clean; both App tests PASS (feeds are still registered + rendered at this point, so the registry⊆renderers invariant holds).

- [ ] **Step 5: Manual smoke (optional but recommended)**

Run: `npm run dev` → load the app → click **Options Alerts** in the header → URL gains `#alerts`, the two feeds appear stacked 50/50, each scrolls on its own → click **Calculator** → returns to the full scroll, hash cleared. Browser Back returns to alerts.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(alerts): wire hash view switch + render OptionsAlertsView"
```

---

### Task 7: Remove the feeds from the calculator scroll

Now relocate is complete: drop the two feeds from the registry and from `App.tsx`'s panelMap + lazy consts so they live **only** in the alerts view.

**Files:**
- Modify: `src/constants/panel-registry.ts` (remove 2 entries)
- Modify: `src/App.tsx` (remove 2 panelMap closures + 2 lazy consts)
- Modify: `src/constants/__tests__/panel-registry.test.ts` (remove 2 expected ids)

- [ ] **Step 1: Update the registry test first (TDD — it should fail after removal otherwise)**

In `src/constants/__tests__/panel-registry.test.ts`, delete these two lines from the `expected` array (currently lines 84 and 86):

```typescript
      'sec-lottery-finder',
```
```typescript
      'sec-silent-boom',
```

(Leave `'sec-greek-heatmap'` between them intact.)

- [ ] **Step 2: Remove the registry entries**

In `src/constants/panel-registry.ts`, delete the two object entries (currently lines 95–99 and 105–109):

```typescript
      {
        id: 'sec-lottery-finder',
        label: 'Lottery Finder',
        group: 'Market Context',
      },
```
```typescript
      {
        id: 'sec-silent-boom',
        label: 'Silent Boom',
        group: 'Market Context',
      },
```

- [ ] **Step 3: Remove the panelMap closures in App.tsx**

In `src/App.tsx`, delete the two array entries in the `panelMap` `new Map([...])` literal (currently lines 1116–1130 and 1146–1160):

```tsx
        [
          'sec-lottery-finder',
          () => (
            <GatedSection
              gate={hasMarketContext}
              id="sec-lottery-finder"
              label="Lottery Finder"
              fallback={<SkeletonSection lines={5} />}
            >
              <LotteryFinderSection
                marketOpen={market.data.quotes?.marketOpen ?? false}
              />
            </GatedSection>
          ),
        ],
```
```tsx
        [
          'sec-silent-boom',
          () => (
            <GatedSection
              gate={hasMarketContext}
              id="sec-silent-boom"
              label="Silent Boom"
              fallback={<SkeletonSection lines={5} />}
            >
              <SilentBoomSection
                marketOpen={market.data.quotes?.marketOpen ?? false}
              />
            </GatedSection>
          ),
        ],
```

- [ ] **Step 4: Remove the now-orphaned lazy consts in App.tsx**

The two lazy declarations (currently lines 159–163 and 174–178) are no longer referenced in `App.tsx` (they moved to `OptionsAlertsView`). Delete them:

```tsx
const LotteryFinderSection = lazy(() =>
  import('./components/LotteryFinder')
    .then((m) => ({ default: m.LotteryFinderSection }))
    .catch(handleStaleChunk),
);
```
```tsx
const SilentBoomSection = lazy(() =>
  import('./components/SilentBoom')
    .then((m) => ({ default: m.SilentBoomSection }))
    .catch(handleStaleChunk),
);
```

- [ ] **Step 5: Verify the guard tests + typecheck**

Run: `npx tsc --noEmit && npx vitest run src/constants/__tests__/panel-registry.test.ts src/__tests__/App.nav-anchors.test.ts src/__tests__/App.panel-render.test.tsx`
Expected: all PASS. `tsc` confirms no remaining references to the deleted `LotteryFinderSection`/`SilentBoomSection` consts in App.tsx. `App.nav-anchors` still passes because the registry no longer lists the ids AND App.tsx no longer has their renderer keys (the registry⊆renderers invariant holds in both directions for these ids).

- [ ] **Step 6: Confirm no stray references remain**

Run: `grep -rn "sec-lottery-finder\|sec-silent-boom" src e2e`
Expected: zero matches (the spec's No-Semantic-Search note — string literals + test mocks all cleared).

- [ ] **Step 7: Commit**

```bash
git add src/constants/panel-registry.ts src/constants/__tests__/panel-registry.test.ts src/App.tsx
git commit -m "feat(alerts): move Lottery Finder + Silent Boom out of the calculator scroll"
```

---

### Task 8: Phase 1 full verification + review

**Files:** none (verification only)

- [ ] **Step 1: Run the full review pipeline**

Run: `npm run review`
Expected: `tsc --noEmit` clean, `eslint .` clean, `prettier --write` no diffs left unstaged, `vitest run --coverage` green. Fix any failures (type narrowing / prettier reformat in untouched files is common) before proceeding.

- [ ] **Step 2: Launch the code-reviewer subagent**

Dispatch the `code-reviewer` agent to `git diff` the Phase-1 commits and evaluate correctness, pattern adherence (CLAUDE.md), test coverage, and side effects. Apply any `continue` feedback and re-run `npm run review`.

- [ ] **Step 3: Commit any review fixes**

```bash
git add -A
git commit -m "fix(alerts): address Phase 1 review feedback"
```

(Skip if the reviewer returned `pass` with no changes.)

---

## PHASE 2 — Compact + sticky chrome

Goal: in the alerts panes, collapse each feed's filter toolbar behind a sticky `Filters ⌄` disclosure so alert rows fill the half-screen and filters stay one click away while scrolling.

### Task 9: `CompactDisclosure` sticky wrapper

A reusable sticky, collapsible header used to hide the dense filter toolbar in compact mode. Built once, used by both feeds.

**Files:**
- Create: `src/components/ui/CompactDisclosure.tsx`
- Create: `src/__tests__/CompactDisclosure.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/__tests__/CompactDisclosure.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CompactDisclosure } from '../components/ui/CompactDisclosure';

describe('CompactDisclosure', () => {
  it('starts collapsed and hides its children', () => {
    render(
      <CompactDisclosure label="Filters">
        <div>filter body</div>
      </CompactDisclosure>,
    );
    const toggle = screen.getByRole('button', { name: /filters/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('filter body')).not.toBeInTheDocument();
  });

  it('reveals children when expanded', () => {
    render(
      <CompactDisclosure label="Filters">
        <div>filter body</div>
      </CompactDisclosure>,
    );
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    expect(screen.getByText('filter body')).toBeInTheDocument();
  });

  it('honors defaultOpen', () => {
    render(
      <CompactDisclosure label="Filters" defaultOpen>
        <div>filter body</div>
      </CompactDisclosure>,
    );
    expect(screen.getByText('filter body')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/CompactDisclosure.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// src/components/ui/CompactDisclosure.tsx
import { useState, type ReactNode } from 'react';

interface CompactDisclosureProps {
  label: string;
  /** Optional trailing summary text (e.g. active filter count). */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Sticky, collapsible header for compact panes. The trigger row stays
 * pinned to the top of the scroll container (`sticky top-0`) so filters are
 * always one click away while the alert rows scroll beneath it.
 */
export function CompactDisclosure({
  label,
  summary,
  defaultOpen = false,
  children,
}: CompactDisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-edge bg-page sticky top-0 z-10 border-b">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-secondary hover:text-primary flex w-full items-center gap-2 px-3 py-1.5 font-sans text-[11px] font-semibold"
      >
        <span>{open ? '⌄' : '›'}</span>
        <span>{label}</span>
        {summary != null && (
          <span className="text-tertiary ml-auto">{summary}</span>
        )}
      </button>
      {open && <div className="px-3 pb-2">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/CompactDisclosure.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/CompactDisclosure.tsx src/__tests__/CompactDisclosure.test.tsx
git commit -m "feat(ui): add CompactDisclosure sticky collapsible wrapper"
```

---

### Task 10: `compact` prop on `LotteryFinderSection`

**Files:**
- Modify: `src/components/LotteryFinder/index.tsx`

- [ ] **Step 1: Read the toolbar region**

Open `src/components/LotteryFinder/index.tsx` and locate the filter-toolbar JSX block — the element wrapping the `<FilterChip>` / `SECTION_LABEL` / `TOOLBAR_DIVIDER` controls rendered near the top of the returned tree (search for `TOOLBAR_DIVIDER` and the first `<FilterChip`). Note its opening and closing tags; that whole block is what gets wrapped.

- [ ] **Step 2: Add the prop**

Change the props interface (lines 308–310) to:

```typescript
interface LotteryFinderSectionProps {
  marketOpen: boolean;
  /** When true, the filter toolbar is collapsed behind a sticky disclosure. */
  compact?: boolean;
}
```

Change the signature (lines 373–375) to destructure it:

```typescript
export function LotteryFinderSection({
  marketOpen,
  compact = false,
}: LotteryFinderSectionProps) {
```

Add the import near the other `../ui` imports (alongside line 47 `import { FilterChip } from '../ui/FilterChip.js';`):

```typescript
import { CompactDisclosure } from '../ui/CompactDisclosure.js';
```

(Note: this folder uses explicit `.js` extensions on relative imports — match it.)

- [ ] **Step 3: Conditionally wrap the toolbar**

Wrap the toolbar block identified in Step 1 so that, when `compact`, it renders inside `<CompactDisclosure label="Filters">…</CompactDisclosure>`; otherwise it renders exactly as today. Pattern:

```tsx
{compact ? (
  <CompactDisclosure label="Filters">
    {/* the existing toolbar block, unchanged */}
  </CompactDisclosure>
) : (
  <>{/* the existing toolbar block, unchanged */}</>
)}
```

To avoid duplicating the toolbar JSX, assign it to a local const before the `return` (e.g. `const toolbar = ( …existing JSX… );`) and reference `{toolbar}` in both branches.

- [ ] **Step 4: Verify existing tests still pass**

Run: `npx vitest run src/__tests__/LotteryFinderSection.test.tsx`
Expected: PASS — default (`compact` absent → `false`) preserves current behavior; existing tests don't pass `compact`.

- [ ] **Step 5: Commit**

```bash
git add src/components/LotteryFinder/index.tsx
git commit -m "feat(lottery): add compact mode (collapsible sticky toolbar)"
```

---

### Task 11: `compact` prop on `SilentBoomSection`

**Files:**
- Modify: `src/components/SilentBoom/index.tsx`

- [ ] **Step 1: Read the toolbar region**

Open `src/components/SilentBoom/index.tsx` and locate the filter-toolbar JSX block (search for `TOOLBAR_DIVIDER` / the first `<FilterChip`). Note its bounds.

- [ ] **Step 2: Add the prop**

Change the props interface (lines 415–417) to:

```typescript
interface SilentBoomSectionProps {
  marketOpen: boolean;
  /** When true, the filter toolbar is collapsed behind a sticky disclosure. */
  compact?: boolean;
}
```

Change the signature (line 437) to:

```typescript
export function SilentBoomSection({
  marketOpen,
  compact = false,
}: SilentBoomSectionProps) {
```

Add the import alongside line 48 `import { FilterChip } from '../ui/FilterChip.js';`:

```typescript
import { CompactDisclosure } from '../ui/CompactDisclosure.js';
```

- [ ] **Step 3: Conditionally wrap the toolbar**

Same pattern as Task 10 Step 3: extract the toolbar to a local `const toolbar = ( … );`, then render `{compact ? <CompactDisclosure label="Filters">{toolbar}</CompactDisclosure> : toolbar}`.

- [ ] **Step 4: Verify existing tests still pass**

Run: `npx vitest run src/__tests__/SilentBoomSection.test.tsx`
Expected: PASS (default `compact=false` preserves behavior).

- [ ] **Step 5: Commit**

```bash
git add src/components/SilentBoom/index.tsx
git commit -m "feat(silent-boom): add compact mode (collapsible sticky toolbar)"
```

---

### Task 12: Enable compact in `OptionsAlertsView` + Phase 2 verification

**Files:**
- Modify: `src/components/OptionsAlerts/index.tsx`
- Modify: `src/__tests__/OptionsAlertsView.test.tsx`

- [ ] **Step 1: Pass `compact` to both feeds**

In `src/components/OptionsAlerts/index.tsx`, change the two render sites:

```tsx
          <LotteryFinderSection marketOpen={marketOpen} compact />
```
```tsx
          <SilentBoomSection marketOpen={marketOpen} compact />
```

- [ ] **Step 2: Update the smoke test stubs to accept the prop (optional assertion)**

The existing stubs ignore props, so they still render. Optionally tighten the mock to assert `compact` is forwarded:

```tsx
vi.mock('../components/LotteryFinder', () => ({
  LotteryFinderSection: ({ compact }: { compact?: boolean }) => (
    <div data-testid="lottery">{compact ? 'compact' : 'full'}</div>
  ),
}));
```

and assert `expect(screen.getByTestId('lottery')).toHaveTextContent('compact')`.

- [ ] **Step 3: Full review**

Run: `npm run review`
Expected: all green. Then dispatch the `code-reviewer` subagent over the Phase-2 diff; apply `continue` feedback.

- [ ] **Step 4: Commit**

```bash
git add src/components/OptionsAlerts/index.tsx src/__tests__/OptionsAlertsView.test.tsx
git commit -m "feat(alerts): render feeds in compact mode inside the alerts view"
```

---

## PHASE 3 — Polish (optional)

### Task 13: e2e coverage for the view switch

**Files:**
- Create: `e2e/options-alerts.spec.ts`

- [ ] **Step 1: Write the spec**

Cover: (a) clicking **Options Alerts** sets `#alerts` and shows both `region`s (`Lottery Finder alerts`, `Silent Boom alerts`); (b) each pane scrolls independently (assert `overflow-y: auto` computed style on both regions); (c) **Calculator** clears the hash and restores the scroll; (d) browser Back returns to alerts; (e) an `@axe-core/playwright` scan of the alerts view has no critical violations. Use semantic selectors (`getByRole('tab', …)`, `getByRole('region', …)`) per the playwright-expert conventions.

- [ ] **Step 2: Run**

Run: `npm run test:e2e -- options-alerts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/options-alerts.spec.ts
git commit -m "test(alerts): e2e for view switch + independent pane scroll"
```

### Task 14: Hide calculator-only header controls in alerts mode (optional)

In alerts mode the Collapse-all control is a no-op (no calculator sections are mounted). Gate it on `view === 'calculator'` inside `AppHeader` (it already receives `view`). Add an `AppHeader.test.tsx` case asserting the collapse button is absent when `view="alerts"`. New-fire count badges on the inactive toggle item can also land here if desired (would require lifting each feed's unseen-fire count to a shared source — scope separately).

---

## Self-Review (completed during authoring)

- **Spec coverage:** view model (Task 6), 50/50 split (Task 5), independent scroll (Task 5 `min-h-0`), feed relocation (Task 7), compact+sticky chrome (Tasks 9–12), default=calculator + always-visible toggle (Tasks 3–4, 6), flex height model no pixel math (Task 6). All mapped.
- **Placeholder scan:** the two "PASTE existing block here" markers in Task 6 Step 3 reference concrete, already-existing JSX (the skip link and the `lg:flex` block) rather than unwritten code — they are copy instructions, not TODOs. Phase 2 toolbar-wrap steps begin with an explicit read because the exact JSX lives in 1,650-LOC files; the wrapper pattern + prop edits are fully specified.
- **Type consistency:** `ViewMode` defined in `useViewMode.ts`, consumed by `ViewToggle`, `AppHeader`, and `App`. `OptionsAlertsViewProps` (`marketOpen`, `hasMarketContext`) matches the App render site. `compact?: boolean` added identically to both feed prop interfaces and forwarded from `OptionsAlertsView`.
- **Guard tests:** `panel-registry.test.ts` (Task 7), `App.nav-anchors.test.ts` registry⊆renderers invariant (Tasks 6–7), `App.panel-render.test.tsx` resolver order (unaffected), `AppHeader.test.tsx` factory (Task 4) all addressed.
