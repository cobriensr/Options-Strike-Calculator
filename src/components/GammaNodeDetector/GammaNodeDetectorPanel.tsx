/**
 * GammaNodeDetectorPanel — the SectionBox-wrapped tile that surfaces the
 * Gamma-Node Composite Detector's day context + live fires.
 *
 * Phase 2 of docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md.
 *
 * The tile is a TIERED ALERT surface — not an autotrader. The detector
 * fires on every qualifying setup; the trader inspects the confidence
 * tier + anti-filter context and decides whether to take the trade.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ GAMMA-NODE COMPOSITE DETECTOR                                    │
 *   │ ┌─────────────────────────────────────────────────────────────┐ │
 *   │ │ MONDAY [MAXIMUM] pre-day filter active   [FOMC DAY]         │ │
 *   │ │ ceiling 7445 (300K)   floor 7415 (250K)                      │ │
 *   │ └─────────────────────────────────────────────────────────────┘ │
 *   │ [E1] Strike 7445 | breakthrough confirmed     +5.4 pts 10:22 CT │
 *   │ [E5] Strike 7420 | failed-bounce breakdown    pending  11:47 CT │
 *   │ [PCS] Strike 7415 | rejection — ES basis +0.8 +12.1 pts 10:08 CT│
 *   └─────────────────────────────────────────────────────────────────┘
 */

import { memo } from 'react';

import { SectionBox } from '../ui/SectionBox';
import { useGammaSetups } from '../../hooks/useGammaSetups';
import { DayConfidenceBanner } from './DayConfidenceBanner';
import { FireRow } from './FireRow';
import { RollingStatsBar } from './RollingStatsBar';

interface GammaNodeDetectorPanelProps {
  marketOpen: boolean;
}

export const GammaNodeDetectorPanel = memo(function GammaNodeDetectorPanel({
  marketOpen,
}: GammaNodeDetectorPanelProps) {
  const { data, loading, error } = useGammaSetups(marketOpen);

  return (
    <SectionBox label="Gamma-Node Composite Detector" collapsible>
      {error != null && (
        <div className="border-edge mb-2 rounded border bg-red-900/20 px-3 py-2 text-[11px] text-red-300">
          {error}
        </div>
      )}
      {data == null && loading && (
        <div className="text-muted font-mono text-[11px]">Loading setups…</div>
      )}
      {data != null && (
        <>
          <RollingStatsBar marketOpen={marketOpen} />
          <DayConfidenceBanner data={data} />
          {data.fires.length === 0 ? (
            <div className="border-edge bg-surface-alt rounded border p-2 text-[11px] text-neutral-500">
              No setups detected yet today.
            </div>
          ) : (
            <div className="flex flex-col">
              {data.fires.map((fire) => (
                <FireRow key={fire.id} fire={fire} />
              ))}
            </div>
          )}
        </>
      )}
    </SectionBox>
  );
});
