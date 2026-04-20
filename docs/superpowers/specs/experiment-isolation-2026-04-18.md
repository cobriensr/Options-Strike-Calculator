# Experiment Isolation Convention

**Date**: 2026-04-18
**Status**: Spec (not yet implemented)
**Motivation**: Pyramid tracker retirement (`0ca98c5`) and TRACE PIN retirement (`9a8715a`) each deleted ~3,500 lines scattered across 30+ files. Experiments tangle into App.tsx, main.tsx, validation, migrations, tests, ML pipeline, Claude prompts — and retirement becomes a grep-and-delete exercise across the whole tree.

## Goal

Segregate experiments from main app code, minimize blast radius on create and remove. Two mechanical scripts to do the scaffolding and teardown; one ESLint rule to guarantee the import graph can't get tangled.

## What gets built

### 1. Folder skeleton

Three empty trees with a `.gitkeep` and a short `README.md` each:

```text
src/experiments/
api/experiments/
ml/experiments/
```

README in each folder is 5-10 lines: what goes here, the import rule, the two scripts. That's the only documentation — no lifecycle.md, no registration-patterns.md.

### 2. ESLint dependency-direction rule

Via `eslint-plugin-import`'s `no-restricted-paths`:

- `src/experiments/**` and `api/experiments/**` may import from anywhere
- **Nothing outside those trees may import from them**

This is the load-bearing piece. If nothing in production can import an experiment, retirement cannot cause a silent regression in production — guaranteed by the lint pipeline, not by vigilance.

### 2b. Python equivalent for ml/experiments/

ESLint does not cover Python. Add a short grep check to `ml/Makefile`'s `review` target: fail if any file outside `ml/experiments/` has an `import` line referencing a module under `ml/experiments/`. Same guarantee at the Python layer, grep-based instead of AST-based.

### 2c. Tests live inside the experiment

Tests for an experiment go in `src/experiments/<name>/__tests__/` and `api/experiments/<name>/__tests__/` — **not** in the top-level `src/__tests__/` or `api/__tests__/`. Retirement deletes the experiment folder; scoped tests vanish with it. Top-level test directories stay reserved for production code.

### 3. `scripts/new-experiment.sh <name>`

Purely mechanical. Takes a kebab-case name, creates:

```text
src/experiments/<name>/index.tsx         (default-exports a placeholder component)
src/experiments/<name>/README.md         (lists tables + env vars if any)
src/experiments/<name>/__tests__/.gitkeep (scoped tests live here)
api/experiments/<name>/.gitkeep          (empty; user adds endpoints as needed)
api/experiments/<name>/__tests__/.gitkeep (scoped tests live here)
ml/experiments/<name>/README.md          (lists tables read, plots generated)
ml/experiments/<name>/.gitkeep           (scripts added as needed)
```

Prints the one line to paste into `src/App.tsx` for activation (explicit over auto-discovery — every entry into App.tsx is visible in the diff). Does not auto-edit shared files. Does not stage or commit.

### 4. `scripts/retire-experiment.sh <name>`

Purely mechanical. Takes the name, does:

1. Validates the experiment exists in at least one of the three trees
2. `git rm -r` whichever of the three folders exist
3. Reads tables from the experiment's README (if any) and appends a DROP migration to `api/_lib/db-migrations.ts` with description prefix `[exp:<name>]`
4. Updates `api/__tests__/db.test.ts` mock counts for the new migration
5. Runs `npm run review` — exits non-zero if it fails (the hard gate)
6. Exits. User reviews `git status` and commits manually.

Does not stage, commit, or dispatch any tools. If the experiment added anything outside its folders (a main.tsx protect entry, a vercel.json cron), the user removes those manually — the pre-exit `npm run review` will fail on dangling imports, which is the signal.

## Files touched

**Created (one-time):**

- `src/experiments/.gitkeep`, `src/experiments/README.md`
- `api/experiments/.gitkeep`, `api/experiments/README.md`
- `ml/experiments/.gitkeep`, `ml/experiments/README.md`
- `scripts/new-experiment.sh`
- `scripts/retire-experiment.sh`

**Modified (one-time):**

- `eslint.config.ts` — add the `no-restricted-paths` rule (~10 lines)

**Total**: 9 file creates, 1 file edit. Roughly 2-3 hours end to end.

## What experiments can and can't do

- ✅ Add components, hooks, utils inside `src/experiments/<name>/`
- ✅ Add endpoints inside `api/experiments/<name>/`
- ✅ Add Python scripts inside `ml/experiments/<name>/`
- ✅ Add DB migrations to `api/_lib/db-migrations.ts` with description prefix `[exp:<name>]`
- ✅ Add one import + one render line to `src/App.tsx` to activate the experiment
- ✅ Add botid `protect` entries to `src/main.tsx` if needed
- ✅ Register per-plot entries in `plot-analysis-prompts.ts` for Claude plot reads
- ❌ Modify `analyze-prompts.ts`, `analyze-context.ts`, or `lessons.ts` — the main analyze endpoint stays untouched until you decide to promote the experiment
- ❌ Be imported from anywhere outside `experiments/` (ESLint enforced)

## Open questions

None unresolved. The plan is intentionally small.

## Not in scope

- Retroactive conversion of existing production features into this layout
- Separate Vercel projects per experiment
- Feature flags (orthogonal; experiments can add their own inside their folder)
- Any Claude / agent integration in the scripts — those are human workflows run independently
