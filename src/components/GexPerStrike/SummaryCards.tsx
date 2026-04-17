/**
 * Bottom row of 6 summary cards for the GexPerStrike panel:
 * total net GEX, net charm, net vanna, GEX flip strike, flow pressure,
 * and charm burn rate (per-minute hedging pressure).
 *
 * Pure presentation — all aggregates are pre-computed by the orchestrator
 * and passed in as a single `summary` object.
 */

import { theme } from '../../themes';
import { CHARM_POS, CHARM_NEG, VANNA_POS, VANNA_NEG } from './colors';
import { formatNum, formatFlowPressure } from './formatters';

export interface GexSummary {
  totalGex: number;
  totalCharm: number;
  totalVanna: number;
  flipStrike: string;
  flowPressurePct: number;
  flowSign: 'reinforcing' | 'opposing' | 'neutral';
  charmBurnRate: number;
}

export function SummaryCards({ summary }: Readonly<{ summary: GexSummary }>) {
  const cards = [
    {
      label: 'TOTAL NET GEX',
      value: formatNum(summary.totalGex),
      color: summary.totalGex >= 0 ? theme.green : theme.red,
      sub: null as string | null,
    },
    {
      label: 'NET CHARM',
      value: formatNum(summary.totalCharm),
      color: summary.totalCharm >= 0 ? CHARM_POS : CHARM_NEG,
      sub: null as string | null,
    },
    {
      label: 'NET VANNA',
      value: formatNum(summary.totalVanna),
      color: summary.totalVanna >= 0 ? VANNA_POS : VANNA_NEG,
      sub: null as string | null,
    },
    {
      label: 'GEX FLIP',
      value: summary.flipStrike,
      color: theme.text,
      sub: null as string | null,
    },
    {
      label: 'FLOW PRESSURE',
      value: formatFlowPressure(summary.flowPressurePct),
      color:
        summary.flowSign === 'reinforcing'
          ? theme.green
          : summary.flowSign === 'opposing'
            ? theme.red
            : theme.textMuted,
      sub:
        summary.flowSign === 'reinforcing'
          ? 'reinforcing'
          : summary.flowSign === 'opposing'
            ? 'opposing'
            : 'neutral',
    },
    {
      label: 'CHARM BURN/MIN',
      value: formatNum(summary.charmBurnRate),
      color: summary.charmBurnRate >= 0 ? CHARM_POS : CHARM_NEG,
      sub: summary.charmBurnRate >= 0 ? 'buying pressure' : 'selling pressure',
    },
  ] as const;

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px] md:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-md border p-2.5"
          style={{
            background: 'rgba(255,255,255,0.02)',
            borderColor: 'rgba(255,255,255,0.04)',
          }}
        >
          <div
            className="mb-1 text-[9px] font-semibold tracking-wide"
            style={{ color: theme.textMuted }}
          >
            {card.label}
          </div>
          <div className="text-[14px] font-bold" style={{ color: card.color }}>
            {card.value}
          </div>
          {card.sub && (
            <div
              className="mt-0.5 text-[9px]"
              style={{ color: theme.textMuted }}
            >
              {card.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
