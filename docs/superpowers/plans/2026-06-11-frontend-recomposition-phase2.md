# Frontend Recomposition — Phase 2 Implementation Plan (Compact Setup Strip)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the Date & Time, Spot Price, and Implied Volatility panels into one compact `Setup` card with ~38px capped-width controls, relocate the VIX regime card + term-structure block into Market Regime, per Phase 2 of the rev-2 recomposition spec.

**Architecture:** New `src/components/Setup/` folder: a `SetupSection` panel root (one SectionBox) composing three presentational fragments that reuse the existing props contracts of the deleted sections verbatim. All hooks (`useTimeInputs`, `useSpotInputs`, `useIvInputs`, `useAutoFill`) are consumed unchanged from App.tsx. Registry swaps `sec-datetime`/`sec-spot-price`/`sec-iv` for `sec-setup`; `resolvePanelOrder` already drops removed ids and appends new ones (covered by `src/__tests__/utils/panel-order.test.ts:95-117`).

**Tech Stack:** React 19, Tailwind 4 (Phase 0 type-scale semantics: `text-sm`=11px, `text-md`=13px). Phases 0 and 1 MUST be landed first (SectionBox `tier` exists; compact sizes assume the wired scale).

**Non-negotiable constraints (from the full review + scouts):**
1. The memo'd **uncontrolled `DateInput`** inside `DateTimeSection.tsx:13-44` (defaultValue + ref-sync) moves to the new folder **verbatim** — iOS Safari/Android Firefox dismiss the native picker if React reconciles the node. Do NOT substitute `ui/DateInput.tsx` (it's controlled).
2. The `timeEdited` → `↻ Now / Manual time — live sync paused` affordance survives (DateTimeSection.tsx:171-184 markup; state machinery in App.tsx:381-470 is untouched).
3. The 12-hour + AM/PM + ET/CT model stays (do NOT adopt `ui/TimeInputCT` — it's 24-hour CT-only by design).
4. `errors` keys (`time`, `spot`, `vix`, `multiplier`, `iv`) and all input element ids (`dt-date-picker`, `dt-hour`, `dt-min`, `spot-price`, `spx-direct`, `spx-ratio`, `vix-val`, `mult-val`, `direct-iv`, `vix-regime`) keep their values — e2e (`calculator-flow.spec.ts:83,98`, `accessibility.spec.ts:61`) and a11y wiring depend on them.

**Execution-environment rules:** Same as Phase 0/1 plans (scoped verification, surgical git add, single-quoted commits, push per commit).

---

### Task 1: Compact control constants

**Files:**
- Modify: `src/utils/ui-utils.ts` (after `selectCls`, ~line 103)
- Test: `src/__tests__/utils/ui-utils.test.ts` (extend)

- [ ] **Step 1: Failing test** — add to the existing ui-utils test file:

```ts
import { inputClsCompact, selectClsCompact } from '../../utils/ui-utils';

describe('compact input constants', () => {
  it('are ~38px-height variants of the standard input recipe', () => {
    expect(inputClsCompact).toContain('py-1.5');
    expect(inputClsCompact).toContain('text-md');
    expect(inputClsCompact).not.toContain('w-full'); // width capped by callers
    expect(selectClsCompact).toContain('appearance-none');
  });
});
```

- [ ] **Step 2: Run — FAIL.** Then implement:

```ts
/** Compact input styling (~38px tall) for the Setup strip. Width is set
 *  by the caller (capped per field), unlike full-width inputCls. */
export const inputClsCompact =
  'bg-input border-[1.5px] border-edge-strong hover:border-edge-heavy rounded-md text-primary px-2.5 py-1.5 text-md font-mono outline-none box-border transition-[border-color] duration-150';

/** Compact select styling — chevron variant of inputClsCompact. */
export const selectClsCompact =
  inputClsCompact +
  ' cursor-pointer appearance-none bg-no-repeat bg-[length:12px_12px] bg-[position:right_8px_center] pr-[26px]';
```

- [ ] **Step 3: Run test — PASS; commit** (`git add src/utils/ui-utils.ts src/__tests__/utils/ui-utils.test.ts`, message `feat(design): Add compact input/select class constants for the Setup strip`).

---

### Task 2: The Setup fragments + SetupSection panel

**Files:**
- Create: `src/components/Setup/SetupDateTime.tsx`, `src/components/Setup/SetupSpot.tsx`, `src/components/Setup/SetupIv.tsx`, `src/components/Setup/index.tsx`
- Move: `src/components/IVInputSection/IVTooltip.tsx` → delete (replaced by `ui/Tooltip`)
- Test: `src/components/Setup/__tests__/SetupSection.test.tsx` (create)

The fragments are the OLD components minus their SectionBox wrappers, re-laid-out compact. Their props interfaces are IDENTICAL to the old sections' (scouted verbatim in the Phase 2 scout report) so App.tsx's prop wiring transfers 1:1.

- [ ] **Step 1: `SetupDateTime.tsx`** — copy `DateTimeSection.tsx` wholesale, then: delete the `SectionBox` import/wrapper (root becomes a `<div>`); keep the local memo'd `DateInput` (lines 13-44) byte-for-byte; swap `inputCls`→`inputClsCompact + ' w-[150px]'` on the date input, `selectCls`→`selectClsCompact + ' w-[64px]'` on both selects; replace the outer `grid grid-cols-2 items-end gap-2.5` with `flex flex-wrap items-end gap-x-3 gap-y-2`; the `↻ Now` affordance block (171-184) stays at the end unchanged. Export interface `SetupDateTimeProps` = old `Props` verbatim.

- [ ] **Step 2: `SetupSpot.tsx`** — copy `SpotPriceSection.tsx`, drop SectionBox, compact the two inputs (`inputClsCompact + ' w-[110px]'`), and wrap the derived-ratio sub-panel (the `bg-surface-alt` block, old lines 73-135) in the existing `CompactDisclosure` from `ui/` with summary text:

```tsx
import { CompactDisclosure } from '../ui';
…
      <CompactDisclosure
        summary={
          <span className="font-mono text-sm">
            SPX {(Number.parseFloat(dSpot) * effectiveRatio).toFixed(0)} ·
            ratio {effectiveRatio.toFixed(2)}
          </span>
        }
      >
        {/* the existing derived-ratio / slider block, unchanged */}
      </CompactDisclosure>
```

(Read `ui/CompactDisclosure.tsx` first and match its actual props — if its API is `{ label, children }` use that; the summary line above is the content requirement, not a binding API.) Gate it with the same `dSpot && !errors['spot'] && parse > 0` condition as today.

- [ ] **Step 3: `SetupIv.tsx`** — copy `IVInputSection/index.tsx`, drop SectionBox, with these changes:
  - The mode chips (VIX / Direct IV) move OUT — they become part of SetupSection's `headerRight` (Step 4), so `SetupIv` receives `ivMode` but not the fieldset.
  - Compact both inputs (`w-[90px]`).
  - Replace the hand-rolled `IVTooltip` + outside-click state (old lines 52-71 + the `?` button) with `ui/Tooltip`:

```tsx
import Tooltip from '../ui/Tooltip';
…
              <Tooltip
                content="0DTE IV runs above 30-day VIX. 1.15 is the historical median adjustment; raise it on event days."
                maxWidth={260}
              >
                <span
                  aria-label="What is the 0DTE adjustment?"
                  className="border-edge-strong bg-surface-alt text-tertiary inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.5px] font-sans text-sm leading-none font-bold"
                >
                  ?
                </span>
              </Tooltip>
```

  (Read `IVTooltip.tsx`'s actual copy first and carry its full text into `content` — do not paraphrase it away; if it exceeds a sentence, keep it complete.) Delete `IVTooltip.tsx` and the `tooltipOpen`/`tooltipRef`/outside-click effect.
  - DELETE the `VIXRegimeCard` block (old lines 209-212) and the Term Structure block (old lines 214-243) — they move to Market Regime in Task 4. Remove the now-unused props (`results`, `market`, `historySnapshot`, `onUseVix1dAsSigma`, `termShape`, `termShapeAdvice`) from `SetupIvProps`; keep `dVix` (error gating) and `ivMode`.

- [ ] **Step 4: `Setup/index.tsx`** — the panel root:

```tsx
import { SectionBox, Chip } from '../ui';
import { IV_MODES } from '../../constants';
import SetupDateTime, { type SetupDateTimeProps } from './SetupDateTime';
import SetupSpot, { type SetupSpotProps } from './SetupSpot';
import SetupIv, { type SetupIvProps } from './SetupIv';
import type { IVMode } from '../../types';

export interface SetupSectionProps {
  dateTime: SetupDateTimeProps;
  spot: SetupSpotProps;
  iv: SetupIvProps;
  ivMode: IVMode;
  onIvModeChange: (mode: IVMode) => void;
}

export default function SetupSection({
  dateTime,
  spot,
  iv,
  ivMode,
  onIvModeChange,
}: Readonly<SetupSectionProps>) {
  return (
    <SectionBox
      label="Setup"
      collapsible
      headerRight={
        <fieldset className="m-0 border-none p-0">
          <legend className="sr-only">IV input mode</legend>
          <div className="flex gap-1">
            {(
              [
                { key: IV_MODES.VIX, label: 'VIX' },
                { key: IV_MODES.DIRECT, label: 'Direct IV' },
              ] as const
            ).map(({ key, label }) => (
              <Chip
                key={key}
                active={ivMode === key}
                onClick={() => onIvModeChange(key)}
                label={label}
              />
            ))}
          </div>
        </fieldset>
      }
    >
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <SetupDateTime {...dateTime} />
        <div className="border-edge hidden w-px self-stretch border-l sm:block" />
        <SetupSpot {...spot} />
        <div className="border-edge hidden w-px self-stretch border-l sm:block" />
        <SetupIv {...iv} />
      </div>
    </SectionBox>
  );
}
```

- [ ] **Step 5: Component test** — `src/components/Setup/__tests__/SetupSection.test.tsx`. Base the prop fixtures on the old sections' tests if present; minimum coverage:

```tsx
// Renders all three field groups; date input keeps its id; time selects
// keep ids; manual-time affordance appears when timeEdited; VIX-mode vs
// Direct-IV-mode fields switch on ivMode; mode chips call onIvModeChange.
// (Write with @testing-library/react + userEvent following the patterns
// in src/__tests__/components/PreMarketInput.test.tsx.)
it('preserves the input ids the e2e suite depends on', () => {
  render(<SetupSection {...fixture} />);
  for (const id of ['dt-date-picker', 'dt-hour', 'dt-min', 'spot-price', 'spx-direct', 'vix-val', 'mult-val']) {
    expect(document.getElementById(id)).toBeTruthy();
  }
});
it('shows the resume-live affordance only when timeEdited', async () => { … });
it('switches to σ/VIX-regime inputs in Direct IV mode', () => { … });
```

(Fill the `…` bodies with real assertions when writing the file — interaction via `userEvent.click(screen.getByRole('button', { name: '↻ Now' }))` asserting the `onResumeLive` spy, and a rerender with `ivMode: IV_MODES.DIRECT` asserting `#direct-iv` exists.)

- [ ] **Step 6: Run tests — PASS; commit** the new folder + deleted IVTooltip (`feat(design): Add compact Setup panel composing date/time, spot, and IV fragments`).

---

### Task 3: Registry swap + App.tsx closure + delete old sections

**Files:**
- Modify: `src/constants/panel-registry.ts:47-56`, `src/App.tsx` (closures 772-817, 879-905 + imports), `src/components/SectionNav.tsx` (none — labels flow from registry)
- Delete: `src/components/DateTimeSection.tsx`, `src/components/SpotPriceSection.tsx`, `src/components/IVInputSection/` (whole folder)
- Test: update `src/constants/__tests__/panel-registry.test.ts`, `src/__tests__/App.panel-render.test.tsx`, `src/hooks/__tests__/usePanelPrefs.test.tsx`, `src/components/PanelPrefsModal/__tests__/*` (fixtures referencing the old ids/labels), and delete the old sections' component tests.

- [ ] **Step 1:** Registry: replace the `sec-datetime` (line 47) and `sec-spot-price` (line 48) entries with `{ id: 'sec-setup', label: 'Setup', group: 'Inputs' }`, and remove the `sec-iv` entry (line 56). Final Inputs order: setup, premarket, premarket-futures, advanced, risk.

- [ ] **Step 2:** App.tsx: replace the three closures with one `sec-setup` closure that builds the three prop objects from the SAME hook values the old closures used (scouted verbatim — `App.tsx:772-817, 879-905`):

```tsx
        [
          'sec-setup',
          () => (
            <>
              <span id="sec-setup" className="block scroll-mt-28" />
              <SetupSection
                ivMode={ivMode}
                onIvModeChange={setIvMode}
                dateTime={{
                  chevronUrl,
                  selectedDate: vix.selectedDate,
                  onDateChange: handleDateChange,
                  vixDataLoaded: vix.vixDataLoaded,
                  timeHour,
                  onHourChange: handleTimeHourChange,
                  timeMinute,
                  onMinuteChange: handleTimeMinuteChange,
                  timeAmPm,
                  onAmPmChange: handleTimeAmPmChange,
                  timezone,
                  onTimezoneChange: handleTimezoneChange,
                  timeEdited: timeEditedForDisplay,
                  onResumeLive: handleResumeLive,
                  errors,
                }}
                spot={{
                  spotPrice,
                  onSpotChange: handleSpotChange,
                  spxDirect,
                  onSpxDirectChange: handleSpxChange,
                  spxRatio,
                  onSpxRatioChange: setSpxRatio,
                  dSpot,
                  effectiveRatio,
                  spxDirectActive,
                  derivedRatio: spxDirectActive ? spxVal / spyVal : spxRatio,
                  errors,
                }}
                iv={{
                  ivMode,
                  vixInput,
                  onVixChange: handleVixChange,
                  multiplier,
                  onMultiplierChange: setMultiplier,
                  directIVInput,
                  onDirectIVChange: setDirectIVInput,
                  dVix,
                  errors,
                }}
              />
            </>
          ),
        ],
```

The dependency array entries for the removed closures stay (same values feed the new one); remove only entries that become entirely unused after Task 4. Update imports (drop the three old components, add `SetupSection from './components/Setup'`).

- [ ] **Step 3:** Delete the old component files + their tests (`git rm`). Sweep stale references: `grep -rn 'DateTimeSection\|SpotPriceSection\|IVInputSection\|sec-datetime\|sec-spot-price\|"sec-iv"\|'"'"'sec-iv'"'"'' src e2e` — every hit must be deleted/updated. Known fixture sites (from scout): `panel-registry.test.ts:12-17,68-73`, `App.panel-render.test.tsx:49-54,84,113-120`, `usePanelPrefs.test.tsx:73,232-552`, `PanelPrefsModal/__tests__/*`. `panel-order.test.ts` uses its own fixture registry — leave it.

- [ ] **Step 4: Run + commit**

```bash
npx vitest run src && npx tsc --noEmit && npx eslint src --max-warnings=0 && npm run build
npx prettier --write <touched files>
git add -A src/components/Setup src/constants src/App.tsx && git add -u src/components src/__tests__ src/hooks/__tests__
git commit -m 'feat(design): Replace three input panels with the compact Setup strip

sec-datetime / sec-spot-price / sec-iv merge into sec-setup. Stored
panel orders degrade gracefully (resolvePanelOrder drops unknown ids,
appends new ones — covered by panel-order tests). Input ids and error
keys are preserved for e2e and a11y wiring.

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

(Confirm with `git status` that ONLY plan files are staged — other sessions may have WIP.)

---

### Task 4: Relocate VIX regime card + term structure into Market Regime

**Files:**
- Modify: `src/components/MarketRegimeSection.tsx`, `src/App.tsx` (`sec-regime` closure)
- Test: extend the MarketRegimeSection test (or App.panel-render) to assert the blocks render under Market Regime.

- [ ] **Step 1:** `MarketRegimeSection.tsx`: add an optional `volAnalysis?: ReactNode` prop rendered at the TOP of its SectionBox content (before its existing tables), under a sub-heading matching the old one:

```tsx
      {volAnalysis && <div className="mb-4">{volAnalysis}</div>}
```

- [ ] **Step 2:** App.tsx `sec-regime` closure: build the relocated block with the EXACT gating + props the IV section used (scouted from `IVInputSection/index.tsx:209-243`):

```tsx
              <MarketRegimeSection
                {…existing props…}
                volAnalysis={
                  dVix && !errors['vix'] && Number.parseFloat(dVix) > 0 ? (
                    <>
                      {results && (
                        <VIXRegimeCard
                          vix={Number.parseFloat(dVix)}
                          spot={results.spot}
                        />
                      )}
                      <div className="mt-3.5">
                        <div className="text-tertiary mb-2 font-sans text-sm font-bold tracking-[0.14em] uppercase">
                          Term Structure
                        </div>
                        <VIXTermStructure
                          key={historySnapshot ? `hist-${historySnapshot.candle.datetime}` : 'live'}
                          vix={Number.parseFloat(dVix)}
                          onUseVix1dAsSigma={handleUseVix1dAsSigma}
                          isVix1dActive={ivMode === IV_MODES.DIRECT}
                          initialVix1d={historySnapshot?.vix1d ?? market.data.quotes?.vix1d?.price}
                          initialVix9d={historySnapshot?.vix9d ?? market.data.quotes?.vix9d?.price}
                          initialVvix={historySnapshot?.vvix ?? market.data.quotes?.vvix?.price}
                          termShape={signals.vixTermShape}
                          termShapeAdvice={signals.vixTermShapeAdvice}
                          marketOpen={market.marketOpen && !historySnapshot}
                        />
                      </div>
                    </>
                  ) : undefined
                }
              />
```

Imports `VIXRegimeCard` / `VIXTermStructure` move from the deleted IV section to App.tsx. Check the `sec-regime` dependency-array entries cover `dVix, errors, results, historySnapshot, market, handleUseVix1dAsSigma, ivMode, signals` — most already exist; add missing ones.

- [ ] **Step 3: Run + commit** (`npx vitest run src && npx tsc --noEmit && npx eslint src --max-warnings=0`; message `ref(design): Move VIX regime card + term structure into Market Regime`).

---

### Task 5: e2e updates

**Files:** `e2e/entry-time.spec.ts:14`, `e2e/calculator-flow.spec.ts:26,54`, `e2e/panel-reorder.spec.ts:32,35,81`

- [ ] **Step 1:** Update label-based selectors (the ids survive; the labels change):
  - `getByText('Date & Time', { exact: true })` → `getByText('Setup', { exact: true })` (entry-time:14, calculator-flow:54).
  - `page.getByLabel('Spot Price')` (calculator-flow:26) → `page.getByLabel('Setup')` with the same inner assertion (the SectionBox `aria-label` is now `Setup`).
  - panel-reorder:32,35: `'Drag to reorder Date & Time'` / `'Drag to reorder Spot Price'` → a single `'Drag to reorder Setup'` (adjust the test's reorder scenario to drag Setup vs another Inputs panel, e.g. Advanced).
  - panel-reorder:81: `'Hide Date & Time'` → `'Hide Setup'`.

- [ ] **Step 2:** Run the three specs against a production preview or `npm run build && npx vite preview` (frontend-only dev is broken — known bug): `npx playwright test e2e/entry-time.spec.ts e2e/calculator-flow.spec.ts e2e/panel-reorder.spec.ts`. Expected: PASS.

- [ ] **Step 3: Commit** (`test(e2e): Update selectors for the merged Setup panel`).

---

### Task 6: Phase-end verification + review

- [ ] **Step 1:** Scoped or full verification per the tree state (same rule as prior phases) + `npm run build`.
- [ ] **Step 2:** `code-reviewer` agent over the Phase 2 commit range; apply feedback.
- [ ] **Step 3:** Screenshot pass both themes: Setup renders as one compact card (~38px controls, capped widths); first viewport now reaches Market Regime; term structure appears under Market Regime; `↻ Now` works; panel-prefs modal shows "Setup" once with no ghost entries.
