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

// ── Main Component ──────────────────────────────────────

export default function AccountOverview({
  cashEntries,
  accountSummary,
  pnl,
  closedSpreads,
}: AccountOverviewProps) {
  // Derive top-row values
  const balEntries = cashEntries.filter((e) => e.type === 'BAL');
  const trdEntries = cashEntries.filter((e) => e.type === 'TRD');

  const startingBalance =
    balEntries.length > 0 ? (balEntries[0]?.balance ?? 0) : 0;
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
  const feeDrag = totalCredits > 0 ? (totalFees / totalCredits) * 100 : 0;

  // Closed spreads summary
  const winners = closedSpreads.filter((s) => s.realizedPnl > 0);
  const losers = closedSpreads.filter((s) => s.realizedPnl < 0);
  const totalRealizedPnl = closedSpreads.reduce(
    (sum, s) => sum + s.realizedPnl,
    0,
  );
  const avgWinner =
    winners.length > 0
      ? winners.reduce((s, w) => s + w.realizedPnl, 0) / winners.length
      : 0;
  const avgLoser =
    losers.length > 0
      ? losers.reduce((s, l) => s + l.realizedPnl, 0) / losers.length
      : 0;
  const winRate =
    closedSpreads.length > 0
      ? (winners.length / closedSpreads.length) * 100
      : 0;
  const grossWins = winners.reduce((s, w) => s + w.realizedPnl, 0);
  const grossLosses = Math.abs(losers.reduce((s, l) => s + l.realizedPnl, 0));
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
          <span className={`font-mono text-xl font-bold ${pnlColor(grossPnl)}`}>
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
        <div className="text-tertiary font-sans text-xs font-bold tracking-wider uppercase">
          Commissions & Fees
        </div>
        <div className="mt-2 grid grid-cols-3 gap-4">
          <div>
            <div className="text-muted font-sans text-xs">Today</div>
            <div className="text-primary font-mono text-sm font-bold">
              {fmtCurrency(totalFees)}
            </div>
            {totalMiscFees > 0 && (
              <div className="text-muted font-sans text-[10px]">
                Commissions: {fmtCurrency(totalCommissions)} + Fees:{' '}
                {fmtCurrency(totalMiscFees)}
              </div>
            )}
          </div>
          <div>
            <div className="text-muted font-sans text-xs">Fee Drag</div>
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
            <div className="text-muted font-sans text-xs">YTD</div>
            <div className="text-primary font-mono text-sm font-bold">
              {fmtCurrency(accountSummary.equityCommissionsYtd)}
            </div>
          </div>
        </div>
      </div>

      {/* Closed Spreads Summary */}
      {closedSpreads.length > 0 && (
        <div className="bg-surface-alt border-edge rounded-lg border p-4">
          <div className="text-tertiary font-sans text-xs font-bold tracking-wider uppercase">
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
                {losers.length > 0 ? fmtCurrency(avgLoser) : '\u2014'}
              </span>
            </Stat>
            <Stat label="Win Rate">
              <span
                className={`font-mono font-bold ${
                  winRate >= 50 ? 'text-success' : 'text-danger'
                }`}
              >
                {fmtPct(winRate)}
              </span>
            </Stat>
            <Stat label="Profit Factor">
              <span
                className={`font-mono font-bold ${
                  profitFactor >= 1 ? 'text-success' : 'text-danger'
                }`}
              >
                {profitFactor === Infinity ? '\u221E' : profitFactor.toFixed(2)}
              </span>
            </Stat>
          </div>
        </div>
      )}

      {/* P&L from broker (if available) */}
      {pnl.totals && (
        <div className="bg-surface-alt border-edge rounded-lg border p-4">
          <div className="text-tertiary font-sans text-xs font-bold tracking-wider uppercase">
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
      <div className="text-tertiary font-sans text-xs font-bold tracking-wider uppercase">
        {label}
      </div>
      <div className="mt-1">{children}</div>
      {sub && <div className="text-muted mt-1 font-sans text-xs">{sub}</div>}
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
