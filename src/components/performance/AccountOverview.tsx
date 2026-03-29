import type {
  AccountSummary,
  CashEntry,
  ClosedSpread,
  PnLSummary,
} from './types';

interface AccountOverviewProps {
  cashEntries: readonly CashEntry[];
  accountSummary: AccountSummary;
  pnl: PnLSummary;
  closedSpreads: readonly ClosedSpread[];
}

// ── Formatting helpers ──────────────────────────────────

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

function fmtPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function pnlColor(value: number): string {
  if (value > 0) return 'text-success';
  if (value < 0) return 'text-danger';
  return 'text-primary';
}

// ── SVG Equity Curve ────────────────────────────────────

interface CurvePoint {
  time: string;
  balance: number;
  index: number;
}

function EquityCurve({
  points,
}: {
  points: readonly CurvePoint[];
}) {
  if (points.length < 2) {
    return (
      <div className="text-muted py-4 text-center font-sans text-xs">
        Not enough data for equity curve.
      </div>
    );
  }

  const balances = points.map((p) => p.balance);
  const minBal = Math.min(...balances);
  const maxBal = Math.max(...balances);
  const range = maxBal - minBal || 1;

  const W = 600;
  const H = 180;
  const PAD_X = 4;
  const PAD_TOP = 18;
  const PAD_BOTTOM = 20;
  const plotW = W - PAD_X * 2;
  const plotH = H - PAD_TOP - PAD_BOTTOM;

  const toX = (i: number) =>
    PAD_X + (i / (points.length - 1)) * plotW;
  const toY = (bal: number) =>
    PAD_TOP + plotH - ((bal - minBal) / range) * plotH;

  const pathD = points
    .map((p, i) =>
      `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(p.balance).toFixed(1)}`,
    )
    .join(' ');

  // High and low water marks
  const highIdx = balances.indexOf(maxBal);
  const lowIdx = balances.indexOf(minBal);

  // Max drawdown
  let maxDrawdown = 0;
  let peak = balances[0] ?? 0;
  for (const bal of balances) {
    if (bal > peak) peak = bal;
    const dd = peak - bal;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // First and last time labels — skip BAL entries with 00:00:00
  const tradePoints = points.filter(
    (p) => p.time !== '00:00:00',
  );
  const fmtTime = (t: string) => t.slice(0, 5);
  const firstTime = tradePoints[0]
    ? fmtTime(tradePoints[0].time)
    : '';
  const lastTime = tradePoints.at(-1)
    ? fmtTime(tradePoints.at(-1)!.time)
    : '';

  return (
    <div className="mt-1">
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        className="h-auto w-full"
        role="img"
        aria-label="Intraday equity curve"
      >
        {/* Grid lines */}
        <line
          x1={PAD_X}
          y1={toY(maxBal)}
          x2={W - PAD_X}
          y2={toY(maxBal)}
          stroke="var(--color-edge)"
          strokeDasharray="4 4"
          strokeWidth="0.5"
        />
        <line
          x1={PAD_X}
          y1={toY(minBal)}
          x2={W - PAD_X}
          y2={toY(minBal)}
          stroke="var(--color-edge)"
          strokeDasharray="4 4"
          strokeWidth="0.5"
        />

        {/* Main line */}
        <path
          d={pathD}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {/* High water mark */}
        <circle
          cx={toX(highIdx)}
          cy={toY(maxBal)}
          r="4"
          fill="var(--color-success)"
        />
        <text
          x={toX(highIdx) + (highIdx === points.length - 1 ? -8 : highIdx === 0 ? 8 : 0)}
          y={toY(maxBal) - 8}
          textAnchor={highIdx === points.length - 1 ? 'end' : highIdx === 0 ? 'start' : 'middle'}
          fill="var(--color-success)"
          fontSize="9"
          fontFamily="var(--font-mono)"
        >
          {fmtCurrency(maxBal)}
        </text>

        {/* Low water mark */}
        <circle
          cx={toX(lowIdx)}
          cy={toY(minBal)}
          r="4"
          fill="var(--color-danger)"
        />
        <text
          x={toX(lowIdx) + (lowIdx === 0 ? 8 : lowIdx === points.length - 1 ? -8 : 0)}
          y={toY(minBal) - 8}
          textAnchor={lowIdx === 0 ? 'start' : lowIdx === points.length - 1 ? 'end' : 'middle'}
          fill="var(--color-danger)"
          fontSize="9"
          fontFamily="var(--font-mono)"
        >
          {fmtCurrency(minBal)}
        </text>

        {/* Time labels */}
        <text
          x={PAD_X}
          y={H - 1}
          fill="var(--color-muted)"
          fontSize="8"
          fontFamily="var(--font-mono)"
        >
          {firstTime}
        </text>
        <text
          x={W - PAD_X}
          y={H - 1}
          textAnchor="end"
          fill="var(--color-muted)"
          fontSize="8"
          fontFamily="var(--font-mono)"
        >
          {lastTime}
        </text>
      </svg>

      {maxDrawdown > 0 && (
        <div className="text-muted mt-1 text-right font-sans text-xs">
          Max intraday drawdown:{' '}
          <span className="text-danger font-mono font-medium">
            {fmtCurrency(maxDrawdown)}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────

export default function AccountOverview({
  cashEntries,
  accountSummary,
  pnl,
  closedSpreads,
}: AccountOverviewProps) {
  // Derive top-row values
  const balEntries = cashEntries.filter(
    (e) => e.type === 'BAL',
  );
  const trdEntries = cashEntries.filter(
    (e) => e.type === 'TRD',
  );

  const startingBalance =
    balEntries.length > 0
      ? (balEntries[0]?.balance ?? 0)
      : 0;
  const lastEntry = cashEntries.at(-1);
  const endingBalance = lastEntry?.balance ?? startingBalance;

  const grossPnl = endingBalance - startingBalance;
  const totalCommissions = cashEntries.reduce(
    (sum, e) => sum + Math.abs(e.commissions),
    0,
  );
  const totalMiscFees = cashEntries.reduce(
    (sum, e) => sum + Math.abs(e.miscFees),
    0,
  );
  const totalFees = totalCommissions + totalMiscFees;
  const netPnl = grossPnl;

  // Fee drag: fees / total credits received
  const totalCredits = trdEntries.reduce(
    (sum, e) => (e.amount > 0 ? sum + e.amount : sum),
    0,
  );
  const feeDrag =
    totalCredits > 0 ? (totalFees / totalCredits) * 100 : 0;

  // Equity curve points
  const curvePoints: CurvePoint[] = cashEntries
    .filter((e) => e.type === 'BAL' || e.type === 'TRD')
    .map((e, i) => ({
      time: e.time,
      balance: e.balance,
      index: i,
    }));

  // Closed spreads summary
  const winners = closedSpreads.filter(
    (s) => s.realizedPnl > 0,
  );
  const losers = closedSpreads.filter(
    (s) => s.realizedPnl < 0,
  );
  const totalRealizedPnl = closedSpreads.reduce(
    (sum, s) => sum + s.realizedPnl,
    0,
  );
  const avgWinner =
    winners.length > 0
      ? winners.reduce((s, w) => s + w.realizedPnl, 0) /
        winners.length
      : 0;
  const avgLoser =
    losers.length > 0
      ? losers.reduce((s, l) => s + l.realizedPnl, 0) /
        losers.length
      : 0;
  const winRate =
    closedSpreads.length > 0
      ? (winners.length / closedSpreads.length) * 100
      : 0;
  const grossWins = winners.reduce(
    (s, w) => s + w.realizedPnl,
    0,
  );
  const grossLosses = Math.abs(
    losers.reduce((s, l) => s + l.realizedPnl, 0),
  );
  const profitFactor =
    grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  return (
    <div
      className="flex flex-col gap-4"
      role="region"
      aria-label="Account overview"
      data-testid="account-overview"
    >
      {/* Top row cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="Starting Balance">
          <span className="text-primary font-mono text-xl font-bold">
            {fmtCurrency(startingBalance)}
          </span>
        </Card>
        <Card label="Ending Balance">
          <span className="text-primary font-mono text-xl font-bold">
            {fmtCurrency(endingBalance)}
          </span>
        </Card>
        <Card label="Day P&L" sub={`Net: ${fmtCurrency(netPnl)}`}>
          <span
            className={`font-mono text-xl font-bold ${pnlColor(grossPnl)}`}
          >
            {fmtCurrency(grossPnl)}
          </span>
        </Card>
        <Card label="NLV">
          <span className="text-primary font-mono text-xl font-bold">
            {fmtCurrency(accountSummary.netLiquidatingValue)}
          </span>
        </Card>
      </div>

      {/* Commissions section */}
      <div className="bg-surface-alt border-edge rounded-lg border p-4">
        <div className="text-tertiary font-sans text-xs font-bold uppercase tracking-wider">
          Commissions & Fees
        </div>
        <div className="mt-2 grid grid-cols-3 gap-4">
          <div>
            <div className="text-muted font-sans text-xs">
              Today
            </div>
            <div className="text-primary font-mono text-sm font-bold">
              {fmtCurrency(totalFees)}
            </div>
            {totalMiscFees > 0 && (
              <div className="text-muted font-sans text-[10px]">
                Commissions: {fmtCurrency(totalCommissions)} +
                Fees: {fmtCurrency(totalMiscFees)}
              </div>
            )}
          </div>
          <div>
            <div className="text-muted font-sans text-xs">
              Fee Drag
            </div>
            <div
              className={`font-mono text-sm font-bold ${
                feeDrag > 5 ? 'text-caution' : 'text-primary'
              }`}
            >
              {fmtPct(feeDrag)}
            </div>
            <div className="text-muted font-sans text-[10px]">
              % of credits received
            </div>
          </div>
          <div>
            <div className="text-muted font-sans text-xs">
              YTD
            </div>
            <div className="text-primary font-mono text-sm font-bold">
              {fmtCurrency(
                accountSummary.equityCommissionsYtd,
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Intraday Equity Curve */}
      <div className="bg-surface-alt border-edge rounded-lg border p-4">
        <div className="text-tertiary font-sans text-xs font-bold uppercase tracking-wider">
          Intraday Equity Curve
        </div>
        <EquityCurve points={curvePoints} />
      </div>

      {/* Closed Spreads Summary */}
      {closedSpreads.length > 0 && (
        <div className="bg-surface-alt border-edge rounded-lg border p-4">
          <div className="text-tertiary font-sans text-xs font-bold uppercase tracking-wider">
            Closed Spreads
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Stat label="Record">
              <span className="text-success font-mono font-bold">
                {winners.length}W
              </span>
              <span className="text-muted mx-0.5">/</span>
              <span className="text-danger font-mono font-bold">
                {losers.length}L
              </span>
            </Stat>
            <Stat label="Realized P&L">
              <span
                className={`font-mono font-bold ${pnlColor(totalRealizedPnl)}`}
              >
                {fmtCurrency(totalRealizedPnl)}
              </span>
            </Stat>
            <Stat label="Avg Winner">
              <span className="text-success font-mono font-bold">
                {avgWinner > 0 ? fmtCurrency(avgWinner) : '\u2014'}
              </span>
            </Stat>
            <Stat label="Avg Loser">
              <span className="text-danger font-mono font-bold">
                {losers.length > 0
                  ? fmtCurrency(avgLoser)
                  : '\u2014'}
              </span>
            </Stat>
            <Stat label="Win Rate">
              <span
                className={`font-mono font-bold ${
                  winRate >= 50
                    ? 'text-success'
                    : 'text-danger'
                }`}
              >
                {fmtPct(winRate)}
              </span>
            </Stat>
            <Stat label="Profit Factor">
              <span
                className={`font-mono font-bold ${
                  profitFactor >= 1
                    ? 'text-success'
                    : 'text-danger'
                }`}
              >
                {profitFactor === Infinity
                  ? '\u221E'
                  : profitFactor.toFixed(2)}
              </span>
            </Stat>
          </div>
        </div>
      )}

      {/* P&L from broker (if available) */}
      {pnl.totals && (
        <div className="bg-surface-alt border-edge rounded-lg border p-4">
          <div className="text-tertiary font-sans text-xs font-bold uppercase tracking-wider">
            Broker P&L (Profits & Losses)
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="P&L Open">
              <span
                className={`font-mono font-bold ${pnlColor(pnl.totals.plOpen)}`}
              >
                {fmtCurrency(pnl.totals.plOpen)}
              </span>
            </Stat>
            <Stat label="P&L Day">
              <span
                className={`font-mono font-bold ${pnlColor(pnl.totals.plDay)}`}
              >
                {fmtCurrency(pnl.totals.plDay)}
              </span>
            </Stat>
            <Stat label="P&L YTD">
              <span
                className={`font-mono font-bold ${pnlColor(pnl.totals.plYtd)}`}
              >
                {fmtCurrency(pnl.totals.plYtd)}
              </span>
            </Stat>
            <Stat label="Margin Req">
              <span className="text-primary font-mono font-bold">
                {fmtCurrency(pnl.totals.marginReq)}
              </span>
            </Stat>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Card Primitive ──────────────────────────────────────

function Card({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface-alt border-edge rounded-lg border p-4">
      <div className="text-tertiary font-sans text-xs font-bold uppercase tracking-wider">
        {label}
      </div>
      <div className="mt-1">{children}</div>
      {sub && (
        <div className="text-muted mt-1 font-sans text-xs">
          {sub}
        </div>
      )}
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
      <div className="text-muted font-sans text-xs">
        {label}
      </div>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}
