/**
 * SPX 1-minute candle shape, shared between `src/hooks/useGexTarget.ts`
 * (data fetch) and `src/utils/candle-momentum.ts` (pure analyzer).
 *
 * Lifted from `src/hooks/useGexTarget.ts` in Phase 3C to fix the
 * inverted dependency where the util imported a type from a hook.
 *
 * `src/hooks/useGexTarget.ts` re-exports this name so existing callers
 * (`from '../hooks/useGexTarget'`) continue to work without churn.
 */

export interface SPXCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Epoch ms (start_time of the 1-minute bar). */
  datetime: number;
}
