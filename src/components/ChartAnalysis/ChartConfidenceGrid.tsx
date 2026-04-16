import type { AnalysisResult } from './types';
import { confidenceColor, signalColor } from './analysis-helpers';

interface Props {
  readonly chartConfidence: NonNullable<AnalysisResult['chartConfidence']>;
}

export default function ChartConfidenceGrid({ chartConfidence }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {(
        [
          ['marketTide', 'Market Tide'],
          ['spxNetFlow', 'SPX Flow'],
          ['spyNetFlow', 'SPY Flow'],
          ['qqqNetFlow', 'QQQ Flow'],
          ['periscope', 'Periscope'],
          ['netCharm', 'Net Charm'],
          ['aggregateGex', 'Aggregate GEX'],
          ['periscopeCharm', 'Periscope Charm'],
          ['darkPool', 'Dark Pool'],
          ['futuresContext', 'Futures'],
          ['nopeSignal', 'SPY NOPE'],
          ['deltaFlow', 'Delta Flow'],
          ['zeroGamma', 'Zero-Gamma'],
          ['netGexHeatmap', 'GEX Heatmap'],
          ['marketInternals', 'Internals'],
          ['deltaPressure', 'Delta Pressure'],
          ['charmPressure', 'Charm Pressure'],
        ] as const
      ).map(([key, label]) => {
        const sig = chartConfidence[key];
        if (!sig || sig.signal === 'NOT PROVIDED') return null;
        return (
          <div
            key={key}
            className="bg-surface border-edge rounded-md border p-2.5"
          >
            <div className="text-muted mb-0.5 text-[10px] font-bold tracking-wider uppercase">
              {label}
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className="text-[13px] font-bold"
                style={{ color: signalColor(sig.signal) }}
              >
                {sig.signal}
              </span>
              <span
                className="text-[10px] font-semibold"
                style={{ color: confidenceColor(sig.confidence) }}
              >
                {sig.confidence}
              </span>
            </div>
            <div className="text-muted mt-1 text-[10px] leading-snug">
              {sig.note}
            </div>
          </div>
        );
      })}
    </div>
  );
}
