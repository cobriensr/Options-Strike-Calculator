# Frontend Recomposition — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the design-system foundation — type scale into Tailwind's `@theme`, token extensions, tokenized filter-toolbar, the quick-fix list, and a ratchet gate — per Phase 0 of `docs/superpowers/specs/2026-06-11-frontend-recomposition-design.md` (rev 2).

**Architecture:** All token work happens in `src/index.css` (Tailwind 4 `@theme` block). The named-size remap is a cascade-ordered global rename that MUST land in the same commit as the `@theme` wiring (each changes rendering without the other). Style sweeps are pure-mechanical commits (no logic changes). Behavioral quick fixes ship with tests. A vitest "gate" file ratchets raw-palette and off-scale-type usage downward via explicit allowlists.

**Tech Stack:** Vite + React 19, Tailwind CSS 4 (`@theme` CSS-variable tokens), Vitest + Testing Library.

**Execution-environment rules (apply to every task):**

- A parallel Claude session may be editing `api/` files. NEVER run bare `npm run review` mid-task (its `prettier --write` reformats the whole repo, including their WIP). Instead verify with:
  - `npx tsc --noEmit` (read-only)
  - `npx eslint src --max-warnings=0` (read-only; scope to `src`)
  - `npx prettier --write <only the files you touched>`
  - `npx vitest run <relevant test files>` (or `npx vitest run src` for sweeps)
- Stage surgically: `git add <explicit paths>` — never `git add -A`.
- Commit messages: Sentry conventional format, single-quoted (zsh + backticks).
- Push after each commit (`git push origin main`) — auto-deploys; changes here are small visual normalizations.

---

### Task 1: Wire the type scale into `@theme` + global named-size remap

One commit. The `@theme` wiring redefines what `text-xs/sm/lg/xl` mean; the remap moves every existing named-size usage one notch so each call site's rendered size changes by ≤2px (the intended normalization) instead of silently shrinking 2–4px.

**Files:**
- Modify: `src/index.css:82-103` (move `--text-*` from `:root` into `@theme`, add display + line-height tokens)
- Modify: ~100 files under `src/` via scripted rename (mechanical)

- [ ] **Step 1: Edit `src/index.css`** — inside the existing `@theme` block (after the `/* Fonts */` group, line ~79), add:

```css
  /* Type scale (pixel-precise for data-dense UI).
     Lives in @theme so Tailwind generates text-* utilities from it:
     text-2xs=8 text-xs=10 text-sm=11 text-md=13 text-lg=15 text-xl=16
     text-display=22 (hero numerals). NOTE: text-base is intentionally
     not overridden (= 16px default); prefer text-xl. */
  --text-2xs: 8px;
  --text-2xs--line-height: 1.3;
  --text-xs: 10px;
  --text-xs--line-height: 1.3;
  --text-sm: 11px;
  --text-sm--line-height: 1.35;
  --text-md: 13px;
  --text-md--line-height: 1.4;
  --text-lg: 15px;
  --text-lg--line-height: 1.4;
  --text-xl: 16px;
  --text-xl--line-height: 1.4;
  --text-display: 22px;
  --text-display--line-height: 1.2;
```

Then DELETE the old `:root` copies (lines 85-91):

```css
  /* Type scale (pixel-precise for data-dense UI) */
  --text-2xs: 8px;
  --text-xs: 10px;
  --text-sm: 11px;
  --text-md: 13px;
  --text-lg: 15px;
  --text-xl: 16px;
```

(Leave `--tracking-*` and `--shadow-*` in `:root` — out of scope.)

- [ ] **Step 2: Global named-size cascade rename.** Order is load-bearing — run exactly in this sequence (later renames must not re-match earlier outputs):

```bash
cd /Users/charlesobrien/Documents/Workspace/strike-calculator
# 1. text-xl (20px) -> text-display (22px)
grep -rl --include='*.tsx' --include='*.ts' -E '(^|[^-\w])text-xl([^-\w]|$)' src e2e | xargs -I{} perl -pi -e 's/(?<![-\w])text-xl(?![-\w])/text-display/g' {}
# 2. text-lg (18px) -> text-xl (16px)
grep -rl --include='*.tsx' --include='*.ts' -E '(^|[^-\w])text-lg([^-\w]|$)' src e2e | xargs -I{} perl -pi -e 's/(?<![-\w])text-lg(?![-\w])/text-xl/g' {}
# 3. text-base (16px) -> text-xl (16px)
grep -rl --include='*.tsx' --include='*.ts' -E '(^|[^-\w])text-base([^-\w]|$)' src e2e | xargs -I{} perl -pi -e 's/(?<![-\w])text-base(?![-\w])/text-xl/g' {}
# 4. text-sm (14px) -> text-md (13px)   [MUST run before rule 5]
grep -rl --include='*.tsx' --include='*.ts' -E '(^|[^-\w])text-sm([^-\w]|$)' src e2e | xargs -I{} perl -pi -e 's/(?<![-\w])text-sm(?![-\w])/text-md/g' {}
# 5. text-xs (12px) -> text-sm (11px)
grep -rl --include='*.tsx' --include='*.ts' -E '(^|[^-\w])text-xs([^-\w]|$)' src e2e | xargs -I{} perl -pi -e 's/(?<![-\w])text-xs(?![-\w])/text-sm/g' {}
```

The `(?<![-\w])`/`(?![-\w])` guards keep variant prefixes working (`lg:text-sm` matches; `text-small`/`text-xs-foo` don't). `text-2xl`+ are intentionally untouched (hero sizes get redesigned in Phases 1/6).

- [ ] **Step 3: Verify zero stragglers**

```bash
grep -rn --include='*.tsx' -E '(?<![-\w])text-(base|2xs)(?![-\w])' src -P | grep -v 'text-2xs' | head
grep -rn --include='*.tsx' -P '(?<![-\w])text-xs(?![-\w])' src | head -3
```

Expected: first command empty (no `text-base` left); second shows only NEW `text-xs` written by this plan (none yet — empty).

- [ ] **Step 4: Type-check, lint, scoped tests**

```bash
npx tsc --noEmit && npx eslint src --max-warnings=0
npx vitest run src
```

Expected: PASS. If a unit test asserts a literal class string (`text-xs` etc.), update the assertion to the new name — that is the only acceptable test change.

- [ ] **Step 5: Visual sanity** — `npm run dev` is broken frontend-only (known bug); instead `npm run build` must succeed:

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add src/index.css $(git diff --name-only -- src e2e)
git commit -m 'feat(design): Wire pixel type scale into @theme, remap named sizes

Move --text-* tokens from :root into the Tailwind @theme block so
text-xs/sm/md/lg/xl utilities resolve to the 10/11/13/15/16px scale,
add --text-display (22px) for hero numerals, and cascade-rename all
named-size usages one notch (xl->display, lg->xl, base->xl, sm->md,
xs->sm) so each call site shifts at most 2px. Collapses the dual
type-system found by the 2026-06-11 design review (S1).

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 2: Arbitrary on-scale values → named utilities (pure rename, repo-wide)

Zero rendering change: each `text-[Npx]` whose `N` is on the scale becomes the now-equivalent named utility.

**Files:** ~150 files under `src/` via scripted rename.

- [ ] **Step 1: Run the renames** (order irrelevant — names and arbitrary values are disjoint):

```bash
cd /Users/charlesobrien/Documents/Workspace/strike-calculator
for pair in '8:2xs' '10:xs' '11:sm' '13:md' '15:lg' '16:xl' '22:display'; do
  px="${pair%%:*}"; name="${pair##*:}"
  grep -rl --include='*.tsx' --include='*.ts' "text-\[${px}px\]" src e2e | xargs -I{} perl -pi -e "s/text-\[${px}px\]/text-${name}/g" {}
done
```

- [ ] **Step 2: Verify and test**

```bash
grep -rn --include='*.tsx' -E 'text-\[(8|10|11|13|15|16|22)px\]' src | head
npx tsc --noEmit && npx eslint src --max-warnings=0 && npx vitest run src
```

Expected: grep empty; checks PASS (update literal-class test assertions only).

- [ ] **Step 3: Commit**

```bash
git add $(git diff --name-only -- src e2e)
git commit -m 'ref(design): Replace on-scale arbitrary text sizes with named utilities

Pure rename, zero rendering change: text-[10px] -> text-xs etc., now
that the @theme wiring makes the named utilities resolve to the same
pixel values.

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---### Task 3: Off-scale snaps in `ui/` + calculator slice

Off-scale strays (7/9/12/14/17/18/20px) snap to the nearest scale step. Scope per spec open question 5: `src/components/ui/`, `src/utils/ui-utils.ts`, and the calculator-slice files. Other folders stay grandfathered until Phases 6–7 touch them.

**Files:**
- Modify (where matches exist): `src/components/ui/*`, `src/utils/ui-utils.ts`, `src/components/{DateTimeSection,SpotPriceSection,AdvancedSection,PreMarketInput,MarketRegimeSection,ResultsSection,DeltaStrikesTable,ThetaDecayChart,VIXRegimeCard,RvIvCard,DollarField,ParameterSummary,DateLookupSection,VixUploadSection,PinRiskAnalysis}.tsx`, `src/components/{IVInputSection,IronCondorSection,BWBSection,HedgeSection,RiskCalculator,BWBCalculator,FuturesCalculator,VIXRangeAnalysis,VIXTermStructure,VixRegimeBanner,DeltaRegimeGuide,OpeningRangeCheck,SettlementCheck,PreTradeSignals}/`

- [ ] **Step 1: Run the snaps over the scoped paths**

```bash
cd /Users/charlesobrien/Documents/Workspace/strike-calculator
SCOPE="src/components/ui src/utils/ui-utils.ts src/components/DateTimeSection.tsx src/components/SpotPriceSection.tsx src/components/AdvancedSection.tsx src/components/PreMarketInput.tsx src/components/MarketRegimeSection.tsx src/components/ResultsSection.tsx src/components/DeltaStrikesTable.tsx src/components/ThetaDecayChart.tsx src/components/VIXRegimeCard.tsx src/components/RvIvCard.tsx src/components/DollarField.tsx src/components/ParameterSummary.tsx src/components/DateLookupSection.tsx src/components/VixUploadSection.tsx src/components/PinRiskAnalysis.tsx src/components/IVInputSection src/components/IronCondorSection src/components/BWBSection src/components/HedgeSection src/components/RiskCalculator src/components/BWBCalculator src/components/FuturesCalculator src/components/VIXRangeAnalysis src/components/VIXTermStructure src/components/VixRegimeBanner src/components/DeltaRegimeGuide src/components/OpeningRangeCheck src/components/SettlementCheck src/components/PreTradeSignals"
for pair in '7:2xs' '9:xs' '12:sm' '14:md' '17:xl' '18:lg' '20:display'; do
  px="${pair%%:*}"; name="${pair##*:}"
  grep -rl "text-\[${px}px\]" $SCOPE 2>/dev/null | xargs -I{} perl -pi -e "s/text-\[${px}px\]/text-${name}/g" {}
done
```

(Mapping rationale: 9→10 xs, 12→11 sm, 14→13 md, 17→16 xl, 18→15 lg, 20→22 display. SettlementCheck's load-bearing `text-2xs` (8px) figures are a Phase 1 design question, not a snap — leave.)

- [ ] **Step 2: Verify, test, build**

```bash
grep -rn -E 'text-\[(7|9|12|14|17|18|20)px\]' $SCOPE 2>/dev/null | head
npx tsc --noEmit && npx eslint src --max-warnings=0 && npx vitest run src && npm run build
```

Expected: grep empty; all PASS.

- [ ] **Step 3: Commit**

```bash
git add $(git diff --name-only -- src)
git commit -m 'ref(design): Snap off-scale text sizes to the type scale (ui + calculator slice)

7/9/12/14/17/18/20px arbitrary values snap to the nearest scale step
(max 2px shift). Remaining folders are grandfathered until their
recomposition phases (6-7) touch them.

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 4: Token extensions (chart series, on-accent, hues, layout, z-scale)

**Files:**
- Modify: `src/index.css` (`@theme`, `:root`, `.dark` blocks)
- Modify: `src/App.tsx:1570`, `src/components/AppHeader/index.tsx:116`, `src/components/SectionNav.tsx:82,116,123` (adopt `--content-max` / `--header-h`)

- [ ] **Step 1: Add to the `@theme` block** (after the chart-specific colors, line ~74):

```css
  /* Semantic market-direction aliases (feeds/charts read these) */
  --color-bull: var(--color-success);
  --color-bear: var(--color-danger);
  --color-warn: var(--color-caution);
  --color-info: var(--color-accent);

  /* Canvas/SVG chart series (read via getComputedStyle at creation) */
  --color-chart-bull: #15803d;
  --color-chart-bear: #b91c1c;
  --color-chart-vwap: #b45309;
  --color-chart-overlay-1: #0e7490;
  --color-chart-overlay-2: #c2410c;

  /* Text/icon color on accent-filled surfaces */
  --color-on-accent: #ffffff;

  /* Filter-chip hue family (10 categorical hues for the feed toolbars).
     Light values; .dark overrides below. Consumed via
     border-(--color-hue-*)/bg-(--color-hue-*)/15 in
     ui/filter-toolbar-tokens.ts. */
  --color-hue-sky: #0369a1;
  --color-hue-rose: #be123c;
  --color-hue-amber: #b45309;
  --color-hue-emerald: #047857;
  --color-hue-green: #15803d;
  --color-hue-red: #b91c1c;
  --color-hue-blue: #1d4ed8;
  --color-hue-fuchsia: #a21caf;
  --color-hue-orange: #c2410c;
  --color-hue-purple: #7c3aed;
  --color-hue-neutral: #5c5950;
```

- [ ] **Step 2: Add the dark overrides** to the `.dark` block (after `--color-chart-amber`, line ~151):

```css
  --color-chart-bull: #00e676;
  --color-chart-bear: #ff5252;
  --color-chart-vwap: #f59e0b;
  --color-chart-overlay-1: #00bcd4;
  --color-chart-overlay-2: #ff9800;
  --color-on-accent: #1a1a22;
  --color-hue-sky: #38bdf8;
  --color-hue-rose: #fb7185;
  --color-hue-amber: #fbbf24;
  --color-hue-emerald: #34d399;
  --color-hue-green: #4ade80;
  --color-hue-red: #f87171;
  --color-hue-blue: #60a5fa;
  --color-hue-fuchsia: #e879f9;
  --color-hue-orange: #fb923c;
  --color-hue-purple: #a78bfa;
  --color-hue-neutral: #9898a8;
```

- [ ] **Step 3: Add layout + z tokens** to the `:root` block (after `--shadow-tooltip`, line ~102):

```css
  /* Layout invariants (kill the duplicated magic numbers) */
  --header-h: 57px;
  --content-max: 660px;

  /* z-index scale */
  --z-nav: 50;
  --z-banner: 60;
  --z-overlay: 65;
  --z-toast: 70;
  --z-modal: 200;
```

- [ ] **Step 4: Adopt the layout tokens at the three magic-number sites.**
In `src/App.tsx:1570`: `max-w-[660px]` → `max-w-(--content-max)`.
In `src/components/AppHeader/index.tsx:116`: `max-w-[660px]` → `max-w-(--content-max)`.
In `src/components/SectionNav.tsx`: `top-[57px]` (lines 82 and 116) → `top-(--header-h)`; `max-w-[660px]` (line 123) → `max-w-(--content-max)`.
(Tailwind 4 parenthesized custom-property shorthand. z-token adoption happens in Phase 7's overlay layer — defining them now is enough.)

- [ ] **Step 5: Verify and commit**

```bash
npx tsc --noEmit && npx eslint src --max-warnings=0 && npx vitest run src && npm run build
git add src/index.css src/App.tsx src/components/AppHeader/index.tsx src/components/SectionNav.tsx
git commit -m 'feat(design): Extend token family (chart series, hues, on-accent, layout, z)

Adds chart-series tokens for canvas/SVG charts to read at creation,
an on-accent text token, 10 categorical hue tokens for the feed
filter chips, semantic bull/bear/warn/info aliases, and layout/z
scales replacing the duplicated 660px / 57px magic numbers.

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 5: Tokenize `ui/filter-toolbar-tokens.ts`

Light-mode-safe chips via the Task 4 hue tokens. Class literals stay literal (Tailwind's scanner can't resolve interpolation — keep the existing docstring).

**Files:**
- Modify: `src/components/ui/filter-toolbar-tokens.ts`
- Test: `src/__tests__/filter-toolbar-tokens.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  CHIP_ACTIVE,
  CHIP_BASE,
  CHIP_INACTIVE,
  SECTION_LABEL,
  TOOLBAR_DIVIDER,
} from '../components/ui/filter-toolbar-tokens';

const RAW_PALETTE = /(neutral|slate|zinc|gray|stone)-\d|(sky|rose|amber|emerald|green|red|blue|fuchsia|orange|purple)-\d{2,3}/;

describe('filter-toolbar tokens', () => {
  it('uses no raw Tailwind palette classes', () => {
    const all = [
      CHIP_BASE,
      CHIP_INACTIVE,
      SECTION_LABEL,
      TOOLBAR_DIVIDER,
      ...Object.values(CHIP_ACTIVE),
    ].join(' ');
    expect(all).not.toMatch(RAW_PALETTE);
  });

  it('keeps one entry per FilterChipColor', () => {
    expect(Object.keys(CHIP_ACTIVE).sort()).toEqual(
      [
        'amber', 'blue', 'emerald', 'fuchsia', 'green', 'neutral',
        'orange', 'purple', 'red', 'rose', 'sky',
      ].sort(),
    );
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`npx vitest run src/__tests__/filter-toolbar-tokens.test.ts`; raw palette matches).

- [ ] **Step 3: Rewrite the constants** (types and exports unchanged):

```ts
export const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-sm font-medium transition-colors';

export const CHIP_INACTIVE =
  'border-chip-border bg-chip-bg text-chip-text hover:border-edge-strong hover:text-primary';

export const CHIP_ACTIVE: Record<FilterChipColor, string> = {
  sky: 'border-(--color-hue-sky)/70 bg-(--color-hue-sky)/15 text-(--color-hue-sky)',
  rose: 'border-(--color-hue-rose)/70 bg-(--color-hue-rose)/15 text-(--color-hue-rose)',
  amber: 'border-(--color-hue-amber)/70 bg-(--color-hue-amber)/15 text-(--color-hue-amber)',
  emerald: 'border-(--color-hue-emerald)/70 bg-(--color-hue-emerald)/15 text-(--color-hue-emerald)',
  green: 'border-(--color-hue-green)/70 bg-(--color-hue-green)/15 text-(--color-hue-green)',
  red: 'border-(--color-hue-red)/70 bg-(--color-hue-red)/15 text-(--color-hue-red)',
  blue: 'border-(--color-hue-blue)/70 bg-(--color-hue-blue)/15 text-(--color-hue-blue)',
  fuchsia: 'border-(--color-hue-fuchsia)/70 bg-(--color-hue-fuchsia)/15 text-(--color-hue-fuchsia)',
  orange: 'border-(--color-hue-orange)/70 bg-(--color-hue-orange)/15 text-(--color-hue-orange)',
  purple: 'border-(--color-hue-purple)/70 bg-(--color-hue-purple)/15 text-(--color-hue-purple)',
  neutral: 'border-(--color-hue-neutral)/70 bg-(--color-hue-neutral)/15 text-(--color-hue-neutral)',
};

export const SECTION_LABEL =
  'text-xs font-semibold tracking-[0.08em] text-muted uppercase';

export const TOOLBAR_DIVIDER = 'mx-1 hidden h-4 w-px bg-edge sm:block';
```

- [ ] **Step 4: Run tests + build** (`npx vitest run src/__tests__/filter-toolbar-tokens.test.ts && npm run build`). Expected: PASS; build confirms Tailwind resolves the parenthesized custom-property classes.

- [ ] **Step 5: Visual spot-check both themes** on production preview after push (feeds toolbar chips must be legible in light mode now).

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/filter-toolbar-tokens.ts src/__tests__/filter-toolbar-tokens.test.ts
git commit -m 'fix(design): Tokenize filter-toolbar chips, make feeds light-mode safe

Re-express CHIP_*/SECTION_LABEL/TOOLBAR_DIVIDER on the hue and chip
tokens instead of raw dark-only Tailwind palette classes. The feed
toolbars (LotteryFinder, SilentBoom, IntervalBA) were unreadable in
light mode (design review S2).

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 6: Quick fixes A — class-level no-ops and mismatches

All are broken-in-place classes with zero behavioral risk.

**Files:**
- Modify: `src/components/ui/DateInput.tsx:41`, `src/components/ui/TimeInputCT.tsx:41`, `src/components/OpeningFlowSignal/OpeningFlowSignal.tsx:77`, `src/components/ui/Tooltip.tsx:209`, `src/components/PreMarketInput.tsx:177`, `src/App.tsx:278`, `src/components/GexTarget/UrgencyPanel.tsx:65`

- [ ] **Step 1: `text-text` → `text-primary`** (the `--color-text` token does not exist; class silently no-ops):
  - `DateInput.tsx:41` and `TimeInputCT.tsx:41`: `'border-edge bg-surface-alt text-text rounded …'` → `'border-edge bg-surface-alt text-primary rounded …'`
  - `OpeningFlowSignal.tsx:77`: same replacement inside the Live button class string.

- [ ] **Step 2: Tooltip dead animation** — `Tooltip.tsx:209`: replace `animate-in fade-in duration-100` with `animate-fade-in-up` (the keyframe exists in index.css; the `animate-in` plugin is not installed).

- [ ] **Step 3: Dead `border-opacity-40`** — `PreMarketInput.tsx:177`: `inputCls + ' border-[color:var(--color-accent)] border-opacity-40'` → `inputCls + ' border-accent/40'` (restores the intended 40% accent border; `border-opacity-*` is a no-op in Tailwind 4).

- [ ] **Step 4: PWA theme-color** — `App.tsx:278`: `darkMode ? '#121212' : '#f4f1eb'` → `darkMode ? '#1a1a22' : '#f4f1eb'` (match dark `--color-page`).

- [ ] **Step 5: UrgencyPanel class concat** — `GexTarget/UrgencyPanel.tsx:65`: `` `flex flex-col gap-0.5 rounded px-1 -mx-1${isAtm ? 'bg-sky-500/10' : ''}` `` → `` `flex flex-col gap-0.5 rounded px-1 -mx-1${isAtm ? ' bg-sky-500/10' : ''}` `` (missing space made the ATM highlight never apply).

- [ ] **Step 6: Verify and commit**

```bash
npx tsc --noEmit && npx eslint src --max-warnings=0 && npx vitest run src
npx prettier --write src/components/ui/DateInput.tsx src/components/ui/TimeInputCT.tsx src/components/OpeningFlowSignal/OpeningFlowSignal.tsx src/components/ui/Tooltip.tsx src/components/PreMarketInput.tsx src/App.tsx src/components/GexTarget/UrgencyPanel.tsx
git add src/components/ui/DateInput.tsx src/components/ui/TimeInputCT.tsx src/components/OpeningFlowSignal/OpeningFlowSignal.tsx src/components/ui/Tooltip.tsx src/components/PreMarketInput.tsx src/App.tsx src/components/GexTarget/UrgencyPanel.tsx
git commit -m 'fix(design): Repair five silently-broken class usages

text-text (nonexistent token) -> text-primary in DateInput/
TimeInputCT/OpeningFlowSignal; dead animate-in classes -> the in-repo
fade keyframe; dead Tailwind-4 border-opacity -> border-accent/40;
PWA theme-color matched to dark --color-page; UrgencyPanel ATM
highlight class-concat missing space.

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 7: Quick fixes B — behavioral honesty fixes (with tests)

**Files:**
- Modify: `src/components/VIXTermStructure/index.tsx:43-44`, `src/components/OpeningRangeCheck/index.tsx:45-46`, `src/components/Gexbot/CharmClock.tsx:86`, `src/components/SilentBoom/SilentBoomRow.tsx:746`, `src/components/AlertBanner.tsx:100`, `src/components/IntervalBAAlertBanner.tsx` (dismiss buttons), `src/components/NotificationPermission.tsx:50,56`
- Test: extend the components' existing test files where they exist (check `src/__tests__/` and component `__tests__/`); create `src/__tests__/vix-term-structure-defaults.test.tsx` if none exists.

- [ ] **Step 1: Fabricated defaults → empty.** `VIXTermStructure/index.tsx:43-44`: `useState('18.50')`/`useState('20.10')` → `useState('')`/`useState('')`. `OpeningRangeCheck/index.tsx:45-46`: `useState('5735')`/`useState('5705')` → `useState('')`/`useState('')`. Then read each component's derived-value path: both already guard on `Number.parseFloat` results (verify — if a `NaN` reaches render, add an early `if (Number.isNaN(x)) return` to the derived `useMemo` so the panel renders its inputs with placeholders and no computed signal). Add `placeholder` attrs showing example values (`placeholder="18.50"` etc.) so the affordance survives.

- [ ] **Step 2: Test the no-fabrication behavior.** In the VIXTermStructure test (extend existing or create):

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VIXTermStructure from '../components/VIXTermStructure';

describe('VIXTermStructure defaults', () => {
  it('renders no regime verdict until both inputs are provided', () => {
    render(<VIXTermStructure />);
    // No fabricated 18.50/20.10 values -> no computed signal text.
    expect(screen.queryByText(/EVENT RISK|ELEVATED|NORMAL|CALM/)).toBeNull();
  });
});
```

(Adjust the import/props to the component's actual signature — read it first; if it requires props, pass the minimal real ones from its App.tsx call site. Same pattern for OpeningRangeCheck.)

- [ ] **Step 3: CharmClock frozen clock.** `Gexbot/CharmClock.tsx:86`: replace

```ts
const hoursRemaining = useMemo(() => hoursToClose(new Date()), []);
```

with

```ts
const nowMs = useNowMinute();
const hoursRemaining = hoursToClose(new Date(nowMs));
```

adding `import { useNowMinute } from '../../hooks/useNowMinute.js';` (drop the now-unused `useMemo` import if nothing else uses it).

- [ ] **Step 4: SilentBoomRow render-time clock.** `SilentBoomRow.tsx:746`: `Date.now() - new Date(alert.bucketCt).getTime() < 10 * 60_000` → `nowMs - new Date(alert.bucketCt).getTime() < 10 * 60_000` (`nowMs` already in scope from line 459).

- [ ] **Step 5: `type="button"` on dismiss/CTA buttons** missing it: `AlertBanner.tsx:100` (dismiss ✕), `IntervalBAAlertBanner.tsx` lines 88/120/185 (check each `<button` found by `grep -n '<button' src/components/IntervalBAAlertBanner.tsx` — add to any without an explicit `type`), `NotificationPermission.tsx:50,56`.

- [ ] **Step 6: Verify and commit**

```bash
npx tsc --noEmit && npx eslint src --max-warnings=0 && npx vitest run src
npx prettier --write src/components/VIXTermStructure/index.tsx src/components/OpeningRangeCheck/index.tsx src/components/Gexbot/CharmClock.tsx src/components/SilentBoom/SilentBoomRow.tsx src/components/AlertBanner.tsx src/components/IntervalBAAlertBanner.tsx src/components/NotificationPermission.tsx src/__tests__/vix-term-structure-defaults.test.tsx
git add <the files above>
git commit -m 'fix(ui): Stop fabricating defaults, unfreeze clocks, button types

VIXTermStructure and OpeningRangeCheck no longer render computed
signals from hardcoded example values before live data arrives;
CharmClock recomputes hours-to-close per minute instead of freezing
at mount; SilentBoomRow hot-pulse uses the shared minute clock
instead of Date.now() in render; dismiss/CTA buttons get explicit
type=button.

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 8: Design-system ratchet gates

A vitest file that scans `src/components` and fails when (a) a non-allowlisted file uses raw palette classes, or (b) any file uses off-scale arbitrary text sizes not on its allowlist. Allowlists shrink as phases migrate folders — the test also fails when an allowlisted file becomes clean, forcing the entry's removal (a true ratchet).

**Files:**
- Create: `src/__tests__/design-system-gate.test.ts`

- [ ] **Step 1: Generate the initial allowlists** (run, capture output):

```bash
cd /Users/charlesobrien/Documents/Workspace/strike-calculator
grep -rl --include='*.tsx' --include='*.ts' -E '(^|[^-\w])(bg|text|border|ring|fill|stroke|from|to|accent|shadow)-(neutral|slate|zinc|gray|stone|sky|rose|amber|emerald|green|red|blue|fuchsia|orange|purple|violet|cyan|teal|yellow|lime|indigo|pink)-\d' src/components | sort
grep -rl --include='*.tsx' --include='*.ts' -E 'text-\[(7|9|12|14|17|18|20|24|28)px\]' src/components | sort
```

- [ ] **Step 2: Write the gate test** with the captured lists pasted in:

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', 'components');

const RAW_PALETTE =
  /(^|[^-\w])(bg|text|border|ring|fill|stroke|from|to|accent|shadow)-(neutral|slate|zinc|gray|stone|sky|rose|amber|emerald|green|red|blue|fuchsia|orange|purple|violet|cyan|teal|yellow|lime|indigo|pink)-\d/;
const OFF_SCALE_TEXT = /text-\[(7|9|12|14|17|18|20|24|28)px\]/;

/** Files allowed to keep raw palette classes until their phase
 *  migrates them (design review S2). REMOVE entries as they clean up —
 *  the gate fails if an entry stops matching. */
const PALETTE_ALLOWLIST = new Set<string>([
  // <paste Step 1 first list here, paths relative to src/components>
]);

const TEXT_ALLOWLIST = new Set<string>([
  // <paste Step 1 second list here>
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory())
      return name === '__tests__' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('design-system gate', () => {
  const files = walk(ROOT).map((p) => ({
    rel: relative(ROOT, p),
    body: readFileSync(p, 'utf8'),
  }));

  it('no new raw-palette color classes outside the allowlist', () => {
    const offenders = files
      .filter((f) => RAW_PALETTE.test(f.body) && !PALETTE_ALLOWLIST.has(f.rel))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('palette allowlist entries still offend (ratchet: remove cleaned files)', () => {
    const stale = [...PALETTE_ALLOWLIST].filter((rel) => {
      const f = files.find((x) => x.rel === rel);
      return !f || !RAW_PALETTE.test(f.body);
    });
    expect(stale).toEqual([]);
  });

  it('no new off-scale text sizes outside the allowlist', () => {
    const offenders = files
      .filter((f) => OFF_SCALE_TEXT.test(f.body) && !TEXT_ALLOWLIST.has(f.rel))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('text allowlist entries still offend (ratchet)', () => {
    const stale = [...TEXT_ALLOWLIST].filter((rel) => {
      const f = files.find((x) => x.rel === rel);
      return !f || !OFF_SCALE_TEXT.test(f.body);
    });
    expect(stale).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it** (`npx vitest run src/__tests__/design-system-gate.test.ts`). Expected: PASS with the pasted allowlists. If an offender list mismatches, regenerate the Step 1 lists (Tasks 5–7 may have cleaned files) and re-paste.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/design-system-gate.test.ts
git commit -m 'test(design): Add raw-palette and type-scale ratchet gates

Vitest gate scanning src/components: new files cannot introduce raw
Tailwind palette colors or off-scale text sizes; existing offenders
are allowlisted and the gate fails when an entry cleans up, forcing
allowlist shrinkage as recomposition phases land.

Co-Authored-By: Claude <noreply@anthropic.com>' && git push origin main
```

---

### Task 9: Phase-end full verification + review

- [ ] **Step 1:** Check `git status` — if the parallel session's `api/` WIP is still uncommitted, run the scoped checks only (`npx tsc --noEmit && npx eslint src --max-warnings=0 && npx vitest run src && npm run build`) and note in the report that full `npm run review` was skipped to avoid reformatting another session's WIP. If the tree is otherwise clean, run `npm run review` in full.
- [ ] **Step 2:** Dispatch the `code-reviewer` agent over the Phase 0 commit range (`git log --oneline` since the plan's first commit) per the project loop; apply `continue` feedback before declaring the phase done.
- [ ] **Step 3:** Screenshot pass in both themes (production after deploy) — confirm feed toolbars are legible in light mode and no layout regressions from the type remap.
