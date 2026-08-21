# Flow-Regime Baseline Relocation — move the JSON out of `api/_lib/` (2026-08-15)

## Goal

Fix `npm run dev:full` rendering a **blank page** on `http://localhost:3000` by
moving the committed `flow-regime-baseline.json` artifact from `api/_lib/` to
`src/data/`, so the frontend's static import of it no longer resolves to a URL
under `/api/*` — a namespace that `vercel dev` owns and 404s for non-function
files.

## Problem

`src/components/FlowRegimeBadge/classify.ts` statically imports
`../../../api/_lib/flow-regime-baseline.json`. In dev, Vite serves that module
from the browser as `/api/_lib/flow-regime-baseline.json?import`.

- Under frontend-only `npm run dev` (`:5173`) the Vite proxy would forward it
  to `:3000`; commit `226cbe5a` added a `?import`/`?url` proxy bypass so Vite
  serves it locally. That fixed `:5173`.
- Under `npm run dev:full` (`vercel dev` on `:3000`) the request never reaches
  Vite: `vercel dev` routes `/api/*` through its function router first (the
  SPA rewrite in `vercel.json` explicitly excludes `api/`), `_lib/` files are
  not functions, so it returns **404 → the module graph aborts → blank app**.
  Verified at HEAD `e8223b6d`: that URL is the only failing request on `:3000`
  (200 on `:5173`, 404 on `:3000`), and the console shows exactly one
  `Failed to load resource: 404` per page load.

Production is unaffected (the JSON is inlined into the bundle at build), which
is why this only shows up in the integrated dev mode.

## Design

Relocate the artifact to `src/data/flow-regime-baseline.json` — `src/data/`
already holds committed data modules (`marketHours.ts`, `vixRangeStats.ts`) —
and point both consumers at it:

- `src/components/FlowRegimeBadge/classify.ts` → `../../data/flow-regime-baseline.json`
  (browser URL becomes `/src/data/flow-regime-baseline.json?import`, which
  `vercel dev` proxies to Vite like every other `/src/*` module).
- `api/_lib/flow-regime.ts` → `../../src/data/flow-regime-baseline.json`
  keeping the `with { type: 'json' }` import attribute (Node 24 ESM requires it
  for JSON). `api → src` is the established import direction in this repo
  (`../src/utils/timezone.js` etc.); the reverse — `src` importing runtime code
  from `api/` — is what caused the bug and this was the only such import.
- `scripts/build-flow-regime-baseline.py` writes `OUT_JSON` to the new path.

The `vite.config.ts` proxy bypass from `226cbe5a` is **kept** as a defensive
guard (harmless; protects `:5173` if a `src → api` import of a JSON/asset
module ever slips back in — Vite only appends `?import` to non-JS module
requests, so a plain `.ts` import from `api/` would not be caught by it) but
its comment is rewritten so it no longer describes a constraint that no longer
exists, and notes that the bypass cannot help under `vercel dev`.

Zero behavior change: same bytes, same importers, same evaluator/classifier code.

## Phases

1. **Relocate + repoint** (single mechanical pass): `git mv` the JSON, update the
   two imports, the Python `OUT_JSON`, and the two comment blocks that describe
   where the artifact lives. Independently shippable; this is the whole change.

## Files

- **Move:** `api/_lib/flow-regime-baseline.json` → `src/data/flow-regime-baseline.json`
- **Modify:** `src/components/FlowRegimeBadge/classify.ts` (import path)
- **Modify:** `api/_lib/flow-regime.ts` (import path; keep `with { type: 'json' }`)
- **Modify:** `scripts/build-flow-regime-baseline.py` (`OUT_JSON` + docstring)
- **Modify:** `vite.config.ts` (proxy-bypass comment only)
- **Create:** this spec.

**Deliberately NOT modified:**

- `api/_lib/db-migrations.ts` migration #185 description mentions the old path.
  Migration descriptions are historical records and `api/__tests__/db.test.ts`
  asserts them verbatim — rewriting history for a path string is not worth it.
- Dated design specs under `docs/superpowers/specs/` that cite the old path
  (`flow-regime-badge-2026-06-06.md`, `2026-06-11-frontend-recomposition-design.md`).
  `flow-regime-baseline-refresh-2026-06-07.md` refers to the artifact by bare
  filename only, which remains correct. This spec is the forward pointer.

## Tests

Strict refactor with existing coverage on both import sites — no new tests:

- Frontend: `src/__tests__/components/FlowRegimeBadge.test.tsx` imports
  `classify.ts` and therefore the relocated JSON.
- Backend: `api/__tests__/{flow-regime,flow-regime-baseline-live,capture-flow-regime,capture-flow-regime-daily,flow-regime-sql-parity,flow-regime-sql-integration}.test.ts`
  import `flow-regime.ts` / `flow-regime-baseline-live.ts` → the relocated JSON.

Verification gate: `npm run review` (tsc for both projects + eslint + prettier +
vitest w/ coverage), plus a live check that `http://localhost:3000` renders and
`GET /src/data/flow-regime-baseline.json?import` is 200 on both dev servers.

## Data dependencies

None. No tables, migrations, env vars, or external APIs. Vercel's function
bundler traces the static JSON import the same way it does today (relative
import + import attribute); `src/` is not excluded by `.vercelignore`.

## Open questions

- Should a lint guard (`no-restricted-imports` for `src/**` → `**/api/**`
  runtime imports) be added so this class of bug can't recur? Default: **not in
  this change** — proposed as a follow-up. After this relocation there are zero
  `src → api` imports in browser-served code; one test-only import remains
  (`src/__tests__/session-quality.test.ts` imports `api/_lib/lottery-finder`,
  never part of the Vite module graph), so the rule would need to exclude
  `src/__tests__/**`.
- Should the now-unneeded `vite.config.ts` bypass be removed instead of kept?
  Default: **keep** (see Design).

## Thresholds / constants

None.
