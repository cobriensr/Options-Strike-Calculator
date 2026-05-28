# Contract Tracker Enhancements — Design

**Date:** 2026-05-28
**Status:** Draft (awaiting user review)
**Origin:** User feedback relayed via Discord (Wonce + Cedoulain) on
2026-05-28 after a 5,200-contract SMCI 31C 05/29 row hit +895.5% on the
tracker. Five enhancement asks bundled here since they overlap on the
same files and ship best as one PR.

Prior tracker spec: [contract-tracker-2026-05-17.md](contract-tracker-2026-05-17.md)

## Goal

Surface tracker metadata that already exists in the DB (added-at,
delete action), add total-premium display, and persist the
UnusualWhales URL used at create time so the row click-through lands
exactly where the user originally found the contract.

## Asks (numbered for traceability)

1. **Date added to watchlist** — show `created_at` in the row or details.
2. **Premium size** — derived `$ = entry_price × quantity × 100`.
3. **UW URL on create** — persist the URL pasted into the "Add" form.
4. **Click contract → UW** — row click opens stored `uw_url` in a new tab.
5. **Delete button in Details** — expose existing DELETE endpoint in the
   modal footer.

## Current state (verified 2026-05-28)

- `tracker_contracts` table created in migration #161
  ([api/_lib/db-migrations.ts](../../api/_lib/db-migrations.ts) lines 4616–4643).
  `created_at` and `updated_at` columns already exist.
- Highest existing migration: **#182** → new migration is **#183**.
- `DELETE /api/tracker/contracts/[id]` already implemented in
  [api/tracker/contracts/[id].ts](../../api/tracker/contracts/[id].ts) lines 128–180.
  Cascade-deletes ticks and alerts. Not currently surfaced in UI.
- [AddContractForm.tsx](../../src/components/Tracker/AddContractForm.tsx)
  already parses pasted UW URLs to auto-fill ticker/expiry/strike/side
  (see "Paste field"). The URL itself is **discarded** after parsing —
  we just need to also store it.
- All tracker endpoints use `guardOwnerOrGuestEndpoint` (single-tenant,
  not owner-only).

## Out of scope (deliberate)

- **Constructing UW URLs for legacy rows.** UW's contract URL shape isn't
  stable enough to synthesize safely. Legacy rows simply have no
  click-through; the link is rendered only when `uw_url` is non-null.
- **Backfilling `uw_url` on existing rows.** Same rationale.
- **Edit-after-create for `uw_url`.** If a row was created without a URL,
  user re-adds the contract with the URL paste. Not worth a form field.
- **Soft-delete / undo.** Existing DELETE is hard; the "are you sure?"
  confirm dialog is the only safety net. Tracker rows are owner-driven
  and rebuildable.

## Schema change

**Migration #183** — add `uw_url` to `tracker_contracts`:

```sql
ALTER TABLE tracker_contracts
  ADD COLUMN uw_url TEXT NULL;
```

No index. The column is read only when a row is rendered (already in
the SELECT result set) and never queried.

[api/__tests__/db.test.ts](../../api/__tests__/db.test.ts) needs the
matching mock entry per the project's migration test pattern.

## Backend changes

### Validation ([api/_lib/validation/tracker.ts](../../api/_lib/validation/tracker.ts))

Add optional `uw_url` to both `contractCreateSchema` and
`freeTextContractSchema`:

```ts
uw_url: z
  .string()
  .url()
  .refine((u) => new URL(u).hostname.endsWith('unusualwhales.com'), {
    message: 'uw_url must be on unusualwhales.com',
  })
  .optional(),
```

Hostname allowlist prevents accidental open-redirect on the row click,
even though the surface is owner-only. Cheap to enforce.

### Create endpoint ([api/tracker/contracts.ts](../../api/tracker/contracts.ts))

- Accept `uw_url` from both structured and free-text request bodies.
- Insert into the new column. ON CONFLICT DO NOTHING semantics
  unchanged.
- Free-text path: extract the URL from the input string before passing
  to `parseFreeText()`. If the input *is* a UW URL, pass it through to
  `uw_url`.

### List endpoint (same file)

Add `uw_url` to the SELECT column list so it's returned to the client.

### DELETE endpoint

No changes — already implemented. Verify the response shape matches
what the new UI button will consume.

## Frontend changes

### Types ([src/components/Tracker/types.ts](../../src/components/Tracker/types.ts))

Add `uw_url: string | null` to `TrackerContract`. Add the same field as
optional to `ContractCreateInput` and `ContractFreeTextInput`.

### Add form ([src/components/Tracker/AddContractForm.tsx](../../src/components/Tracker/AddContractForm.tsx))

- When the paste field is a UW URL, capture it into local state and
  include it on submit (both structured and free-text submission paths).
- No new form field. The URL is implicit from the paste.

### Row + details ([src/components/Tracker/ContractRow.tsx](../../src/components/Tracker/ContractRow.tsx))

- **Date added**: render `created_at` in the details panel as
  "Added: MMM D" (formatted via the existing helpers).
- **Premium size**: compute `entry_price × quantity × 100` in
  `helpers.ts` as `formatPremium(c)` → render in the details panel
  next to entry price. Format as `$1,234` (thousands) or `$12.3K` if
  ≥ $10K to keep the cell readable.
- **UW link**: when `c.uw_url` is non-null, wrap the contract symbol
  in `<a href={c.uw_url} target="_blank" rel="noopener noreferrer">`.
  When null, render as plain text (no underline) so the absence is
  obvious. Don't make the entire row a link — only the contract cell.
- **Delete button**: add to the details modal footer next to "Close
  position". On click, show a confirm dialog ("Delete this row? This
  also removes all ticks and alerts."). On confirm, call new
  `useTrackerContracts.remove(id)` method.

### Hook ([src/hooks/useTrackerContracts.ts](../../src/hooks/useTrackerContracts.ts))

Add `remove(id: number): Promise<void>` that calls
`DELETE /api/tracker/contracts/:id` and on success removes the row
from local state via `mutate()`.

## Phases

Each phase is independently shippable and reviewable. Per CLAUDE.md
review loop: code-reviewer subagent after each phase.

### Phase 1 — Backend

Files:
- `api/_lib/db-migrations.ts` (migration #183)
- `api/__tests__/db.test.ts` (mock for #183)
- `api/_lib/validation/tracker.ts` (uw_url on both schemas)
- `api/tracker/contracts.ts` (accept + return uw_url)

Verification: `npm run review`. Smoke: POST a row with `uw_url` and
GET the list — confirm round-trip. Hostname rejection test (a
non-UW URL → 400).

### Phase 2 — Frontend types + hook

Files:
- `src/components/Tracker/types.ts`
- `src/hooks/useTrackerContracts.ts` (add `remove()`)
- `src/components/Tracker/helpers.ts` (add `formatPremium()`)

Verification: `npm run review`. Pure additions; no behavior change
yet.

### Phase 3 — Frontend UI

Files:
- `src/components/Tracker/AddContractForm.tsx` (capture URL on paste)
- `src/components/Tracker/ContractRow.tsx` (date, premium, UW link,
  delete button + confirm)

Verification: `npm run review`. Manual smoke in dev: paste a UW URL
into Add form, submit, confirm the row's contract cell links to the
URL, premium and added-date show in details, delete button removes
the row.

## Tests

Per CLAUDE.md "Tests Are Mandatory":

- **Migration test** — `api/__tests__/db.test.ts` mock entry for #183.
- **Validation test** — `api/__tests__/validation-tracker.test.ts` (or
  inline in existing) — non-UW hostname rejection, valid UW URL accepted.
- **Endpoint test** — extend existing tracker endpoint tests to assert
  `uw_url` round-trips on POST/GET.
- **Hook test** — `src/__tests__/useTrackerContracts.test.tsx` (or
  inline) — `remove()` calls DELETE and mutates local state.
- **Helper test** — `formatPremium()` table test (zero quantity, large
  premium → K-suffix, fractional entry price).
- **Component test** — `ContractRow` renders link when `uw_url` set,
  plain text when null. Delete button confirms before firing.

## Open questions

- Confirm dialog wording for delete — proposed: "Delete this row?
  This also removes all ticks and alerts." User can adjust.
- Premium format threshold: $10K cutoff for K-suffix. Adjust if it
  ends up looking wrong on real data.
- Should the UW URL also be editable on existing rows (via PATCH)? Not
  in scope per "Out of scope" but easy to add later.

## Done when

- All 5 asks are live on the production tracker.
- A row created with a pasted UW URL shows: clickable contract cell,
  premium $, added-date in details, delete button in details footer.
- A row created without a URL shows: non-clickable contract cell, no
  link affordance, everything else identical.
- `npm run review` passes; code-reviewer subagent verdict is `pass` for
  each phase.
