/**
 * Barrel re-export for the per-domain validation sub-files.
 *
 * The original 1,118-LOC monolith was split into 5 domain-grouped
 * files under `./validation/` to make review/diff friction tractable.
 * Every export keeps its original name and shape — 27 importers across
 * `api/` continue to use `from './validation.js'` unchanged.
 *
 * If you're adding a new schema, drop it in the matching sub-file and
 * the `export *` chain below will pick it up automatically.
 */

export * from './validation/common.js';
export * from './validation/periscope.js';
export * from './validation/lottery.js';
export * from './validation/snapshot.js';
export * from './validation/market-data.js';
