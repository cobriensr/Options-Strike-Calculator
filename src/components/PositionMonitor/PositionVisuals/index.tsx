import { useState } from 'react';
import type { PositionVisualsProps } from './helpers';
import StrikeMap from './StrikeMap';
import RiskWaterfall from './RiskWaterfall';
import CreditTimeChart from './CreditTimeChart';
import ProfitGauges from './ProfitGauges';

export type { PositionVisualsProps } from './helpers';

export default function PositionVisuals(props: Readonly<PositionVisualsProps>) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const panels = [
    {
      id: 'strike-map',
      title: 'Strike Map',
      desc: 'Positions relative to spot',
      content: (
        <StrikeMap
          spreads={props.spreads}
          ironCondors={props.ironCondors}
          hedges={props.hedges}
          nakedPositions={props.nakedPositions}
          spotPrice={props.spotPrice}
        />
      ),
    },
    {
      id: 'risk-waterfall',
      title: 'Risk Waterfall',
      desc: 'Max loss by position',
      content: (
        <RiskWaterfall
          spreads={props.spreads}
          ironCondors={props.ironCondors}
          hedges={props.hedges}
        />
      ),
    },
    {
      id: 'credit-time',
      title: 'Credit vs Time',
      desc: 'Entry prices by time of day',
      content: <CreditTimeChart trades={props.trades} />,
    },
    {
      id: 'profit-gauges',
      title: '% Max Profit',
      desc: 'Theta capture per position',
      content: (
        <ProfitGauges spreads={props.spreads} ironCondors={props.ironCondors} />
      ),
    },
  ] as const;

  return (
    <section
      aria-label="Position visualizations"
      data-testid="position-visuals"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {panels.map((panel) => {
          const isExpanded = expanded === panel.id;
          return (
            <div
              key={panel.id}
              className={`bg-surface-alt border-edge flex flex-col rounded-lg border transition-all ${
                isExpanded ? 'md:col-span-2' : ''
              }`}
            >
              {/* Panel header */}
              <button
                type="button"
                onClick={() => setExpanded(isExpanded ? null : panel.id)}
                className="flex w-full shrink-0 cursor-pointer items-center justify-between px-4 pt-3 pb-1"
              >
                <div>
                  <span className="text-tertiary font-sans text-xs font-bold tracking-wider uppercase">
                    {panel.title}
                  </span>
                  <span className="text-muted ml-2 font-sans text-[10px]">
                    {panel.desc}
                  </span>
                </div>
                <span className="text-muted text-xs">
                  {isExpanded ? '\u25B2' : '\u25BC'}
                </span>
              </button>
              {/* Panel content — grows to fill panel */}
              <div className="flex min-h-0 flex-1 flex-col justify-center px-3 pb-3">
                {panel.content}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
