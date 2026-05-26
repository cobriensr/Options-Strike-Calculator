/**
 * Shared types for GexBot context surfaced on alert rows.
 *
 * Migrations #180 (silent_boom_alerts) and #181 (lottery_finder_fires)
 * each added the same 8 `gex_*` columns. The frontend exposes the same
 * normalized shape on both `SilentBoomAlert.gex` and `LotteryFire.gex`
 * so the shared badge factory in `src/utils/gexbot-badge.ts` can render
 * either without per-feed branching.
 *
 * All fields are nullable; the whole block is treated as "absent" when
 * `capturedAt` is null (ticker outside the 16-ticker GexBot universe,
 * or the snapshot freshness window missed at detect time).
 *
 * Probe basis:
 * `docs/tmp/silent-boom-gexbot-probe-findings-2026-05-26.md`.
 */
export interface GexbotFireContext {
  oneCvroflow: number | null;
  netPutDex: number | null;
  oneDexoflow: number | null;
  oneGexoflow: number | null;
  zcvr: number | null;
  zeroGamma: number | null;
  spot: number | null;
  capturedAt: string | null;
}
