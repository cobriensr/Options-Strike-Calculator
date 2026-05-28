# TAKE-IT-Conditioned Gate Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Files here are large and live (parallel sessions edit them) — RE-READ each file before editing and locate documented anchors rather than trusting line numbers.

**Goal:** Make the Silent Boom counter-tide tier3 override conditional on TAKE-IT — exempt `takeit_prob >= 0.70` from the demotion so high-conviction counter-tide fires keep their real tier; everything below 0.70 stays gated.

**Architecture:** In `api/cron/detect-silent-boom.ts`, compute TAKE-IT BEFORE the final tier decision but feed it the **gate-applied** tier (`directionGated ? 'tier3' : tier`) as a feature so model parity with training is preserved. Then apply a conditional: if `directionGated && takeitProb != null && takeitProb >= 0.70`, the final inserted `score_tier` is the original pre-gate `tier`; otherwise it's the gate-applied tier (tier3 when gated, original otherwise). The UI derives "tier-preserved" from `directionGated && scoreTier !== 'tier3'` — no new backend field needed. A new shared constant `TAKEIT_GATE_EXEMPT_MIN_PROB = 0.7` lives in `api/_lib/takeit-score.ts` as the single source of truth.

**Tech Stack:** Vercel Functions (TS, Node 24), Neon Postgres, Vitest, React 19, Tailwind 4.

**Reference spec:** `docs/superpowers/specs/2026-05-27-takeit-conditioned-gate-fix-design.md`

**Phases:**
- **Phase 1 (backend, 3 files):** gate logic + constant + cron test cases
- **Phase 2 (frontend, 2 files):** Silent Boom Gated-pill variant for tier-preserved state
- **Phase 3 (optional):** historical backfill of `score_tier` for `direction_gated = true AND takeit_prob >= 0.70` rows — deferred; flag-only plan reference

**Constants (defined in Task 1):**

- `TAKEIT_GATE_EXEMPT_MIN_PROB = 0.7` (exported from `api/_lib/takeit-score.ts`)

---

## PHASE 1 — Backend gate logic + tests

### Task 1: Export the shared TAKE-IT exemption threshold constant

**Files:**
- Modify: `api/_lib/takeit-score.ts` (add an export near the top of the file with the other config-style exports)

- [ ] **Step 1: Add the constant**

Add this export near the top of the file, after the existing imports and any existing exported constants (e.g. near `BundleSchemaError`):

```ts
/**
 * Minimum calibrated TAKE-IT probability that exempts a direction-gated
 * Silent Boom alert from the tier3 override. Set at 0.70 — the empirical
 * crossover where gated fires perform as well as ungated peers (mean trail
 * +0.4% vs −4.5%) per the gate-fix design doc:
 *   docs/superpowers/specs/2026-05-27-takeit-conditioned-gate-fix-design.md
 * Below this threshold the gate continues to correctly suppress losers.
 */
export const TAKEIT_GATE_EXEMPT_MIN_PROB = 0.7;
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx eslint api/_lib/takeit-score.ts`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add api/_lib/takeit-score.ts && git commit -m "feat(takeit): export TAKEIT_GATE_EXEMPT_MIN_PROB constant"
```

---

### Task 2: TAKE-IT-conditioned gate in detect-silent-boom

**Files:**
- Modify: `api/cron/detect-silent-boom.ts` (reorganize gate-tier computation around the existing line ~745–795 region — re-read for exact lines)
- Test: `api/__tests__/detect-silent-boom.test.ts` (add three new cases modeled on the existing direction-gate test ~line 636–680)

**The change in 3 lines of intent:**
1. Keep computing `directionGated` exactly as today.
2. Compute a `gateAppliedTier = directionGated ? 'tier3' : tier` value, build the TAKE-IT row with `score_tier: gateAppliedTier` (matches training-time distribution), and run `scoreSilentBoom(...)` to get `takeitProb` — BEFORE the final tier is set.
3. The final `effectiveTier` written to the INSERT is `(directionGated && takeitProb != null && takeitProb >= TAKEIT_GATE_EXEMPT_MIN_PROB) ? tier : gateAppliedTier`. The `direction_gated` flag itself stays `true` (preserved for audit/display).

**Re-read the file first.** Find the exact current shape of these three blocks: (a) the direction-gate computation (~745–763), (b) the `const effectiveTier = directionGated ? 'tier3' : tier;` line (~763), (c) the TAKE-IT computation that builds `takeitRow` and calls `scoreSilentBoom` (~765–795). The line numbers will drift — locate by code shape.

- [ ] **Step 1: Write the failing tests**

Add three new tests to `api/__tests__/detect-silent-boom.test.ts`, modeled on the existing case that asserts `binds.get('score_tier') === 'tier3'` for a gated PUT. The mock pattern is `mockSql.mockResolvedValueOnce(...)` chained; reuse the `extractInsertBinds(mockSql, 'silent_boom_alerts')` helper that already exists in the test file.

Override the existing top-level `vi.mock('../_lib/takeit-detect.js', ...)` mock per-test using `vi.mocked(...).mockImplementationOnce(...)` (or whatever scoping pattern the rest of the test file uses for per-test mock overrides — check the existing tests). If `scoreSilentBoom` is currently mocked to always return `{ prob: null, ... }`, you'll need to override it per-test for the high-takeit case.

```ts
it('preserves original score_tier when gated AND takeit_prob >= 0.70', async () => {
  // Reuse the put-counter-trend fixture from the existing direction-gate test:
  // PUT fire with mkt_tide_diff = +150M → directionGated=true. Build a score
  // high enough that pre-gate tier is tier2 (>= 8). Override scoreSilentBoom
  // to return prob: 0.78 (above TAKEIT_GATE_EXEMPT_MIN_PROB).
  vi.mocked(scoreSilentBoom).mockReturnValueOnce({
    prob: 0.78,
    version: 'test',
    features: { dummy: 0 },
  });
  // ...set up the same 9-call mockSql chain as the existing test...
  const req = mockRequest({ /* same shape */ });
  const res = mockResponse();
  await handler(req, res);
  const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
  expect(binds.get('direction_gated')).toBe(true); // flag preserved
  expect(binds.get('score_tier')).not.toBe('tier3'); // tier NOT demoted
  expect(binds.get('takeit_prob')).toBe(0.78);
});

it('still demotes to tier3 when gated AND takeit_prob < 0.70', async () => {
  vi.mocked(scoreSilentBoom).mockReturnValueOnce({
    prob: 0.6,
    version: 'test',
    features: { dummy: 0 },
  });
  // ...same setup...
  const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
  expect(binds.get('direction_gated')).toBe(true);
  expect(binds.get('score_tier')).toBe('tier3');
});

it('still demotes to tier3 when gated AND takeit_prob is null (no exemption on null)', async () => {
  vi.mocked(scoreSilentBoom).mockReturnValueOnce({
    prob: null,
    version: null,
    features: null,
  });
  // ...same setup...
  const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
  expect(binds.get('direction_gated')).toBe(true);
  expect(binds.get('score_tier')).toBe('tier3');
});
```

If `vi.mocked(scoreSilentBoom)` doesn't work because the import is mocked at module-factory scope (the existing mock uses a literal `() => ({...})`), you'll need to switch to `vi.fn()` shapes so per-test `.mockReturnValueOnce(...)` overrides are possible. The minimum-change approach: edit the top-level `vi.mock` factory to expose `scoreSilentBoom: vi.fn().mockReturnValue({ prob: null, version: null, features: null })` instead of an arrow function, then call `vi.mocked(scoreSilentBoom).mockReturnValueOnce(...)` in each new test. Update any other test that needs the default behavior to use `vi.mocked(scoreSilentBoom).mockReturnValue(...)` in `beforeEach` if necessary — but only if existing tests start failing.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run api/__tests__/detect-silent-boom.test.ts`
Expected: the new "preserves score_tier" test FAILS (asserts `score_tier !== 'tier3'`, but current code unconditionally sets it to tier3 when gated). The two demotion tests may already pass (current behavior is also tier3 for those cases) — that's expected; they're regression guards.

- [ ] **Step 3: Add the import**

In `api/cron/detect-silent-boom.ts`, near the other `_lib` imports, add:

```ts
import { TAKEIT_GATE_EXEMPT_MIN_PROB } from '../_lib/takeit-score.js';
```

- [ ] **Step 4: Restructure the gate-tier-takeit block**

Re-read the current ~745–795 region of the file. The current shape (paraphrased):

```ts
// existing: ~745-762
const directionGated = (() => { /* mkt_tide_diff ±100M */ })();
// existing: 763
const effectiveTier = directionGated ? 'tier3' : tier;
// existing: ~765-795
const takeitRow: SilentBoomAlertRow = { /* ..., */ score_tier: effectiveTier, direction_gated: directionGated };
const { prob: takeitProb, version: takeitVersion, features: takeitFeatures } = scoreSilentBoom(takeitCtx, takeitRow);
```

Restructure to:

```ts
const directionGated = (() => { /* unchanged mkt_tide_diff ±100M check */ })();

// Gate-applied tier matches what the TAKE-IT model was trained on (post-gate),
// so feed THIS to scoreSilentBoom — never the raw `tier` — to preserve parity.
const gateAppliedTier: SilentBoomScoreTier = directionGated ? 'tier3' : tier;

const takeitRow: SilentBoomAlertRow = {
  /* unchanged fields ... */
  score,
  score_tier: gateAppliedTier,
  direction_gated: directionGated,
};
const {
  prob: takeitProb,
  version: takeitVersion,
  features: takeitFeatures,
} = scoreSilentBoom(takeitCtx, takeitRow);

// TAKE-IT-conditioned gate exemption (spec:
// docs/superpowers/specs/2026-05-27-takeit-conditioned-gate-fix-design.md):
// when a fire is direction-gated AND TAKE-IT >= the exemption threshold,
// keep the original pre-gate tier (the gate is pure downside above 0.70
// per the calibration). Otherwise apply the standard gate-applied tier.
// `direction_gated` itself stays true on the row so the UI/audit can still
// see the gate fired.
const effectiveTier: SilentBoomScoreTier =
  directionGated &&
  takeitProb != null &&
  takeitProb >= TAKEIT_GATE_EXEMPT_MIN_PROB
    ? tier
    : gateAppliedTier;
```

Note: `SilentBoomScoreTier` is the existing type alias for the tier strings — re-use whatever name the file's existing `tier` variable uses (likely already typed correctly via `silentBoomScoreTier()`'s return). Replace the inline type annotation if a different name is in use.

- [ ] **Step 5: Run tests**

Run: `npx vitest run api/__tests__/detect-silent-boom.test.ts`
Expected: all tests pass (the three new ones plus the entire pre-existing suite).

- [ ] **Step 6: Run typecheck + lint**

Run: `npx tsc --noEmit && npx eslint api/cron/detect-silent-boom.ts api/__tests__/detect-silent-boom.test.ts`
Expected: clean. If the lint complains about an unused `tier` variable (because `gateAppliedTier` is now the primary use), keep both — `tier` is still referenced in the exemption branch.

- [ ] **Step 7: Commit**

```bash
git add api/cron/detect-silent-boom.ts api/__tests__/detect-silent-boom.test.ts && git commit -m "feat(silent-boom): TAKE-IT-conditioned gate exemption (>=0.70 preserves tier)"
```

---

## PHASE 2 — Frontend: tier-preserved Gated-pill variant

### Task 3: Soft-gate Gated-pill variant in SilentBoomRow

**Files:**
- Modify: `src/components/SilentBoom/SilentBoomRow.tsx` (the `gatedPill()` factory ~lines 164–169 and the JSX ~lines 520–529 — re-read for exact lines)
- Test: `src/__tests__/SilentBoomRow.test.tsx` (extend the existing direction-gate-pill describe block at ~lines 311–325)

**Derivation:** an alert is "tier-preserved" (soft-gated) when `directionGated === true` AND `scoreTier !== 'tier3'`. After the Phase 1 fix, this is true iff TAKE-IT was ≥0.70 at detect time and the original tier was non-tier3. The UI doesn't need to read `takeitProb` directly — `scoreTier` already carries the resolution.

**Scope decision:** Lottery's `LotteryRow.tsx` is NOT touched in this plan. The lottery gate uses a different mechanism (display-tier override at the feed endpoint, not detect-time tier3 overwrite). Its symmetric treatment is in the gate-fix spec's "Scope decisions" section as deferred — not in this plan.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/SilentBoomRow.test.tsx`, inside the existing `describe('SilentBoomRow: direction-gate pill', ...)` block, add:

```ts
it('renders a "Soft" gated pill when directionGated is true AND scoreTier is non-tier3', () => {
  renderRow(makeAlert({ directionGated: true, scoreTier: 'tier2' }));
  const pill = screen.getByTestId('silent-boom-gated-pill');
  expect(pill).toBeInTheDocument();
  expect(pill).toHaveTextContent(/Gated.*Soft/);
  expect(pill.getAttribute('title')).toMatch(/TAKE-IT|conviction|preserved/i);
});

it('renders the standard "Gated" pill when directionGated is true AND scoreTier is tier3', () => {
  renderRow(makeAlert({ directionGated: true, scoreTier: 'tier3' }));
  const pill = screen.getByTestId('silent-boom-gated-pill');
  expect(pill).toBeInTheDocument();
  expect(pill).toHaveTextContent('Gated');
  // The pill should NOT have the soft-gate suffix
  expect(pill).not.toHaveTextContent(/Soft/);
});
```

If `makeAlert` doesn't already accept `scoreTier` overrides, check the factory in the test file — the existing tests must already set it somewhere because tier display is a core feature. Most likely `makeAlert({ scoreTier: 'tier2' })` already works via the existing `Partial<SilentBoomAlert>` override spread.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/SilentBoomRow.test.tsx`
Expected: the new "Soft" test FAILS (current pill always says "Gated"). The standard-Gated test should still pass.

- [ ] **Step 3: Update the `gatedPill()` factory + JSX**

In `src/components/SilentBoom/SilentBoomRow.tsx`, change the factory signature to take a boolean for the soft-gate case:

```ts
const gatedPill = (
  tierPreserved: boolean,
): { label: string; cls: string; tooltip: string } => {
  if (tierPreserved) {
    return {
      label: 'Gated (Soft)',
      cls: 'border-amber-500/60 bg-amber-950/40 text-amber-200',
      tooltip:
        'Counter-trend per Market Tide at fire time, but TAKE-IT ≥ 0.70 ' +
        'preserved the original tier. The gate flag is retained for audit; ' +
        'conviction was high enough to exempt this fire from the tier3 ' +
        'demotion (T=±100M on mkt_tide_diff).',
    };
  }
  return {
    label: 'Gated',
    cls: 'border-amber-500/60 bg-amber-950/40 text-amber-200',
    tooltip:
      'Counter-trend per Market Tide at fire time — demoted to tier3 by the ' +
      'direction gate (T=±100M on mkt_tide_diff). Score is preserved on the ' +
      'row; only the displayed tier is forced down.',
  };
};
```

In the component body, derive `tierPreserved` from the alert and pass it in:

```tsx
const tierPreserved = alert.directionGated && alert.scoreTier !== 'tier3';
const gated = alert.directionGated ? gatedPill(tierPreserved) : null;
```

(Substitute whatever the row's actual prop name for the alert is — `alert`, `row`, etc. — and whatever variable currently holds the gated-pill struct.)

The JSX block that renders the span stays identical except it now picks up the new label/tooltip when `tierPreserved` is true.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/SilentBoomRow.test.tsx`
Expected: all pass (the two new tests plus the entire pre-existing suite).

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint src/components/SilentBoom/SilentBoomRow.tsx src/__tests__/SilentBoomRow.test.tsx`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/SilentBoom/SilentBoomRow.tsx src/__tests__/SilentBoomRow.test.tsx && git commit -m "feat(silent-boom): Soft Gated pill variant for tier-preserved fires"
```

---

## Final verification (after all tasks)

- [ ] Run the full project gate: `npm run review` (tsc + eslint + prettier + vitest --coverage). Fix any new failures.
- [ ] Optional smoke check: after deploy, watch the next active counter-tide fire (puts when `mkt_tide_diff > +100M` or calls when `< −100M`) — confirm it now lands at its real tier (tier1/tier2) when `takeit_prob >= 0.70`, and at tier3 when below. The Silent Boom feed should still render a Gated pill on these rows; high-TAKE-IT ones now read "Gated (Soft)" instead of "Gated".

## Out of scope (deferred to a follow-up if you want it later)

- **Lottery gate symmetry.** Lottery's display-tier override is at the feed endpoint, not at detect time; its harm is near-zero per the spec, so it's not touched here. If desired later: apply the same `takeit_prob >= TAKEIT_GATE_EXEMPT_MIN_PROB` exemption to the lottery feed's display down-rank.
- **Historical backfill (Phase 3 from the spec).** A one-off script could `UPDATE silent_boom_alerts SET score_tier = silentBoomScoreTier(score) WHERE direction_gated = true AND takeit_prob >= 0.7 AND score_tier = 'tier3'` so backtests/feed history reflect the new policy. Forward-only is fine; flag this as optional.
- **TAKE-IT chip frontend constant share.** Tasks 6/7 of the cluster build hardcoded `0.7` in `TAKEIT_FLOOR_OPTIONS`. After this plan, the canonical constant lives in `api/_lib/takeit-score.ts`. A future cleanup can re-export it through a frontend-safe location and have both feeds import from there.
