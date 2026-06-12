# Frontend Recomposition — Phase 5 Implementation Plan (DataUnavailable + Nav Grouping + Light-Ink Audit)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw error-string rendering with a shared `DataUnavailable` component across all read-path panels, extract a shared `SkeletonRows` shimmer, group the sidebar nav by registry group, and run the light-mode AA ink audit — per Phase 5 of the rev-2 recomposition spec (executed after Phases 0–2, before 3/4).

**Architecture (grounded in the scout findings):** Hook error state is uniformly `error: string | null`; 401s are swallowed inside hooks before reaching state (`return null` / `needsAuth` flag), and **no 403 handling exists anywhere** — guests hitting owner/bot-gated endpoints today see `Error: HTTP 403` rendered raw. Rather than refactoring ~21 hooks, a central `classifyHttpError(error)` maps the error STRING to a `DataUnavailable` kind (`/\b40[13]\b/` → `auth`). This is deliberately the single fragile string-sniff in the codebase (replacing ad-hoc sniffs like `useVixData.ts:127`); typed status propagation (the `useGreekHeatmap` `HttpError` pattern) is Phase 7+ work. **Scope: read-path data panels only** — CRUD/mutation feedback (PeriscopeChat saves, AccessKeyModal login) keeps inline messages.

**Tech Stack:** React 19, Tailwind 4 tokens (post-Phase-0 semantics), Vitest + Testing Library.

**Execution-environment rules:** Same as prior phase plans (scoped verification, surgical git add, single-quoted commits, push per commit).

---

### Task 1: `DataUnavailable` + `classifyHttpError`

**Files:**
- Create: `src/components/ui/DataUnavailable.tsx` (+ barrel export in `ui/index.tsx`)
- Test: `src/components/ui/__tests__/DataUnavailable.test.tsx`

- [ ] **Step 1: Failing test:**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  DataUnavailable,
  classifyHttpError,
} from '../DataUnavailable';

describe('classifyHttpError', () => {
  it('maps 401/403 to auth, everything else to error', () => {
    expect(classifyHttpError('HTTP 403')).toBe('auth');
    expect(classifyHttpError('gex-landscape: HTTP 401')).toBe('auth');
    expect(classifyHttpError('HTTP 500')).toBe('error');
    expect(classifyHttpError('Failed to fetch')).toBe('error');
    expect(classifyHttpError(null)).toBe('error');
  });
});

describe('DataUnavailable', () => {
  it('auth: muted sign-in copy, no alert role, no raw detail', () => {
    render(<DataUnavailable kind="auth" detail="HTTP 403" />);
    expect(screen.getByText('Sign in for live data')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('HTTP 403')).toBeNull();
  });

  it('error: alert role, retry copy, detail demoted below headline', () => {
    render(<DataUnavailable kind="error" detail="HTTP 500" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Data unavailable — retrying');
    expect(screen.getByText('HTTP 500')).toBeInTheDocument(); // present, small
  });

  it('window: custom copy via title', () => {
    render(
      <DataUnavailable kind="window" title="Auto-updates 08:25–08:50 CT" />,
    );
    expect(
      screen.getByText('Auto-updates 08:25–08:50 CT'),
    ).toBeInTheDocument();
  });

  it('empty: neutral domain copy', () => {
    render(<DataUnavailable kind="empty" title="No fires yet today" />);
    expect(screen.getByText('No fires yet today')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
```

- [ ] **Step 2: Run — FAIL.** Then implement `src/components/ui/DataUnavailable.tsx`:

```tsx
import { memo, type ReactNode } from 'react';

export type DataUnavailableKind = 'auth' | 'error' | 'window' | 'empty';

/**
 * Maps a hook error STRING to a DataUnavailable kind. The single
 * sanctioned status-sniff: 401/403 (auth/bot-gated endpoints) read as
 * "sign in", everything else as a transient failure. Hooks that
 * preserve numeric status (useGreekHeatmap's HttpError) should branch
 * on it directly instead of calling this.
 */
export function classifyHttpError(
  error: string | null | undefined,
): Extract<DataUnavailableKind, 'auth' | 'error'> {
  return error && /\b40[13]\b/.test(error) ? 'auth' : 'error';
}

const COPY: Record<DataUnavailableKind, { glyph: string; title: string }> = {
  auth: { glyph: '\u{1F512}', title: 'Sign in for live data' },
  error: { glyph: '⚠', title: 'Data unavailable — retrying' },
  window: { glyph: '⏱', title: 'Outside the update window' },
  empty: { glyph: '—', title: 'No data for this session' },
};

/**
 * DataUnavailable — the shared degraded-state block for read-path data
 * panels. Replaces raw `Error: HTTP 403` rendering (33-site sweep, see
 * the 2026-06-11 design review S3). Auth/window/empty are calm (dashed
 * inset, muted); only `error` is an alert, in caution amber — panels
 * poll, so failures are usually transient.
 */
export const DataUnavailable = memo(function DataUnavailable({
  kind,
  title,
  detail,
  action,
  className,
}: {
  kind: DataUnavailableKind;
  /** Override headline (domain copy like "No fires yet today"). */
  title?: string;
  /** Technical detail (the raw error) — rendered 10px muted, never the
   *  headline. Omitted entirely for `auth`. */
  detail?: string;
  /** Optional action slot (e.g. a sign-in link, a retry button). */
  action?: ReactNode;
  className?: string;
}) {
  const isError = kind === 'error';
  const headline = title ?? COPY[kind].title;
  return (
    <div
      role={isError ? 'alert' : undefined}
      className={
        (isError
          ? 'border-caution/40 bg-caution/8 rounded-lg border px-4 py-3'
          : 'border-edge-strong rounded-lg border-2 border-dashed px-4 py-5 text-center') +
        (className ? ` ${className}` : '')
      }
    >
      <div
        className={
          'font-sans text-md ' +
          (isError ? 'text-caution font-semibold' : 'text-secondary')
        }
      >
        <span aria-hidden="true" className="mr-1.5">
          {COPY[kind].glyph}
        </span>
        {headline}
      </div>
      {detail && kind !== 'auth' && (
        <div className="text-muted mt-1 font-mono text-xs">{detail}</div>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
});
```

Barrel-export both from `ui/index.tsx`. Note `bg-caution/8` requires Tailwind 4 color-mix opacity on the token — verify it compiles in `npm run build`; if the scanner rejects it, use `bg-caution/10`.

- [ ] **Step 3: Run test — PASS. Commit** (`feat(ui): Add DataUnavailable degraded-state component + classifyHttpError`).

---

### Task 2: `SkeletonRows` extraction

**Files:**
- Create: `src/components/ui/SkeletonRows.tsx` (+ barrel export)
- Modify: `src/components/DarkPoolLevels/index.tsx:293-316` (adopt)
- Test: assertion inside the DataUnavailable test file or a 10-line sibling test.

- [ ] **Step 1:** Implement (extracted verbatim from DarkPoolLevels' shimmer, parameterized):

```tsx
import { memo } from 'react';

const WIDTH_CYCLE = ['100%', '92%', '78%', '88%'] as const;

/** Shimmer rows matching list/table-row shape — the shared loading
 *  body for data panels (extracted from DarkPoolLevels). */
export const SkeletonRows = memo(function SkeletonRows({
  rows = 8,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div
      aria-busy="true"
      className={'flex flex-col gap-2' + (className ? ` ${className}` : '')}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="bg-surface-alt h-3 animate-pulse rounded"
          style={{
            width: WIDTH_CYCLE[i % WIDTH_CYCLE.length],
            animationDelay: `${i * 60}ms`,
          }}
        />
      ))}
    </div>
  );
});
```

- [ ] **Step 2:** DarkPoolLevels' loading branch body becomes `<SkeletonRows rows={8} />` (keep its SectionBox wrapper + comment). Test: render + `expect(container.querySelector('[aria-busy]')).toBeTruthy()` with 5 rows → 5 bars.

- [ ] **Step 3: Run, commit** (`ref(ui): Extract SkeletonRows shimmer from DarkPoolLevels`).

---

### Task 3: Sweep — feeds + signal tiles (the dark-palette offenders)

**Files:** `src/components/LotteryFinder/index.tsx` (~1781-1790), `src/components/SilentBoom/index.tsx` (~1713-1723), `src/components/IntervalBAFeed/IntervalBAFeed.tsx` (~287-298), `src/components/OpeningFlowSignal/OpeningFlowSignal.tsx` (~94-101), `src/components/PinSetupTile/index.tsx` (~108-116)

These five render raw `{error}` in hardcoded dark-palette boxes (`red-950/30` etc.) — doubly broken (raw transport + light-mode-illegible).

- [ ] **Step 1:** In each, replace the error branch with the shared component. Canonical replacement (LotteryFinder shown; the other four are the same shape — keep each file's surrounding loading/empty branches untouched):

```tsx
) : error ? (
  <DataUnavailable kind={classifyHttpError(error)} detail={error} />
) : …
```

Import `{ DataUnavailable, classifyHttpError }` from the ui barrel (relative depth per file). For `PinSetupTile` (a small inline tile), pass `className="text-left px-3 py-2"` to keep it compact. For `OpeningFlowSignal`, its separate "outside the signal window" copy (the existing text below the error box) stays — that text is informational, not the error state; do NOT convert it to `kind="window"` in this task (it's already designed copy).

- [ ] **Step 2:** Grep each file for other raw renders of the same `error` variable (LotteryFinder/SilentBoom render per-chart errors inside expanded rows — `grep -n '{error' <file>`); convert read-path ones, leave mutation feedback.

- [ ] **Step 3: Run the feeds' tests + lint; commit** (`fix(design): Route feed/tile error states through DataUnavailable`).

---

### Task 4: Sweep — GEX family, tiles, charts, misc panels

**Files (error-branch line refs from the scout; re-grep before editing):**
`GexLandscape/index.tsx:422-430`, `ZeroGammaPanel/TickerCard.tsx:120-133`, `DealerRegimeTile/index.tsx:182-189`, `Tracker/index.tsx:167-172`, `MLInsights/index.tsx:171-181`, `FuturesCalculator/FuturesPanel.tsx:199-209`, `DarkPoolLevels/index.tsx:318-328`, plus the remaining read-path panels surfaced by:

```bash
grep -rn -E '\{error\}|\{String\(error\)\}' src/components --include='*.tsx' | grep -v __tests__
```

- [ ] **Step 1:** Same canonical replacement as Task 3. Panels that early-return a full SectionBox on error (GexLandscape, DarkPoolLevels) keep the SectionBox and swap only the inner error node. `useMarketData`-fed surfaces (no error string; `needsAuth` flag) are out of scope — already designed.

- [ ] **Step 2:** Special cases:
  - `ZeroGammaPanel/TickerCard` — per-ticker cards: `<DataUnavailable kind={classifyHttpError(error)} title={`${ticker} unavailable`} detail={error} className="px-3 py-2 text-left" />`.
  - `MLInsights` + `FuturesPanel` — their `tint(theme.red)` style-object boxes are replaced wholesale by the component (this also adds the missing `role="alert"`).
  - `useGreekHeatmap` consumers — it has typed `HttpError` with `.status`; branch `status === 401 || status === 403 ? 'auth' : 'error'` directly instead of `classifyHttpError`.

- [ ] **Step 3:** **ErrorBoundary** (`src/components/ErrorBoundary.tsx:46-49, 62-66`): both fallbacks stop printing `error.message`. Section fallback becomes SectionBox-shaped:

```tsx
import { SECTION_SHELL } from './ui/SectionBox';
…
      return (
        <div className={`${SECTION_SHELL.standard} mt-6 first:mt-0`} role="alert">
          <div className="text-tertiary mb-2 font-sans text-md font-bold tracking-[0.12em] uppercase">
            {this.props.label}
          </div>
          <DataUnavailable
            kind="error"
            title="This panel crashed — reload to retry"
          />
        </div>
      );
```

(Sentry already captures the exception; the raw message adds nothing for the user. Keep the top-level fallback's reload button, drop its `<pre>`.)

- [ ] **Step 4: Run affected tests, lint, build; commit** (`fix(design): Route panel + boundary error states through DataUnavailable`).

---

### Task 5: Sidebar nav grouping

**Files:**
- Modify: `src/components/SectionNav.tsx` (NavSection type + vertical render), `src/App.tsx:727-739` (push group)
- Test: `src/__tests__/components/SectionNav.test.tsx` (extend or create)

- [ ] **Step 1: Failing test:** render `<SectionNav orientation="vertical" sections={[{id:'a',label:'A',group:'Inputs'},{id:'b',label:'B',group:'Trading'}]} />` and assert both group headers appear (`screen.getByText('Inputs')`, `screen.getByText('Trading')`) and that links still render.

- [ ] **Step 2:** `NavSection` gains `group: string;`. App.tsx:734 pushes it (`list.push({ id, label, group });` — the group name is already in scope in that loop). Vertical branch: while mapping, emit a header whenever the group changes:

```tsx
        <div className="flex flex-col gap-0.5">
          {sections.map((s, i) => (
            <Fragment key={s.id}>
              {(i === 0 || sections[i - 1].group !== s.group) && (
                <div className="text-muted mt-3 px-3 pb-1 font-sans text-xs font-semibold tracking-[0.1em] uppercase first:mt-0">
                  {s.group}
                </div>
              )}
              <a … />
            </Fragment>
          ))}
        </div>
```

Horizontal orientation ignores `group` (unchanged). Scroll-spy untouched.

- [ ] **Step 3: Run, lint, commit** (`feat(design): Group the sidebar nav by panel group`).

---

### Task 6: Light-mode ink audit

**Files:**
- Create: `scripts/contrast-audit.mjs` (one-off, committed for re-runs)
- Modify: `src/index.css` light tokens (only those that fail)

- [ ] **Step 1:** Write the audit script (WCAG relative-luminance contrast of each light semantic token against its real surfaces):

```js
// scripts/contrast-audit.mjs — WCAG AA contrast audit of light-mode inks.
const TOKENS = {
  primary: '#1c1a15', secondary: '#4a4740', tertiary: '#5c5950',
  muted: '#6b665d', accent: '#1d4ed8', success: '#15803d',
  danger: '#b91c1c', caution: '#946a00', backtest: '#7c3aed',
  statusLive: '#15803d', statusScrubbed: '#946a00', statusStale: '#c2410c',
};
const SURFACES = { surface: '#ffffff', page: '#f4f1eb', surfaceAlt: '#edeae3', input: '#faf9f6' };
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
for (const [t, hex] of Object.entries(TOKENS))
  for (const [s, sh] of Object.entries(SURFACES)) {
    const r = ratio(hex, sh);
    console.log(`${r < 4.5 ? 'FAIL' : 'ok  '} ${t} on ${s}: ${r.toFixed(2)}`);
  }
```

- [ ] **Step 2:** Run `node scripts/contrast-audit.mjs`. For every FAIL at 11px+ body usage, darken the light token minimally until ≥4.5 (e.g. if `caution #946a00` fails on `surface-alt`, step toward `#7d5a00` and re-run). Record before→after pairs in the commit body. Do NOT touch dark tokens.

- [ ] **Step 3:** Also check the StatusBadge tinted-bg case: pills render `color` on `color-mix(color 9%, transparent)` over `surface` — effectively color on near-white; the token-on-surface row covers it.

- [ ] **Step 4: Verify + commit** (`fix(design): Darken light-mode inks failing WCAG AA (contrast audit)` with the before/after table in the body; include the script: `git add scripts/contrast-audit.mjs src/index.css`).

---

### Task 7: Phase-end verification + review

- [ ] **Step 1:** Scoped or full verification per tree state + `npm run build`.
- [ ] **Step 2:** Confirm the sweep is complete: `grep -rn 'Error: {error}' src/components` returns nothing, and `grep -rn -E '\{error\}' src/components --include='*.tsx' | grep -v __tests__ | grep -v Unavailable` hits only mutation-feedback sites (list them in the report).
- [ ] **Step 3:** `code-reviewer` agent over the Phase 5 commit range; apply feedback.
- [ ] **Step 4:** Manual check as a signed-out guest on production: gated panels must show "Sign in for live data" — zero raw `HTTP 403` anywhere. Screenshot both themes.
