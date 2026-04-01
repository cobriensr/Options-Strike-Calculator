import { useState } from 'react';

type Mode = 'sell' | 'buy';

export function useRiskCalculator() {
  const [mode, setMode] = useState<Mode>('sell');
  const [balance, setBalance] = useState('');
  const [wing, setWing] = useState(10);
  const [contracts, setContracts] = useState(1);
  const [creditInput, setCreditInput] = useState('');
  const [premiumInput, setPremiumInput] = useState('');
  const [targetExitInput, setTargetExitInput] = useState('');
  const [deltaInput, setDeltaInput] = useState('');
  const [popInput, setPopInput] = useState('');
  const [stopMultiple, setStopMultiple] = useState<number | null>(null);
  const [buyStopPct, setBuyStopPct] = useState<number | null>(null);
  const [portfolioCap, setPortfolioCap] = useState(100);

  const bal = Number.parseFloat(balance) || 0;
  const delta = Number.parseFloat(deltaInput) || 0;
  const hasDelta = delta > 0;

  // Sell-side calculations
  const credit = Number.parseFloat(creditInput) || 0;
  const creditPerContract = credit * 100;
  const grossLossPerContract = wing * 100;
  const netLossPerContract = Math.max(
    0,
    grossLossPerContract - creditPerContract,
  );
  const hasCredit = credit > 0;

  // Stop loss: if set, max loss = (stopMultiple × credit - credit) × 100
  // i.e. you buy back at stopMultiple × credit, losing the difference
  const hasStop = mode === 'sell' && hasCredit && stopMultiple !== null;
  const stopLossPerContract = hasStop
    ? (stopMultiple - 1) * creditPerContract
    : 0;

  // Buy-side calculations
  const premium = Number.parseFloat(premiumInput) || 0;
  const premiumPerContract = premium * 100;
  const hasBuyStop = mode === 'buy' && premium > 0 && buyStopPct !== null;
  const buyStopLossPerContract = hasBuyStop
    ? premiumPerContract * (buyStopPct / 100)
    : premiumPerContract;

  // Unified loss figure based on mode
  const lossPerContract =
    mode === 'buy'
      ? buyStopLossPerContract
      : hasStop
        ? Math.min(stopLossPerContract, netLossPerContract)
        : hasCredit
          ? netLossPerContract
          : grossLossPerContract;

  const totalLoss = lossPerContract * contracts;
  const lossPct = bal > 0 ? (totalLoss / bal) * 100 : 0;

  // Buying power required (always based on spread width, not stop)
  const bpPerContract =
    mode === 'buy' ? premiumPerContract : netLossPerContract;
  const totalBp = bpPerContract * contracts;

  // Buy-side target exit
  const targetExit = Number.parseFloat(targetExitInput) || 0;
  const hasTarget = mode === 'buy' && targetExit > premium && premium > 0;
  const buyProfitPerContract = hasTarget ? (targetExit - premium) * 100 : 0;

  // Risk/reward — sell: credit vs net loss; buy: premium vs target profit
  const maxProfit =
    mode === 'sell' && hasCredit
      ? creditPerContract
      : hasTarget
        ? buyProfitPerContract
        : 0;
  const rrRatio =
    maxProfit > 0 && lossPerContract > 0 ? lossPerContract / maxProfit : 0;

  // Max concurrent positions
  const maxPositions = lossPct > 0 ? Math.floor(portfolioCap / lossPct) : 0;

  // Probability of profit & expected value
  const pop = Number.parseFloat(popInput) || 0;
  const hasPop = pop > 0 && pop < 100;
  const evPerContract =
    hasPop && maxProfit > 0
      ? (pop / 100) * maxProfit - ((100 - pop) / 100) * lossPerContract
      : 0;

  const creditPct = wing > 0 ? credit / wing : 0;

  return {
    // State values
    mode,
    balance,
    wing,
    contracts,
    creditInput,
    premiumInput,
    targetExitInput,
    deltaInput,
    popInput,
    stopMultiple,
    buyStopPct,
    portfolioCap,

    // State setters
    setMode,
    setBalance,
    setWing,
    setContracts,
    setCreditInput,
    setPremiumInput,
    setTargetExitInput,
    setDeltaInput,
    setPopInput,
    setStopMultiple,
    setBuyStopPct,
    setPortfolioCap,

    // Derived values
    bal,
    delta,
    hasDelta,
    credit,
    creditPerContract,
    grossLossPerContract,
    netLossPerContract,
    hasCredit,
    hasStop,
    stopLossPerContract,
    premium,
    premiumPerContract,
    hasBuyStop,
    buyStopLossPerContract,
    lossPerContract,
    totalLoss,
    lossPct,
    bpPerContract,
    totalBp,
    targetExit,
    hasTarget,
    buyProfitPerContract,
    maxProfit,
    rrRatio,
    maxPositions,
    pop,
    hasPop,
    evPerContract,
    creditPct,
  };
}
