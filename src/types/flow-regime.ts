/**
 * Neutral, type-ONLY contract for the Flow Regime Recognition badge, shared
 * by the backend (api/_lib/flow-regime*.ts) and the frontend
 * (src/hooks/useFlowRegime.ts, src/components/FlowRegimeBadge/*). These are the
 * recognition union types — the single source of truth for both sides so the
 * declarations can't drift apart.
 *
 * Type-only: every import of this module MUST use `import type { ... }`. Because
 * the imports are erased at compile time, this file is exempt from the
 * "explicit .js extension on relative imports from src/ pulled by api/" rule
 * (there is no runtime import to resolve).
 *
 * RECOGNITION ONLY — these classify "today's flow vs the same time of day
 * historically"; they do NOT forecast direction.
 */

/** Recognition regime classification. */
export type FlowRegime = 'normal' | 'caution' | 'bearish' | 'bullish';

/** Semantic color for a regime. Gray = muted/neutral / low-confidence. */
export type FlowRegimeColor = 'green' | 'amber' | 'red' | 'gray';
