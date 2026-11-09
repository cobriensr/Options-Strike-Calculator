/**
 * Batch sizes of the recompute's writes and of the reads that check them: rows per
 * UPDATE statement (R5) and statements per write transaction. A step of a few
 * thousand rows takes several transactions, and one that dies between them leaves
 * some rows written; this module is its own file so a test can shrink the batches
 * (`vi.mock`) and make a small step take several.
 */
export const WRITE_CHUNK = 500;
export const CHUNKS_PER_TRANSACTION = 10;
