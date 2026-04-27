# Guest Access Key + Sidebar Overhaul — 2026-04-27

## Goal

Let a trusted friend paste a key and view owner-gated UI (Chart Analysis history,
GEX, dark pool, TRACE Live, futures playbook, etc.) without exposing those
routes to UW reconnaissance and without buying a multi-user license. Guests
get **read-only** access — the Chart Analysis submit button (the only
expensive action, ~$0.10–0.40/Anthropic call) stays owner-only, so a leaked
guest key cannot drain the Anthropic budget. While the sidebar is already
being touched, also rename mis-named entries and register the 4 components
currently mounted with no nav entry.

Two features, one PR is fine; they share territory in `SectionNav` and
`checkIsOwner`. Each phase is independently shippable.

---

## Phase 1 — Sidebar overhaul (~2 files, no backend)

Pure relabel + reorder + add 4 missing entries + remove 1 dead entry. Risk:
low; entirely a `useMemo` rewrite plus one anchor split.

### Files modified

- `src/App.tsx` — `navSections` useMemo (lines 634-667), and split the
  `sec-market-flow` anchor into `sec-market-internals` + `sec-market-flow` in
  the JSX (lines 1208-1228) so clicking "Flow" doesn't scroll to Internals.
- `src/components/SectionNav.tsx` — accept an optional `bottomSlot` prop so
  Phase 3 can mount the AccessKey button at the sidebar foot. No behavior
  change in Phase 1; the prop is just plumbing.

### Final sidebar (in JSX page order)

| Anchor                       | Label                              | Visibility   |
| ---------------------------- | ---------------------------------- | ------------ |
| `sec-inputs`                 | Inputs                             | public       |
| `sec-trading-schedule`       | Trading Schedule                   | public       |
| `sec-settings`               | Settings                           | public       |
| `sec-risk`                   | Risk Calculator                    | public       |
| `sec-regime`                 | Market Regime                      | public       |
| `sec-darkpool`               | Dark Pool Levels                   | owner + data |
| `sec-trace-live`             | **TRACE Live** _(NEW)_             | owner + data |
| `sec-gex`                    | GEX Per Strike                     | owner + data |
| `sec-gex-target`             | GEX Target                         | owner + data |
| `sec-gex-landscape`          | GEX Landscape                      | owner + data |
| `sec-futures-gamma-playbook` | **Futures Gamma Playbook** _(NEW)_ | owner + data |
| `sec-market-internals`       | **Market Internals** _(SPLIT)_     | owner + data |
| `sec-market-flow`            | Market Flow                        | owner + data |
| `sec-otm-flow`               | **OTM Flow Alerts** _(NEW)_        | owner + data |
| `sec-institutional-program`  | **Institutional Program** _(NEW)_  | owner + data |
| `sec-iv-anomalies`           | IV Anomalies                       | owner + data |
| `sec-futures`                | Futures Calculator                 | owner        |
| `sec-charts`                 | Chart Analysis                     | data         |
| `sec-history`                | Analysis History                   | public       |
| `sec-ml-insights`            | ML Insights                        | owner        |
| `sec-positions`              | Position Monitor                   | public       |
| `sec-bwb`                    | BWB Calculator                     | owner        |
| `results`                    | Results                            | public       |

Drops dead entry `Futures Calc → sec-futures-calc` (anchor never existed).

### Verify

- `npm run review` clean
- New unit test: every entry in `navSections` has a matching `id="..."`
  rendered somewhere in App.tsx (parsing-based, not e2e — keeps the suite fast)
- Manual: click each entry in owner mode + public mode, confirm correct scroll target

---

## Phase 2 — Guest-key backend (~6 files)

### Files created

- `api/auth/guest-key.ts` — `POST` body `{ key: string }`, validates against
  `GUEST_ACCESS_KEYS` env list with `crypto.timingSafeEqual`, sets signed
  httpOnly cookie on success
- `api/auth/guest-logout.ts` — clears the cookie
- `api/__tests__/guest-key.test.ts` — vitest

### Files modified

- `src/utils/auth.ts` — `checkIsOwner()` →
  `getAccessMode(): 'owner' | 'guest' | 'public'` (rename + extend; the
  `useAccessSession` hook in Phase 3 wraps this with React state)
- `api/_lib/api-helpers.ts` — new helper `requireOwnerOrGuest(req)` for
  read-only owner-gated data endpoints (dark pool, GEX, TRACE Live, futures
  playbook, etc.). `requireOwnerSession` is unchanged — `api/analyze.ts`
  stays owner-only.
- `api/_lib/validation.ts` — `guestKeySchema` (Zod, `key: z.string().min(8).max(128)`)
- `src/main.tsx` — append `/api/auth/guest-key` and `/api/auth/guest-logout`
  to the `protect` array in `initBotId()`
- Read-only data endpoints currently using `requireOwnerSession` get switched
  to `requireOwnerOrGuest` (file list confirmed during Phase 2 implementation
  via `grep -l requireOwnerSession api/`)

### Env vars (new — set via Vercel dashboard)

| Name                   | Purpose                                        | Default                          |
| ---------------------- | ---------------------------------------------- | -------------------------------- |
| `GUEST_ACCESS_KEYS`    | Comma-separated valid keys (rotate = redeploy) | none — feature disabled if unset |
| `GUEST_SESSION_SECRET` | HMAC key for cookie signing                    | none — required if above is set  |

### Cookie shape

```
Name:     guest_session
Value:    <keyHash>.<hmac(keyHash, GUEST_SESSION_SECRET)>
HttpOnly: true
Secure:   true (prod), false (dev)
SameSite: Lax
Path:     /
Max-Age:  30 days
```

`keyHash` = SHA-256 of the user-supplied key (so the raw key never lives in
the cookie). Server validates by comparing keyHash to SHA-256 of each entry
in `GUEST_ACCESS_KEYS`, then verifying HMAC.

### Thresholds

- Cookie TTL: **30 days**
- Min key length: **8 chars** (Zod-enforced)

No analyze rate limit — guests cannot submit analyze calls at all (the
submit button is disabled in the UI and `api/analyze.ts` keeps its
existing owner-only auth check).

### Verify

- vitest: valid key → 200 + Set-Cookie; invalid key → 401; missing env →
  500 with logged warning
- vitest: guest cookie → 401 on `api/analyze.ts` (regression guard)
- `npm run review` clean
- Browser DevTools: cookie is HttpOnly and Secure on prod

---

## Phase 3 — Guest-key UI (~4 files)

### Files created

- `src/components/AccessKey/AccessKeyButton.tsx` — small key icon. Mounts in
  the sidebar bottom slot (desktop) and inside the mobile nav footer.
- `src/components/AccessKey/AccessKeyModal.tsx` — single password-type input,
  submit, error states
- `src/components/AccessKey/__tests__/AccessKeyModal.test.tsx`
- `src/hooks/useAccessSession.ts` — returns `{ mode, refresh, logout }`,
  wraps `getAccessMode()` with React state and an effect that re-checks after
  modal submit

### Files modified

- `src/components/SectionNav.tsx` — render the new `bottomSlot` prop
  (introduced in Phase 1 plumbing) at the foot of the vertical orientation
- `src/App.tsx` — replace `const isOwner = checkIsOwner()` with
  `const { mode } = useAccessSession()` and feed `mode` through to
  visibility checks (`isOwner` becomes `mode !== 'public'`)
- `src/components/ChartAnalysis/` — submit button reads `mode` from
  `useAccessSession`; renders disabled with tooltip "Owner only — guest
  mode is read-only" when `mode === 'guest'`. History list, context
  preview, and any read-only chrome remain visible.

### Behavior

- Default state: small bare key icon in sidebar bottom (no label) — visible
  to **everyone**, including the owner (simpler — single mount point, no
  conditional render)
- Click → modal with single input + submit
- Submit → `POST /api/auth/guest-key` → on 200, `useAccessSession.refresh()`
  flips mode to `'guest'` (no full page reload — owner-gated sections appear
  in place)
- After auth: icon swaps to filled state. Click filled icon → small popover
  with "Sign out (guest)"
- Owner: clicking the button just shows a no-op informational popover ("You're
  signed in as owner — guest key is for sharing read-only access"). Cheap to
  implement, avoids the extra conditional.
- Guest viewing Chart Analysis: submit disabled, history/context still readable

### Verify

- Component test: modal open/close, submit success → mode flips to 'guest';
  submit failure → toast error; logout clears state
- Component test: ChartAnalysis submit button disabled when `mode === 'guest'`
- Manual: invalid key → error toast; valid key → owner-gated sections appear
  without page reload; submit on Chart Analysis is greyed out for guest
- Owner mode: button visible with informational popover

---

## Phase 4 — Verification + commit

- `npm run review` clean
- code-reviewer subagent on full diff
- Stage + commit + push direct to main (per repo convention)

---

## Decisions (confirmed 2026-04-27)

1. **Cookie TTL** — 30 days ✅
2. **Rate limit** — none. Guests can't submit analyze, period (the only
   expensive endpoint). Read-only data endpoints already have their own
   upstream rate limits via UW/Theta API keys.
3. **Key generation** — user generates locally (e.g. `openssl rand -base64 24`)
   and pastes the comma-separated list into Vercel env. No DB, no rotation
   tooling — rotate by editing the env var and redeploying. ✅
4. **Owner UX** — AccessKey button visible to everyone (simpler — single
   mount point). Owner clicking it gets an informational popover. ✅
5. **Key collision with Schwab session** — if a user is owner AND has guest
   cookie set, owner wins (`getAccessMode` checks Schwab first, then guest).
   Logout-as-guest does NOT log out Schwab.
6. **Guest restrictions** — Chart Analysis submit button disabled in UI;
   `api/analyze.ts` rejects guest cookies (regression guard). All other
   read-only owner-gated endpoints accept guest cookies.

---

## Done when

- [ ] 4 missing sidebar entries appear in correct slots
- [ ] 10 entries renamed to component names
- [ ] "Futures Calc" dead entry removed
- [ ] `sec-market-flow` anchor split into Internals + Flow
- [ ] Friend can paste a key in the sidebar modal and see owner-gated UI for 30 days
- [ ] Chart Analysis submit button disabled for guests (and `api/analyze.ts` rejects guest cookies)
- [ ] Read-only owner-gated data endpoints (dark pool, GEX, etc.) accept guest cookies
- [ ] All new env vars documented in `CLAUDE.md` env table
- [ ] `npm run review` clean
- [ ] code-reviewer subagent passes
- [ ] Committed and pushed
