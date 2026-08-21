# Theta targeted backfill — 2026-08-21

**Date:** 2026-08-21 · **Status:** implementing · **Owner:** soonerdude28 fork

## Goal

Repair the `theta_option_eod` holes left by the watchdog/nightly incident
(db29a783), and leave behind a reusable way to refill a known
`(root, date-range)` gap. `run_backfill_if_needed` cannot do this: it
short-circuits on `db.has_theta_option_eod_rows(root)`, i.e. any root with
_any_ data is skipped forever.

## The holes (measured)

Healthy reference — 2026-08-17: SPXW 18,538 rows / 40 exps (max exp
2027-01-29) · NDXP 12,104 / 32 · VIX 760 / 6 · VIXW 400 / 4.

| trade date | SPXW                                                     | NDXP   | VIX    | VIXW   |
| ---------- | -------------------------------------------------------- | ------ | ------ | ------ |
| 2026-08-18 | 16,862 / **38** exps, max exp **2026-12-18** (truncated) | absent | absent | absent |
| 2026-08-19 | 8,038 / **15** exps, max exp **2026-09-09** (truncated)  | absent | absent | absent |

Note SPXW is truncated on BOTH days, not just 8/19 — an earlier reading of
this incident said 8/18's SPXW was complete. So the repair covers **all
four roots across both days**, not three.

SPXW is a partial root: rows exist, so any "does this root have rows"
guard skips it. The repair must be range-based, not existence-based.
Re-fetching a root that is already partially filled is safe and costs the
same either way — the walk is driven by the expiration ladder, and
`db.upsert_theta_option_eod_batch` is ON CONFLICT DO **UPDATE** (the
sidecar's only multi-row DO UPDATE; `sidecar/src/db.py`). So an
overlapping re-run rewrites existing rows with the fresh snapshot and
fills the missing ones — idempotent and self-completing, no DELETE.

**Expected cost:** ~3.5 h for 4 roots × 2 days (per-day observed: SPXW
~60 min, NDXP ~25, VIX ~13, VIXW ~9). Must not overlap the 21:25Z nightly.
`_fetch_root_range` already walks `expiration × strike` per day and upserts
with `ON CONFLICT DO NOTHING`, so re-fetching a partially-filled root is
idempotent and self-completing — no DELETE required.

## Design

**Where:** the sidecar. The Theta Terminal is co-resident on 127.0.0.1:25510;
nothing outside the container can reach it.

**Why not synchronous:** observed per-day costs are NDXP ~25 min, VIX ~13 min,
VIXW ~9 min. This job is ~1.5–2 h. It must run detached, not on a request.

- `theta_fetcher.start_targeted_backfill(roots, start_date, end_date)` —
  single-flight; spawns a daemon thread; per-root isolation reusing the
  `RootOutcome` / `ROOT_OK|ROOT_NO_DATA|ROOT_ERROR` classification added in
  db29a783 so one root's failure cannot abort the rest. Each root calls the
  existing `_fetch_root_range` — no new fetch logic.
- `theta_fetcher.targeted_backfill_status()` — module-level status snapshot
  (state, roots, range, per-root rows/outcome, started/finished, error).
- `POST /admin/theta-backfill` → 202 + the accepted plan. `GET` → status.

**Auth:** reuse `X-Admin-Token` vs `ARCHIVE_SEED_TOKEN`, byte-identical to
`/admin/seed-archive` (`hmac.compare_digest`, and every rejection path
returns a flat 401 so the endpoint is not an enumeration oracle). No new
env var. Absent token ⇒ endpoint effectively disabled, same as the seeder.

**Validation (reject with 400 before doing any work):**

- `roots` ⊆ `settings.theta_roots_list` — never fetch an arbitrary root.
- `start`/`end` are `YYYY-MM-DD`, `end >= start`, and the span is capped
  (31 days) so a typo cannot start a 12-hour job.
- `end` must be < today (EOD data for the current session does not exist).

**Concurrency:** single-flight against itself (423 while running). The
nightly is NOT lock-shared — run outside 21:25Z–23:30Z so the two don't
both load the Terminal. Documented in the endpoint docstring and here.

## Files

`sidecar/src/theta_fetcher.py`, `sidecar/src/health.py`, and their tests.

## Verification

Sidecar pytest (877+ baseline) and `make lint` clean+idempotent. Then
deploy, POST the two dates, poll `GET /admin/theta-backfill`, and confirm
in Postgres that 8/18 and 8/19 each show 4 roots with SPXW's expiration
count back at ~38.

## Open questions (defaults picked)

- Auto gap-detection (scan for `(date, root)` pairs below an expected
  expiration count) — **out of scope**; this is the manual primitive it
  would eventually call.
- Persisting job state across a restart — **no**; a restart mid-backfill
  means re-POSTing, which is safe because the upsert is idempotent.
