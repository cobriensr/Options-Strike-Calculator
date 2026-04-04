import type { ExecutionQuality as ExecQualityT } from './types';

interface ExecutionQualityProps {
  execution: ExecQualityT;
}

// ── Formatting helpers ──────────────────────────────────

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtCurrency(value: number): string {
  if (value < 0) {
    return `($${Math.abs(value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })})`;
  }
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtTime(time: string | null): string {
  if (!time) return '\u2014';
  if (time.includes('T')) {
    const part = time.split('T')[1];
    return part ? part.slice(0, 5) : time;
  }
  return time.slice(0, 5);
}

// ── Main Component ──────────────────────────────────────

export default function ExecutionQuality({ execution }: Readonly<ExecutionQualityProps>) {
  const {
    fills,
    fillRate,
    rejectedOrders,
    canceledOrders,
    replacementChains,
    rejectionRate,
    cancellationRate,
    rejectionReasons,
    firstTradeTime,
    lastTradeTime,
    tradingSessionMinutes,
    tradesPerHour,
    averageSlippage,
    totalSlippageDollars,
  } = execution;

  const totalOrders =
    rejectionRate > 0
      ? Math.round(rejectedOrders / rejectionRate)
      : fills.length + rejectedOrders + canceledOrders;

  return (
    <div
      className="flex flex-col gap-4"
      role="region"
      aria-label="Execution quality"
      data-testid="execution-quality"
    >
      {/* Order Flow Summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="Fill Rate">
          <span className="text-primary font-mono text-xl font-bold">
            {fmtPct(fillRate)}
          </span>
          <div className="text-muted mt-0.5 font-sans text-xs">
            {fills.length}/{totalOrders} orders
          </div>
        </Card>

        <Card label="Rejected">
          <span
            className={`font-mono text-xl font-bold ${
              rejectedOrders > 0 ? 'text-danger' : 'text-success'
            }`}
          >
            {rejectedOrders}
          </span>
          <div className="text-muted mt-0.5 font-sans text-xs">
            {fmtPct(rejectionRate)} rate
          </div>
          {rejectionReasons.length > 0 && rejectionReasons[0] && (
            <div className="text-danger mt-0.5 font-sans text-[10px]">
              Top: {rejectionReasons[0].reason}
            </div>
          )}
        </Card>

        <Card label="Canceled">
          <span className="text-primary font-mono text-xl font-bold">
            {canceledOrders}
          </span>
          <div className="text-muted mt-0.5 font-sans text-xs">
            {fmtPct(cancellationRate)} rate
          </div>
        </Card>

        <Card label="Replacements">
          <span className="text-primary font-mono text-xl font-bold">
            {replacementChains}
          </span>
          <div className="text-muted mt-0.5 font-sans text-xs">
            amendment chains
          </div>
        </Card>
      </div>

      {/* Rejection Reasons */}
      {rejectionReasons.length > 0 && (
        <div className="bg-surface-alt border-edge rounded-lg border p-4">
          <div className="text-tertiary font-sans text-xs font-bold tracking-wider uppercase">
            Rejection Reasons
          </div>
          <ul className="mt-2 space-y-1">
            {[...rejectionReasons]
              .sort((a, b) => b.count - a.count)
              .map((r) => (
                <li
                  key={r.reason}
                  className="flex items-baseline gap-2 font-sans text-sm"
                >
                  <span className="text-danger font-mono text-xs font-bold">
                    {r.count}x
                  </span>
                  <span className="text-secondary">{r.reason}</span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* Slippage + Session Timing */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* Slippage */}
        <div className="bg-surface-alt border-edge rounded-lg border p-4">
          <div className="text-tertiary font-sans text-xs font-bold tracking-wider uppercase">
            Slippage
          </div>
          {fills.length > 0 ? (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Stat label="Avg Slippage">
                <span
                  className={`font-mono font-bold ${
                    averageSlippage < 0
                      ? 'text-success'
                      : averageSlippage > 0
                        ? 'text-danger'
                        : 'text-primary'
                  }`}
                >
                  {averageSlippage.toFixed(2)}c
                </span>
              </Stat>
              <Stat label="Total Cost">
                <span
                  className={`font-mono font-bold ${
                    totalSlippageDollars < 0
                      ? 'text-success'
                      : totalSlippageDollars > 0
                        ? 'text-danger'
                        : 'text-primary'
                  }`}
                >
                  {fmtCurrency(totalSlippageDollars)}
                </span>
              </Stat>
            </div>
          ) : (
            <div className="text-muted mt-2 font-sans text-xs">
              No slippage data available.
            </div>
          )}
          {fills.length > 0 && (
            <div className="text-muted mt-1 font-sans text-[10px]">
              {averageSlippage < 0
                ? 'Favorable (you got better prices)'
                : averageSlippage > 0
                  ? 'Adverse (you got worse prices)'
                  : 'Flat (filled at limit)'}
            </div>
          )}
        </div>

        {/* Session Timing */}
        <div className="bg-surface-alt border-edge rounded-lg border p-4">
          <div className="text-tertiary font-sans text-xs font-bold tracking-wider uppercase">
            Session Timing
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Stat label="First Trade">
              <span className="text-primary font-mono font-bold">
                {fmtTime(firstTradeTime)}
              </span>
            </Stat>
            <Stat label="Last Trade">
              <span className="text-primary font-mono font-bold">
                {fmtTime(lastTradeTime)}
              </span>
            </Stat>
            <Stat label="Session">
              <span className="text-primary font-mono font-bold">
                {tradingSessionMinutes !== null
                  ? `${String(tradingSessionMinutes)} min`
                  : '\u2014'}
              </span>
            </Stat>
            <Stat label="Trades/Hour">
              <span className="text-primary font-mono font-bold">
                {tradesPerHour !== null ? tradesPerHour.toFixed(1) : '\u2014'}
              </span>
            </Stat>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Card Primitive ──────────────────────────────────────

function Card({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface-alt border-edge rounded-lg border p-4">
      <div className="text-tertiary font-sans text-xs font-bold tracking-wider uppercase">
        {label}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// ── Stat Primitive ──────────────────────────────────────

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-muted font-sans text-xs">{label}</div>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}
