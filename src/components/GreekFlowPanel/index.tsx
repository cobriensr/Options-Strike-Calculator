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

import { memo, useMemo, useState } from 'react';
import {
  useGreekFlow,
  type GreekFlowField,
  type GreekFlowResponse,
  type GreekFlowRow,
  type GreekFlowScope,
  type GreekFlowTicker,
  type DivergenceResult,
  type SlopeResult,
  type FlipResult,
  type CliffResult,
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

const SCOPE_OPTIONS: readonly { value: GreekFlowScope; label: string }[] = [
  { value: '0dte', label: '0DTE' },
  { value: 'all', label: 'All DTE' },
] as const;

interface ChartCellSpec {
  ticker: GreekFlowTicker;
  field: GreekFlowField;
  cumKey: keyof GreekFlowRow;
  label: string;
}

// Row order: deltas first (directional read), vegas second (regime read).
// Column order: SPY left (broader market), QQQ right (tech-specific).
// Each panel overlays the underlying ETF price (slate grey, independent
// scale) as the context line — same as the UW Greek Flow dashboard.
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
  const [scope, setScope] = useState<GreekFlowScope>('0dte');
  // Two booleans, one per concern. `isToday` controls the LIVE button +
  // dateArg; `isLiveData` controls the as-of "closed" badge — historical
  // dates and after-hours both render as closed even though only one of
  // them is "today."
  const isToday = selectedDate === today;
  const isLiveData = isToday && marketOpen;
  const effectiveMarketOpen = isToday ? marketOpen : false;
  const dateArg = isToday ? null : selectedDate;

  const { data, loading, error } = useGreekFlow(
    effectiveMarketOpen,
    dateArg,
    scope,
  );

  const headerRight = (
    <div className="flex items-center gap-2">
      <div
        role="radiogroup"
        aria-label="Expiry scope"
        className="border-edge bg-surface flex overflow-hidden rounded border font-mono text-[10px]"
      >
        {SCOPE_OPTIONS.map((opt) => {
          const active = scope === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setScope(opt.value)}
              className={
                active
                  ? 'text-primary cursor-default bg-zinc-700/40 px-2 py-0.5'
                  : 'text-secondary hover:text-primary cursor-pointer px-2 py-0.5'
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {!isToday && (
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
        agreement (directional bias) with vega agreement (vol regime), driven by
        today&apos;s 0DTE intent. All-DTE is context only. Refreshes every 60s
        during market hours.
      </p>
      <Body
        data={data}
        loading={loading}
        error={error}
        scope={scope}
        isLive={isLiveData}
      />
    </SectionBox>
  );
}

interface BodyProps {
  data: GreekFlowResponse | null;
  loading: boolean;
  error: string | null;
  scope: GreekFlowScope;
  isLive: boolean;
}

function BodyInner({ data, loading, error, scope, isLive }: BodyProps) {
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
  if (data?.date == null) {
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

  // 0DTE is the actionable scope — surface the verdict + transition timeline.
  // All-DTE blends LEAPS / monthly hedging into the cumulative line, so it
  // only earns a context-only caption rather than driving a verdict.
  const showVerdict = scope === '0dte';

  return (
    <>
      {showVerdict ? (
        <>
          <VerdictTile
            delta={data.divergence.otm_dir_delta_flow}
            vega={data.divergence.otm_dir_vega_flow}
            asOf={data.asOf}
            isLive={isLive}
          />
          <VerdictTimeline spyRows={spyRows} qqqRows={qqqRows} />
        </>
      ) : (
        <div
          data-testid="greek-flow-context-caption"
          className="border-edge bg-surface text-secondary mb-3 rounded-md border px-3 py-2 font-sans text-xs"
        >
          Context only — no verdict. All-DTE blends today&apos;s 0DTE intent
          with structural LEAPS / monthly hedging. Switch to 0DTE for a
          tradeable read.
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {CHART_GRID.map((spec) => (
          <ChartCell
            key={`${spec.ticker}-${spec.field}`}
            spec={spec}
            rows={data.tickers[spec.ticker].rows}
            slope={data.tickers[spec.ticker].metrics[spec.field].slope}
            flip={data.tickers[spec.ticker].metrics[spec.field].flip}
            cliff={data.tickers[spec.ticker].metrics[spec.field].cliff}
            divergence={data.divergence[spec.field]}
          />
        ))}
      </div>
    </>
  );
}

const Body = memo(BodyInner);

interface ChartCellProps {
  spec: ChartCellSpec;
  rows: readonly GreekFlowRow[];
  slope: SlopeResult;
  flip: FlipResult;
  cliff: CliffResult;
  divergence: DivergenceResult;
}

/**
 * Per-cell wrapper. Memoized + derives its own (values, priceValues) via
 * useMemo so the derived arrays share identity until `rows` itself
 * changes. This stabilizes FlowChart's render across NON-poll
 * re-renders (scope toggle, market-hours flip, sibling-state churn) —
 * polls always produce fresh row references on a new minute bar, so
 * the chart correctly re-layouts then.
 */
function ChartCellInner({
  spec,
  rows,
  slope,
  flip,
  cliff,
  divergence,
}: ChartCellProps) {
  const values = useMemo(
    () => rows.map((r) => r[spec.cumKey] as number),
    [rows, spec.cumKey],
  );
  const priceValues = useMemo(() => rows.map((r) => r.price), [rows]);

  return (
    <div className="border-edge bg-surface rounded-md border p-2">
      <div className="text-primary mb-1 flex items-center justify-between font-sans text-[11px]">
        <span className="font-semibold">{spec.label}</span>
        <span className="text-secondary font-mono text-[9px]">
          {spec.ticker}
        </span>
      </div>
      <FlowChart
        values={values}
        priceValues={priceValues}
        ariaLabel={`${spec.ticker} cumulative ${spec.label}`}
      />
      <MetricsBar
        slope={slope}
        flip={flip}
        cliff={cliff}
        divergence={divergence}
      />
    </div>
  );
}

const ChartCell = memo(ChartCellInner);

export const GreekFlowPanel = memo(GreekFlowPanelInner);
