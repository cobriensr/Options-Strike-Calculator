---
status: In progress
date: 2026-05-17
---

# Refactor: Standardize filter toolbar chips (Lottery + Silent Boom)

**Date:** 2026-05-17
**Status:** In progress

## Goal

Eliminate duplicated chip styling and chip-button JSX between
`LotteryFinderSection.tsx` and `SilentBoomSection.tsx`. After this
refactor, contrast/spacing/color tweaks (like the one just shipped in
`72c3f8db`) are a one-file edit, and new filter chips drop in as
`<FilterChip />` instead of repeating the same className template
~60 times across two files.

## Scope

**In scope:**

- `LotteryFinderSection.tsx` filter toolbar (~50 chip call sites)
- `SilentBoomSection.tsx` filter toolbar (~40 chip call sites)
- Shared tokens + a single `<FilterChip />` primitive

**Explicitly out of scope:**

- `src/components/ui/Chip.tsx` — different design family (pill,
  44px touch, theme tokens). Used by `AdvancedSection`. Leave alone.
- `<FilterRow>` primitive — the per-row `<div className="flex flex-wrap items-center gap-1.5">…<span={SECTION_LABEL}>…</span>…</div>`
  pattern is heterogeneous enough that a row component would just be a
  thin wrapper over a flex div. Skipping — the raw div composes fine.
- `<TimeStepper>` primitive — date input + ±step buttons + "all day"
  toggle has too much variation between the two panels (1m vs 5m step,
  "All day" vs "all bucket" label, pick dropdown shape). Worth its own
  spec if we go there, not bundled here.
- Ticker wall restructuring — separate concern (search-vs-display
  split). Discussed but deferred.
- A11y semantics changes — preserve existing `aria-pressed` /
  `aria-label` patterns even where radio-group semantics would be more
  correct. Refactor, not redesign.

## Approach

Two phases. Each phase is independently shippable + committable.

### Phase 1 — Tokens extraction (zero behavior change)

Move the byte-identical constants out of both consumer files into one
shared module.

**New file:** `src/components/ui/filter-toolbar-tokens.ts`

Exports:

- `FILTER_CHIP_BASE` — base classes (flex layout, padding, font, transition)
- `FILTER_CHIP_INACTIVE` — neutral palette default state
- `FILTER_CHIP_ACTIVE` — record keyed by color name, returning class string
- `FilterChipColor` — exported union type matching `FILTER_CHIP_ACTIVE` keys
- `SECTION_LABEL` — small uppercase label class
- `TOOLBAR_DIVIDER` — vertical hairline class

**Modified files:**

- `LotteryFinderSection.tsx` — delete local const definitions, import
  from shared module. Zero JSX changes.
- `SilentBoomSection.tsx` — same.

**Verification:** `npm run lint` + visual check on both panels.

### Phase 2 — `<FilterChip />` primitive + migrate both panels

**New file:** `src/components/ui/FilterChip.tsx`

```tsx
import type { ReactNode } from 'react';
import {
  FILTER_CHIP_BASE,
  FILTER_CHIP_INACTIVE,
  FILTER_CHIP_ACTIVE,
  type FilterChipColor,
} from './filter-toolbar-tokens';

interface FilterChipProps {
  /** Visual + a11y active state. When true, applies `activeColor`. */
  active?: boolean;
  /** Color palette when `active` is true. Required if `active` may be true. */
  activeColor?: FilterChipColor;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  /** Pass-through. Omitted when undefined — caller decides if a11y semantics apply. */
  ariaPressed?: boolean;
  ariaLabel?: string;
  /** Pass-through for Playwright / vitest selectors. */
  testId?: string;
  /** Escape hatch for one-off classes (rare). */
  className?: string;
  children: ReactNode;
}

export function FilterChip({
  active = false,
  activeColor,
  onClick,
  disabled,
  title,
  ariaPressed,
  ariaLabel,
  testId,
  className,
  children,
}: FilterChipProps): JSX.Element {
  const stateClass =
    active && activeColor
      ? FILTER_CHIP_ACTIVE[activeColor]
      : FILTER_CHIP_INACTIVE;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={ariaPressed}
      aria-label={ariaLabel}
      data-testid={testId}
      className={`${FILTER_CHIP_BASE} ${stateClass}${className ? ` ${className}` : ''}`}
    >
      {children}
    </button>
  );
}
```

**Test file:** `src/__tests__/ui/FilterChip.test.tsx`

Covers: renders children, click fires, active+color applies CHIP_ACTIVE
class, inactive applies CHIP_INACTIVE class, disabled blocks click,
ariaPressed only set when prop provided, testId passes through.

**Modified files:**

- `LotteryFinderSection.tsx` — replace all chip-button `<button>` blocks
  with `<FilterChip>`. The local `disabled:hover:border-neutral-700
  disabled:hover:text-neutral-300` overrides on stepper buttons fold
  into `FILTER_CHIP_INACTIVE` so the override is always present (no-op
  unless `disabled`).
- `SilentBoomSection.tsx` — same.

**Verification:** `npm run review` (tsc + eslint + prettier + vitest).
Visual check on both panels.

## Files touched

| Phase | File                                          | New / Modified |
| ----- | --------------------------------------------- | -------------- |
| 1     | `src/components/ui/filter-toolbar-tokens.ts`  | New            |
| 1     | `src/components/LotteryFinder/LotteryFinderSection.tsx` | Modified |
| 1     | `src/components/SilentBoom/SilentBoomSection.tsx`       | Modified |
| 2     | `src/components/ui/FilterChip.tsx`            | New            |
| 2     | `src/__tests__/ui/FilterChip.test.tsx`        | New            |
| 2     | `src/components/LotteryFinder/LotteryFinderSection.tsx` | Modified |
| 2     | `src/components/SilentBoom/SilentBoomSection.tsx`       | Modified |

## Open questions

- **`ariaPressed` default behavior** — Default to `active` so radio-group
  buttons get correct semantics for free, or require explicit pass so
  caller is in control? Current draft: explicit pass (`undefined` = no
  attribute). Matches existing behavior where stepper buttons don't set
  `aria-pressed`. Could flip to auto-derive if we'd rather standardize.
- **Disabled-state hover override placement** — Bake `disabled:opacity-40
  disabled:hover:border-neutral-700 disabled:hover:text-neutral-300` into
  `FILTER_CHIP_INACTIVE` (always present, no-op when not disabled) or
  leave callers to opt in via `className`? Current draft: bake in. Less
  code at call sites, no observable downside.

## Risk

Low. Phase 1 is mechanical. Phase 2 replaces ~90 button instances with
a single component — the per-instance translation is straightforward
(`active`, `activeColor`, `onClick`, `title`, optional `aria-pressed`).
Visual regression is the main risk; the unit test + a side-by-side
screen check before commit covers it.
