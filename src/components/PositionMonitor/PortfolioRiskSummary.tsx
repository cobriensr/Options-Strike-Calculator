import type {
  AccountSummary,
  HedgePosition,
  IronCondor,
  PortfolioRisk,
  Spread,
} from './types';

interface PortfolioRiskSummaryProps {
  risk: PortfolioRisk;
  accountSummary: AccountSummary;
  spreads: readonly Spread[];
  ironCondors: readonly IronCondor[];
  hedges: readonly HedgePosition[];
  /** 0 = theoretical max loss, 2/3/4 = stop at Nx credit per spread */
  stopMultiplier: number;
  onStopMultiplierChange: (value: number) => void;
}

function formatCurrency(value: number): string {
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

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

/** Color class for max-loss severity relative to NLV */
function heatColor(maxLoss: number, nlv: number): string {
  if (nlv <= 0) return 'text-danger';
  const pct = (Math.abs(maxLoss) / nlv) * 100;
  if (pct > 25) return 'text-danger';
  if (pct > 10) return 'text-caution';
  return 'text-success';
}

/**
 * Compute effective max loss using per-spread stop multiplier.
 * Each spread's effective loss = min(credit x multiplier, theoretical max loss).
 * For ICs, apply to each side independently (only one side can lose).
 */
function computeEffectiveMaxLoss(
  spreads: readonly Spread[],
  ironCondors: readonly IronCondor[],
  multiplier: number,
): number {
  let callSideRisk = 0;
  let putSideRisk = 0;

  // creditReceived and maxLoss are already total dollar values
  // (per-contract credit * $100 multiplier * contracts), so no
  // additional scaling needed.
  for (const s of spreads) {
    const effectiveLoss = Math.min(s.creditReceived * multiplier, s.maxLoss);
    if (s.spreadType === 'CALL_CREDIT_SPREAD') {
      callSideRisk += effectiveLoss;
    } else {
      putSideRisk += effectiveLoss;
    }
  }

  for (const ic of ironCondors) {
    const callEffective = Math.min(
      ic.callSpread.creditReceived * multiplier,
      ic.callSpread.maxLoss,
    );
    const putEffective = Math.min(
      ic.putSpread.creditReceived * multiplier,
      ic.putSpread.maxLoss,
    );
    callSideRisk += callEffective;
    putSideRisk += putEffective;
  }

  // ICs can only lose on one side
  return Math.max(callSideRisk, putSideRisk);
}

export default function PortfolioRiskSummary({
  risk,
  accountSummary,
  spreads,
  ironCondors,
  hedges,
  stopMultiplier,
  onStopMultiplierChange,
}: PortfolioRiskSummaryProps) {
  const nlv = accountSummary.netLiquidatingValue;

  const effectiveMaxLoss =
    stopMultiplier > 0
      ? computeEffectiveMaxLoss(spreads, ironCondors, stopMultiplier)
      : risk.totalMaxLoss;
  const portfolioHeat = nlv > 0 ? (Math.abs(effectiveMaxLoss) / nlv) * 100 : 0;
  const canAbsorb = risk.buyingPowerAvailable > effectiveMaxLoss;
  const bpTotal = risk.buyingPowerUsed + risk.buyingPowerAvailable;
  const bpUtilPct = bpTotal > 0 ? (risk.buyingPowerUsed / bpTotal) * 100 : 0;

  // Find risk boundaries from spreads + ICs
  const shortPuts = [
    ...spreads
      .filter((s) => s.spreadType === 'PUT_CREDIT_SPREAD')
      .map((s) => s.shortLeg.strike),
    ...ironCondors.map((ic) => ic.putSpread.shortLeg.strike),
  ];
  const shortCalls = [
    ...spreads
      .filter((s) => s.spreadType === 'CALL_CREDIT_SPREAD')
      .map((s) => s.shortLeg.strike),
    ...ironCondors.map((ic) => ic.callSpread.shortLeg.strike),
  ];

  const lowestPut = shortPuts.length > 0 ? Math.min(...shortPuts) : null;
  const highestCall = shortCalls.length > 0 ? Math.max(...shortCalls) : null;

  const putDist =
    lowestPut !== null && risk.spotPrice > 0
      ? ((risk.spotPrice - lowestPut) / risk.spotPrice) * 100
      : null;
  const callDist =
    highestCall !== null && risk.spotPrice > 0
      ? ((highestCall - risk.spotPrice) / risk.spotPrice) * 100
      : null;

  // Side breakdown
  const maxSideRisk = Math.max(
    Math.abs(risk.netCallRisk),
    Math.abs(risk.netPutRisk),
    1,
  );

  const putBarPct = (Math.abs(risk.putSideRisk) / maxSideRisk) * 100;
  const callBarPct = (Math.abs(risk.callSideRisk) / maxSideRisk) * 100;

  const hedgeSuffix =
    hedges.length > 0
      ? ' (' +
        String(hedges.length) +
        (hedges.length === 1 ? ' hedge)' : ' hedges)')
      : '';
  const sideBreakdownSub = 'Net risk by side' + hedgeSuffix;

  return (
    <div
      className="grid grid-cols-2 gap-3 md:grid-cols-4"
      role="region"
      aria-label="Portfolio risk summary"
    >
      {/* 1 — Total Max Loss (adjusted for stop multiplier) */}
      <Card
        label={
          stopMultiplier > 0
            ? `Max Loss (${stopMultiplier}x stop)`
            : 'Total Max Loss'
        }
        sub={`${formatPct(portfolioHeat)} of NLV`}
      >
        <span
          className={`font-mono text-xl font-bold ${heatColor(effectiveMaxLoss, nlv)}`}
        >
          {formatCurrency(effectiveMaxLoss)}
        </span>
      </Card>

      {/* 2 — Total Credit */}
      <Card label="Total Credit" sub={`${risk.totalContracts} contracts`}>
        <span className="text-success font-mono text-xl font-bold">
          {formatCurrency(risk.totalCredit)}
        </span>
      </Card>

      {/* 3 — Portfolio Heat */}
      <Card label="Portfolio Heat" sub="Max loss / NLV">
        <span
          className={`font-mono text-xl font-bold ${heatColor(effectiveMaxLoss, nlv)}`}
        >
          {formatPct(portfolioHeat)}
        </span>
      </Card>

      {/* 4 — Buying Power */}
      <Card label="Buying Power" sub={`${formatPct(bpUtilPct)} utilized`}>
        <span className="text-primary font-mono text-xl font-bold">
          {formatCurrency(risk.buyingPowerAvailable)}
        </span>
        {/* Utilization bar */}
        <div className="bg-edge mt-2 h-1.5 w-full overflow-hidden rounded-full">
          <div
            className={`h-full rounded-full transition-all ${
              bpUtilPct > 80
                ? 'bg-danger'
                : bpUtilPct > 50
                  ? 'bg-caution'
                  : 'bg-success'
            }`}
            style={{ width: `${Math.min(bpUtilPct, 100)}%` }}
          />
        </div>
      </Card>

      {/* 5 — Risk Boundaries */}
      <Card label="Risk Boundaries" sub="Lowest put / Highest call">
        <div className="flex items-baseline gap-2">
          {lowestPut === null ? (
            <span className="text-muted font-mono text-base">{'\u2014'}</span>
          ) : (
            <span className="font-mono text-base font-bold text-red-400">
              {lowestPut}
              <span className="text-muted ml-0.5 text-[10px] font-normal">
                ({putDist === null ? '\u2014' : formatPct(putDist)})
              </span>
            </span>
          )}
          <span className="text-muted text-xs">/</span>
          {highestCall === null ? (
            <span className="text-muted font-mono text-base">{'\u2014'}</span>
          ) : (
            <span className="font-mono text-base font-bold text-green-400">
              {highestCall}
              <span className="text-muted ml-0.5 text-[10px] font-normal">
                ({callDist === null ? '\u2014' : formatPct(callDist)})
              </span>
            </span>
          )}
        </div>
      </Card>

      {/* 6 — Breakeven Range */}
      <Card label="Breakeven Range" sub="Net credit adjusted">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-base font-bold text-red-400">
            {risk.breakevenLow === null
              ? '\u2014'
              : risk.breakevenLow.toFixed(2)}
          </span>
          <span className="text-muted text-xs">to</span>
          <span className="font-mono text-base font-bold text-green-400">
            {risk.breakevenHigh === null
              ? '\u2014'
              : risk.breakevenHigh.toFixed(2)}
          </span>
        </div>
      </Card>

      {/* 7 — Side Breakdown */}
      <Card label="Side Breakdown" sub={sideBreakdownSub}>
        <div className="flex w-full flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="w-8 text-[10px] font-bold text-red-400">PUT</span>
            <div className="bg-edge relative h-3 flex-1 overflow-hidden rounded">
              <div
                className="absolute inset-y-0 left-0 rounded bg-red-400/60"
                style={{ width: `${Math.min(putBarPct, 100)}%` }}
              />
            </div>
            <span className="w-16 text-right font-mono text-[11px]">
              {formatCurrency(risk.netPutRisk)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-8 text-[10px] font-bold text-green-400">
              CALL
            </span>
            <div className="bg-edge relative h-3 flex-1 overflow-hidden rounded">
              <div
                className="absolute inset-y-0 left-0 rounded bg-green-400/60"
                style={{ width: `${Math.min(callBarPct, 100)}%` }}
              />
            </div>
            <span className="w-16 text-right font-mono text-[11px]">
              {formatCurrency(risk.netCallRisk)}
            </span>
          </div>
        </div>
      </Card>

      {/* 8 — Can Absorb */}
      <Card label="Can Absorb" sub="BP covers max loss?">
        <div className="flex items-center gap-2">
          <span
            className={`text-xl ${canAbsorb ? 'text-success' : 'text-danger'}`}
            aria-hidden="true"
          >
            {canAbsorb ? '\u2713' : '\u2717'}
          </span>
          <span
            className={`font-sans text-base font-bold ${canAbsorb ? 'text-success' : 'text-danger'}`}
          >
            {canAbsorb ? 'Yes' : 'No'}
          </span>
        </div>
      </Card>

      {/* 9 — Stop Multiplier Selector */}
      <div className="col-span-2 md:col-span-4">
        <div className="flex items-center gap-3">
          <span className="text-tertiary font-sans text-xs font-bold tracking-wider uppercase">
            Stop Loss
          </span>
          {[0, 2, 3, 4].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onStopMultiplierChange(m)}
              className={`rounded-md px-3 py-1 font-sans text-xs font-bold transition-colors ${
                stopMultiplier === m
                  ? 'bg-accent text-white'
                  : 'bg-surface-alt text-secondary hover:bg-edge'
              }`}
            >
              {m === 0 ? 'Full' : `${m}x`}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Card Primitive ────────────────────────────────────────

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
