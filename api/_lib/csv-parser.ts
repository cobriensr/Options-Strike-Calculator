/**
 * Barrel re-export for the per-domain csv-parser sub-files.
 *
 * The original 1,056-LOC monolith was split along the `parse` → `summary`
 * seam, with a small `internals.ts` for shared constants — three files
 * under `./csv-parser/`. Every export keeps its original name and shape —
 * the 5 importers (`api/positions.ts`, `api/_lib/positions-spreads.ts`
 * doc-comment, test files, `src/components/PositionMonitor/statement-parser.ts`)
 * continue to use `from './csv-parser.js'` unchanged.
 *
 * If you're adding a new parser helper, drop it in `./csv-parser/parse.ts`;
 * a new summary or pairing helper goes in `./csv-parser/summary.ts`.
 * Shared constants live in `./csv-parser/internals.ts`.
 * The `export *` chain below picks up new exports automatically.
 */

export * from './csv-parser/parse.js';
export * from './csv-parser/summary.js';
