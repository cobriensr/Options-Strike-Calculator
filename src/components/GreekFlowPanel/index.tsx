/**
 * GreekFlowPanel — focused 4-chart Greek flow dashboard for SPY + QQQ.
 *
 * Layout (2x2):
 *   SPY OTM Dir Delta | QQQ OTM Dir Delta
 *   SPY OTM Dir Vega  | QQQ OTM Dir Vega
 *
 * A Verdict tile above the grid combines the two pairs into a single
 * trade-recommendation label:
 *   - Both deltas same sign → directional bull / bear confluence
 *   - Deltas disagree, both vegas short → pin / premium-harvest regime
 *   - Deltas disagree, both vegas long → vol expansion / event positioning
 *   - Anything else → no trade
 *
 * Refreshes every POLL_INTERVALS.GREEK_FLOW (60s) during market hours.
 * Date scrubber switches to a frozen one-shot view of any prior session.
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
import { VerdictTile, VerdictTimeline } from './Verdict';
import { SectionBox } from '../ui';
import { DateInput } from '../ui/DateInput';
import { getETToday } from '../../utils/timezone';

interface GreekFlowPanelProps {
  marketOpen: boolean;
}

interface ChartCellSpec {
  ticker: GreekFlowTicker;
  field: GreekFlowField;
  cumKey: keyof GreekFlowRow;
  label: string;
}

// Row order: deltas first (directional read), vegas second (regime read).
// Column order: SPY left (broader market), QQQ right (tech-specific).
const CHART_GRID: readonly ChartCellSpec[] = [
  {
    ticker: 'SPY',
    field: 'otm_dir_delta_flow',
    cumKey: 'cum_otm_dir_delta_flow',
    label: 'OTM Dir Delta',
  },
  {
    ticker: 'QQQ',
    field: 'otm_dir_delta_flow',
    cumKey: 'cum_otm_dir_delta_flow',
    label: 'OTM Dir Delta',
  },
  {
    ticker: 'SPY',
    field: 'otm_dir_vega_flow',
    cumKey: 'cum_otm_dir_vega_flow',
    label: 'OTM Dir Vega',
  },
  {
    ticker: 'QQQ',
    field: 'otm_dir_vega_flow',
    cumKey: 'cum_otm_dir_vega_flow',
    label: 'OTM Dir Vega',
  },
] as const;

function GreekFlowPanelInner({ marketOpen }: GreekFlowPanelProps) {
  const today = getETToday();
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const isLive = selectedDate === today;
  const effectiveMarketOpen = isLive ? marketOpen : false;
  const dateArg = isLive ? null : selectedDate;

  const { data, loading, error } = useGreekFlow(effectiveMarketOpen, dateArg);

  const headerRight = (
    <div className="flex items-center gap-2">
      {!isLive && (
        <button
          type="button"
          onClick={() => setSelectedDate(today)}
          className="text-secondary hover:text-primary border-edge cursor-pointer rounded border bg-transparent px-2 py-0.5 font-mono text-[10px]"
        >
          LIVE
        </button>
      )}
      <DateInput
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
        Cumulative OTM Dir Δ &amp; V flow on SPY and QQQ. Verdict combines delta
        agreement (directional bias) with vega agreement (vol regime). Refreshes
        every 60s during market hours.
      </p>
      <Body data={data} loading={loading} error={error} />
    </SectionBox>
  );
}

function Body({
  data,
  loading,
  error,
}: {
  data: GreekFlowResponse | null;
  loading: boolean;
  error: string | null;
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
  const spyRows = data.tickers.SPY.rows;
  const qqqRows = data.tickers.QQQ.rows;
  if (spyRows.length === 0 && qqqRows.length === 0) {
    return (
      <div className="text-secondary font-sans text-xs">
        No rows for {data.date}.
      </div>
    );
  }

  return (
    <>
      <VerdictTile
        delta={data.divergence.otm_dir_delta_flow}
        vega={data.divergence.otm_dir_vega_flow}
      />
      <VerdictTimeline spyRows={spyRows} qqqRows={qqqRows} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {CHART_GRID.map((spec) => {
          const tickerData = data.tickers[spec.ticker];
          const values = tickerData.rows.map((r) => r[spec.cumKey] as number);
          const fieldMetrics = tickerData.metrics[spec.field];
          const fieldDivergence = data.divergence[spec.field];
          return (
            <div
              key={`${spec.ticker}-${spec.field}`}
              className="border-edge bg-surface rounded-md border p-2"
            >
              <div className="text-primary mb-1 flex items-center justify-between font-sans text-[11px]">
                <span className="font-semibold">{spec.label}</span>
                <span className="text-secondary font-mono text-[9px]">
                  {spec.ticker}
                </span>
              </div>
              <FlowChart
                values={values}
                ariaLabel={`${spec.ticker} cumulative ${spec.label}`}
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
    </>
  );
}

export const GreekFlowPanel = memo(GreekFlowPanelInner);
