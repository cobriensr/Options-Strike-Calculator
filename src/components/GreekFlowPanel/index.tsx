/**
 * GreekFlowPanel — SPY + QQQ cumulative Greek flow dashboard.
 *
 * Mirrors the 8-chart Unusual Whales Greek Flow board:
 *
 *   Vega row:  Dir Vega | OTM Dir Vega | Vega | OTM Vega
 *   Delta row: Dir Delta | OTM Dir Delta | Delta | OTM Delta
 *
 * Each chart shows the cumulative running sum across the session, with
 * a sign-aware fill (green above zero, red below) and a derived-signal
 * MetricsBar (slope / flip / cliff / divergence vs the other ticker).
 *
 * The panel polls /api/greek-flow every 60s during market hours. A date
 * scrubber switches between LIVE mode and a frozen historical session
 * (one-shot fetch, no polling). Both tickers are returned by a single
 * endpoint so the divergence badge has both signs available.
 */

import { memo, useState } from 'react';
import {
  useGreekFlow,
  type GreekFlowField,
  type GreekFlowResponse,
  type GreekFlowRow,
  type GreekFlowTicker,
} from '../../hooks/useGreekFlow';
import { FlowChart } from './FlowChart';
import { MetricsBar } from './MetricsBar';
import { SectionBox } from '../ui';
import { DateInputET } from '../ui/DateInputET';
import { getETToday } from '../../utils/timezone';

interface GreekFlowPanelProps {
  marketOpen: boolean;
}

const TICKERS: readonly GreekFlowTicker[] = ['SPY', 'QQQ'] as const;

interface ChartCellSpec {
  field: GreekFlowField;
  cumKey: keyof GreekFlowRow;
  label: string;
}

// 4 columns × 2 rows. Vega above, Delta below. Direction-signed
// (Dir / OTM Dir) on the left where the trader's eye lands first.
const CHART_GRID: readonly ChartCellSpec[] = [
  { field: 'dir_vega_flow', cumKey: 'cum_dir_vega_flow', label: 'Dir Vega' },
  {
    field: 'otm_dir_vega_flow',
    cumKey: 'cum_otm_dir_vega_flow',
    label: 'OTM Dir Vega',
  },
  { field: 'total_vega_flow', cumKey: 'cum_total_vega_flow', label: 'Vega' },
  {
    field: 'otm_total_vega_flow',
    cumKey: 'cum_otm_total_vega_flow',
    label: 'OTM Vega',
  },
  {
    field: 'dir_delta_flow',
    cumKey: 'cum_dir_delta_flow',
    label: 'Dir Delta',
  },
  {
    field: 'otm_dir_delta_flow',
    cumKey: 'cum_otm_dir_delta_flow',
    label: 'OTM Dir Delta',
  },
  {
    field: 'total_delta_flow',
    cumKey: 'cum_total_delta_flow',
    label: 'Delta',
  },
  {
    field: 'otm_total_delta_flow',
    cumKey: 'cum_otm_total_delta_flow',
    label: 'OTM Delta',
  },
] as const;

function GreekFlowPanelInner({ marketOpen }: GreekFlowPanelProps) {
  const today = getETToday();
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [activeTicker, setActiveTicker] = useState<GreekFlowTicker>('SPY');
  const isLive = selectedDate === today;
  const effectiveMarketOpen = isLive ? marketOpen : false;
  const dateArg = isLive ? null : selectedDate;

  const { data, loading, error } = useGreekFlow(effectiveMarketOpen, dateArg);

  const headerRight = (
    <div className="flex items-center gap-2">
      <TickerTabs active={activeTicker} onChange={setActiveTicker} />
      {!isLive && (
        <button
          type="button"
          onClick={() => setSelectedDate(today)}
          className="text-secondary hover:text-primary border-edge cursor-pointer rounded border bg-transparent px-2 py-0.5 font-mono text-[10px]"
        >
          LIVE
        </button>
      )}
      <DateInputET
        value={selectedDate}
        onChange={setSelectedDate}
        label="Greek flow date"
        labelVisible={false}
        className="text-secondary border-edge rounded border bg-transparent px-1.5 py-0.5 font-mono text-[10px]"
      />
    </div>
  );

  return (
    <SectionBox label="Greek Flow" headerRight={headerRight} collapsible>
      <p className="text-secondary mb-3 font-sans text-xs">
        Cumulative directional Δ &amp; V flow for SPY / QQQ. Slope = momentum;
        flip = sign change in last 30m; cliff = abnormal 10-min Δ in 14:00–15:00
        CT; div = SPY/QQQ sign disagreement.
      </p>
      <Body
        data={data}
        loading={loading}
        error={error}
        activeTicker={activeTicker}
      />
    </SectionBox>
  );
}

function TickerTabs({
  active,
  onChange,
}: {
  active: GreekFlowTicker;
  onChange: (t: GreekFlowTicker) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Greek flow ticker"
      className="border-edge inline-flex overflow-hidden rounded border"
    >
      {TICKERS.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={active === t}
          onClick={() => onChange(t)}
          className={`cursor-pointer px-2 py-0.5 font-mono text-[10px] ${
            active === t
              ? 'bg-surface text-primary'
              : 'text-secondary hover:text-primary'
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function Body({
  data,
  loading,
  error,
  activeTicker,
}: {
  data: GreekFlowResponse | null;
  loading: boolean;
  error: string | null;
  activeTicker: GreekFlowTicker;
}) {
  if (error) {
    return (
      <div role="alert" className="text-secondary font-sans text-xs">
        {error}
      </div>
    );
  }

  if (loading && data == null) {
    return <div className="text-secondary font-sans text-xs">Loading…</div>;
  }

  if (data == null || data.date == null) {
    return (
      <div className="text-secondary font-sans text-xs">
        No Greek flow data for the selected date.
      </div>
    );
  }

  const tickerData = data.tickers[activeTicker];
  const rows = tickerData.rows;

  if (rows.length === 0) {
    return (
      <div className="text-secondary font-sans text-xs">
        No rows for {activeTicker} on {data.date}.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {CHART_GRID.map((spec) => {
        const values = rows.map((r) => r[spec.cumKey] as number);
        const fieldMetrics = tickerData.metrics[spec.field];
        const fieldDivergence = data.divergence[spec.field];
        return (
          <div
            key={spec.field}
            className="border-edge bg-surface rounded-md border p-2"
          >
            <div className="text-primary mb-1 flex items-center justify-between font-sans text-[11px]">
              <span className="font-semibold">{spec.label}</span>
              <span className="text-secondary font-mono text-[9px]">
                {activeTicker}
              </span>
            </div>
            <FlowChart
              values={values}
              ariaLabel={`${activeTicker} cumulative ${spec.label}`}
            />
            <MetricsBar
              slope={fieldMetrics.slope}
              flip={fieldMetrics.flip}
              cliff={fieldMetrics.cliff}
              divergence={fieldDivergence}
            />
          </div>
        );
      })}
    </div>
  );
}

export const GreekFlowPanel = memo(GreekFlowPanelInner);
