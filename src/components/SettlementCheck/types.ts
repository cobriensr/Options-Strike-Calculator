/**
 * Re-export of the canonical SettlementResult from src/types/settlement,
 * kept for the existing `from './types'` imports inside SettlementCheck.
 * The type was lifted in Phase 3C to fix an inverted dependency where
 * src/utils/settlement.ts was importing from src/components/.
 */

export type { SettlementResult } from '../../types/settlement.js';
