---
status: Shipped
date: 2026-05-17
---

# Panel Visibility Preferences (per-identity)

**Date:** 2026-05-17
**Status:** Spec — ready for implementation

## Goal

Let the owner and each guest independently choose which of the ~27 main panels render on the home page, persisted server-side so prefs follow the identity across devices. Defaults to "show all panels" until the user makes a selection.

## Motivation

Guest user (`Wonce`) feedback: only uses 4–5 panels out of 27 and finds navigation tedious. Owner has the same latent need at a smaller scale. Existing prefs (e.g. dark mode in `useAppState`) use `localStorage` — that won't scope per guest key and won't travel across devices.

## Relationship to existing collapse system

The repo already has `CollapseAllContext` (`src/components/collapse-context.ts`) — a per-`SectionBox` "collapse body, keep header" mechanism with a global "collapse all / expand all" button in `AppHeader`. **This stays as-is.** The new feature is orthogonal: it removes a panel from the DOM entirely so its header isn't even rendered, persisted per-identity to the server. Both systems coexist; they answer different questions ("hide body for now" vs. "I never want to see this panel").

## Design decisions (locked)

| #   | Decision           | Locked-in choice                                                                                                                                                    |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Identity key       | `'owner'` sentinel for the cookie session; `sha256(guest_key)` for guests (never store raw guest keys)                                                              |
| 2   | Storage shape      | Single row per identity, `hidden_panels JSONB` deny-list (new panels auto-appear for everyone)                                                                      |
| 3   | Default state      | All panels visible until user toggles                                                                                                                               |
| 4   | Bootstrap strategy | **Revised** — see Open Questions; original "piggyback on auth-mode" idea is unworkable because `getAccessMode()` is cookie-only and no boot-time fetch exists today |

## Phases

### Phase 1 — Backend (DB + endpoint)

**Migration `id: 165`** in `api/_lib/db-migrations.ts`:

```sql
CREATE TABLE IF NOT EXISTS panel_prefs (
  identity TEXT PRIMARY KEY,
  hidden_panels JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Zod schema** in `api/_lib/validation/` (new file `panel-prefs.ts`, barrel-re-exported from `validation.ts`):

```ts
export const panelPrefsBodySchema = z.object({
  hiddenPanels: z.array(z.string().regex(/^sec-[a-z0-9-]+$/)).max(50),
});
```

**Endpoint** `api/panel-prefs.ts` — supports GET + PUT, modeled on `api/positions.ts`:

- `guardOwnerOrGuestEndpoint(req, res, done)` for auth + bot check
- Identity resolved server-side: if `isOwner(req)` → `'owner'`; else extract guest key from `sc-guest` cookie via `parseCookies(req)[GUEST_COOKIE]` → `sha256(key).digest('hex')`. Hashing utility lives in this handler (single use, no shared module needed).
- `GET` → `SELECT hidden_panels FROM panel_prefs WHERE identity = $1`; return `{ hiddenPanels: [] }` if no row
- `PUT` → `INSERT … ON CONFLICT (identity) DO UPDATE SET hidden_panels = $2, updated_at = now()` after `safeParse` + `respondIfInvalid`
- Rate limit on PUT: 20/min (same as `positions`)

**Test updates** in `api/__tests__/db.test.ts`:

- Add `{ id: 165 }` to applied-migrations mock (around line 593)
- Add `'#165: Create panel_prefs table…'` to expected-output list
- Bump SQL call count comments (migration 165 = 1 CREATE + 1 INSERT)

**New test** `api/__tests__/panel-prefs.test.ts` — mock `getDb`, cover:

- GET as owner → returns empty array on first call
- GET as guest → hashes key correctly, returns row
- PUT as owner → upserts
- PUT with malformed body → 400 via `respondIfInvalid`
- Unauthenticated → 401

**Files in Phase 1:**

- `api/_lib/db-migrations.ts` (modify — append migration 165)
- `api/__tests__/db.test.ts` (modify — extend mock + expected list)
- `api/_lib/validation/panel-prefs.ts` (new)
- `api/_lib/validation.ts` (modify — add barrel export)
- `api/panel-prefs.ts` (new)
- `api/__tests__/panel-prefs.test.ts` (new)
- `src/main.tsx` (modify — add `{ path: '/api/panel-prefs', method }` entries to `initBotId` protect array)

**Verification:** `npm run review` passes. Manual smoke: hit `/api/panel-prefs` GET as owner via dev server → `{hiddenPanels:[]}`; PUT a list → GET returns it.

---

### Phase 2 — Frontend hook + section gating

**New hook** `src/hooks/usePanelPrefs.ts`:

```ts
type PanelPrefs = {
  hiddenPanels: Set<string>;
  isHidden: (id: string) => boolean;
  toggle: (id: string) => void;
  isLoaded: boolean;
};
```

- On mount: `GET /api/panel-prefs` (skip if `getAccessMode() === 'public'` — public visitors never persist)
- Toggle: optimistic local update + debounced PUT (500ms trailing)
- Error handling: on PUT failure, revert local state + Sentry capture

**Wrap each panel** in `src/App.tsx` (lines 799–1241): each `<div id="sec-*">` wrapper becomes a visibility check. Example for Pre-Market Signals (lines 842–857):

```tsx
{!panelPrefs.isHidden('sec-premarket') && (
  <div id="sec-premarket" className="mt-6 scroll-mt-28">
    <SectionBox label="Pre-Market Signals">…</SectionBox>
    {market.hasData && <PreMarketInput … />}
  </div>
)}
```

Hiding `sec-premarket` removes the entire wrapper — both the `SectionBox` AND the conditional `<PreMarketInput>` go away together, which matches user expectation ("hide that whole strip").

The existing `id="sec-*"` attributes ARE the canonical panel IDs — no new identifiers needed. Conditional sections (e.g., `hasMarketContext &&`) stay; user hide is AND'd with the existing gate.

**Loading state:** to avoid flash-of-all-panels on returning users with hides set:

- Public visitors: render immediately (no fetch, no prefs)
- Owner/guest: gate the main grid wrapper on `panelPrefs.isLoaded` (skeleton or a 50ms delay before grid mounts). The auth-resolution path already incurs perceptible latency, so this won't add a new "loading" feel.

**Files in Phase 2:**

- `src/hooks/usePanelPrefs.ts` (new)
- `src/hooks/__tests__/usePanelPrefs.test.tsx` (new)
- `src/App.tsx` (modify — wrap each section in visibility check)

**Verification:** `npm run review` passes. Dev server: toggle a panel via DevTools (PUT to `/api/panel-prefs`) → reload → that panel is hidden. Toggle via second browser as guest → owner's view unaffected.

---

### Phase 3 — UI affordance

**Gear icon in `src/components/AppHeader.tsx`** — add next to dark-mode toggle, same button styling (`border-edge-strong bg-surface hover:bg-surface-alt`). Opens modal.

**New `src/components/PanelPrefsModal/PanelPrefsModal.tsx`** — built on the `AccessKeyModal` pattern (portal + backdrop + `bg-surface border-edge-strong rounded-xl`):

- Title: "Show/Hide Panels"
- Body: list of all panels (label + checkbox), one row each
- Each row uses the existing `TOGGLE_CHIP_BASE` pattern from `AdvancedSection.tsx` for consistency
- Checkbox state: derived from `panelPrefs.isHidden(id)` (inverted: checked = visible)
- onChange → `panelPrefs.toggle(id)`
- "Reset to all visible" link at the bottom

**Panel registry — reuse existing `navSections`.** `src/App.tsx` lines 644–694 already defines a `navSections` array of `{ id, label }` pairs with the exact stable IDs and labels we need, **including conditional gating** (e.g., `isAuthenticated && hasMarketOrSnapshot`). Building a parallel `PANELS` constant would guarantee drift the first time a new panel is added.

Refactor: extract `navSections` to a shared module so it serves both the section-nav AND the panel-prefs modal:

- New `src/constants/panel-registry.ts` exports a function `getPanelRegistry({ isAuthenticated, hasMarketOrSnapshot }): Array<{ id: string; label: string; group: string }>` — same shape as today's `navSections` plus a `group` field for modal organization (`'Inputs' | 'Market Context' | 'Futures' | 'Charts & History' | 'Trading' | 'Results'`).
- `App.tsx` `navSections` becomes `getPanelRegistry({ isAuthenticated, hasMarketOrSnapshot })` (dropping the `group` field for nav purposes via `.map`).
- The modal calls the same function and groups by `group`.

This keeps a single source of truth and means adding a new panel later is a one-line registry edit.

The `id` strings must match the JSX `id="sec-*"` attributes exactly (validated by Phase 1's Zod regex `/^sec-[a-z0-9-]+$/`).

**Files in Phase 3:**

- `src/constants/panel-registry.ts` (new — extracted from App.tsx `navSections`)
- `src/App.tsx` (modify — replace inline `navSections` array with call to `getPanelRegistry`)
- `src/components/PanelPrefsModal/PanelPrefsModal.tsx` (new)
- `src/components/PanelPrefsModal/__tests__/PanelPrefsModal.test.tsx` (new)
- `src/components/AppHeader.tsx` (modify — add gear button + modal state)

**Verification:** Playwright e2e in `e2e/panel-prefs.spec.ts` — open modal, uncheck "Dark Pool Levels," close, assert `#sec-darkpool` absent.

---

## Data dependencies

- New table `panel_prefs` (migration 165). No external API. No new env vars.

## Open questions

1. **Bootstrap strategy.** The original "piggyback on auth-mode" idea relied on a non-existent boot-time fetch. Two real options:
   - **(a) Dedicated `GET /api/panel-prefs` on hook mount** (current spec). One extra request after auth resolution. ~50–150ms. Brief render delay for owner/guest.
   - **(b) Modify `/api/auth/whoami` to include `hiddenPanels`, and call it once on app boot.** No extra request, but couples the prefs response to the identity response and requires a new bootstrap fetch the app doesn't do today.

   **Default pick:** (a). Cleaner separation of concerns; the load delay is imperceptible vs. existing chain-data fetches.

2. **Panel groupings in modal.** Spec lists groups (Inputs / Market Context / etc.) but exact assignment of each of the 27 panels to a group needs your eye. Default: I'll propose groupings during Phase 3 review.

3. **Mobile UX.** A 27-row checkbox list on phones is long. Worth a search filter at the top of the modal? **Default:** ship without it; add later if useful.

4. **Conditional panels (`hasMarketContext &&`, `isAuthenticated &&`).** Should hidden conditional panels even appear in the modal? E.g., if a guest can't see Futures Calculator anyway, listing it is confusing. **Default:** show all 27 in modal, but disable + grey out the rows that aren't accessible to the current identity.

## Thresholds / constants

- `MAX_HIDDEN_PANELS = 50` (Zod array cap — generous; current total is 27)
- `PUT_DEBOUNCE_MS = 500` (trailing edge)
- `PUT_RATE_LIMIT = 20/min` (matches `positions.ts`)
- Panel ID regex: `/^sec-[a-z0-9-]+$/` (matches existing `id="sec-*"` convention)

## Done when

- All 27 panels can be hidden/shown per identity
- Owner and guest prefs are fully isolated (verified by toggling as one identity and checking the other is unchanged)
- Prefs persist across browser sessions and devices
- `npm run review` green; e2e spec green
- New table created in prod via migration 165
