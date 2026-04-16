import { useState, useCallback, useEffect } from 'react';
import type { BWBSide, StrategyMode, IronFlyMetrics } from './bwb-math';
import {
  calcMetrics,
  generatePnlRows,
  calcIronFlyMetrics,
  generateIronFlyPnlRows,
} from './bwb-math';
import BWBInputs from './BWBInputs';
import BWBResults from './BWBResults';
import VixRegimeBanner from '../VixRegimeBanner';
import { SectionBox } from '../ui';

interface BWBCalculatorProps {
  selectedDate?: string;
  vix?: string | number | null;
}

export default function BWBCalculator({
  selectedDate,
  vix,
}: Readonly<BWBCalculatorProps>) {
  const [strategy, setStrategy] = useState<StrategyMode>('bwb');
  const [side, setSide] = useState<BWBSide>('calls');
  const [lowStrike, setLowStrike] = useState('');
  const [midStrike, setMidStrike] = useState('');
  const [highStrike, setHighStrike] = useState('');
  const [netInput, setNetInput] = useState('');
  const [isCredit, setIsCredit] = useState(true);
  const [contracts, setContracts] = useState(1);

  // Sweet spot auto-fill state
  const [sweetSpot, setSweetSpot] = useState('');
  const [narrowWing, setNarrowWing] = useState(20);
  const [wideWing, setWideWing] = useState(40);

  // Gamma anchor from API
  const [anchor, setAnchor] = useState<{
    strike: number;
    price: number;
    dist: number;
    charmAdjusted: number;
  } | null>(null);
  const [useCharm, setUseCharm] = useState(false);
  const [anchorKey, setAnchorKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const qs = selectedDate ? `?date=${selectedDate}` : '';
    fetch(`/api/bwb-anchor${qs}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.anchor) return;
        setAnchor({
          strike: data.anchor,
          price: data.price,
          dist: data.distFromPrice,
          charmAdjusted: data.charmAdjusted,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedDate, anchorKey]);

  const refreshAnchor = useCallback(() => setAnchorKey((k) => k + 1), []);

  // Auto-fill strikes from sweet spot + wing widths
  const fillStrikes = useCallback(
    (
      ss: number,
      narrow: number,
      wide: number,
      s: BWBSide,
      strat: StrategyMode,
    ) => {
      if (strat === 'iron-fly' || s === 'calls') {
        setLowStrike(String(ss - narrow));
        setMidStrike(String(ss));
        setHighStrike(String(ss + wide));
      } else {
        setLowStrike(String(ss - wide));
        setMidStrike(String(ss));
        setHighStrike(String(ss + narrow));
      }
    },
    [],
  );

  const handleSweetSpotChange = (value: string) => {
    setSweetSpot(value);
    const ss = Number.parseFloat(value);
    if (Number.isFinite(ss))
      fillStrikes(ss, narrowWing, wideWing, side, strategy);
  };

  const handleNarrowChange = (value: string) => {
    const n = Number.parseInt(value);
    if (Number.isFinite(n) && n > 0) {
      setNarrowWing(n);
      const ss = Number.parseFloat(sweetSpot);
      if (Number.isFinite(ss)) fillStrikes(ss, n, wideWing, side, strategy);
    }
  };

  const handleWideChange = (value: string) => {
    const w = Number.parseInt(value);
    if (Number.isFinite(w) && w > 0) {
      setWideWing(w);
      const ss = Number.parseFloat(sweetSpot);
      if (Number.isFinite(ss)) fillStrikes(ss, narrowWing, w, side, strategy);
    }
  };

  const handleSideChange = (s: BWBSide) => {
    setSide(s);
    const ss = Number.parseFloat(sweetSpot);
    if (Number.isFinite(ss)) fillStrikes(ss, narrowWing, wideWing, s, strategy);
  };

  const handleStrategyChange = (s: StrategyMode) => {
    setStrategy(s);
    const ss = Number.parseFloat(sweetSpot);
    if (Number.isFinite(ss)) fillStrikes(ss, narrowWing, wideWing, side, s);
  };

  // Parse inputs
  const low = Number.parseFloat(lowStrike);
  const mid = Number.parseFloat(midStrike);
  const high = Number.parseFloat(highStrike);

  const strikesValid =
    Number.isFinite(low) &&
    Number.isFinite(mid) &&
    Number.isFinite(high) &&
    low < mid &&
    mid < high;
  const netParsed = Number.parseFloat(netInput);
  const priceValid = Number.isFinite(netParsed) && netParsed >= 0;
  const allValid = strikesValid && priceValid;

  const net = allValid ? (isCredit ? netParsed : -netParsed) : 0;
  const metrics = allValid ? calcMetrics(side, low, mid, high, net) : null;
  const pnlRows = allValid
    ? generatePnlRows(side, low, mid, high, net, contracts)
    : [];
  const ironFlyMetrics: IronFlyMetrics | null =
    allValid && strategy === 'iron-fly'
      ? calcIronFlyMetrics(low, mid, high, net)
      : null;
  const ironFlyRows =
    allValid && strategy === 'iron-fly'
      ? generateIronFlyPnlRows(low, mid, high, net, contracts)
      : [];

  const handleClear = () => {
    setSweetSpot('');
    setLowStrike('');
    setMidStrike('');
    setHighStrike('');
    setNetInput('');
    setIsCredit(true);
    setContracts(1);
  };

  return (
    <SectionBox
      label={
        strategy === 'bwb' ? 'Settlement Pin Calculator' : 'Iron Fly Calculator'
      }
      collapsible
      headerRight={
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {(['bwb', 'iron-fly'] as const).map((s) => (
              <button
                key={s}
                onClick={() => handleStrategyChange(s)}
                className={
                  'cursor-pointer rounded-md border-[1.5px] px-2.5 py-1 font-sans text-[10px] font-bold tracking-[0.08em] uppercase transition-colors duration-100 ' +
                  (strategy === s
                    ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                    : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt')
                }
              >
                {s === 'bwb' ? 'BWB' : 'Iron Fly'}
              </button>
            ))}
          </div>
          <button
            onClick={handleClear}
            className="border-edge-strong bg-chip-bg text-secondary cursor-pointer rounded-md border-[1.5px] px-3 py-1.5 font-sans text-xs font-semibold hover:border-red-400 hover:text-red-400"
          >
            Clear
          </button>
        </div>
      }
    >
      <VixRegimeBanner vix={vix} />

      <BWBInputs
        strategy={strategy}
        side={side}
        contracts={contracts}
        sweetSpot={sweetSpot}
        narrowWing={narrowWing}
        wideWing={wideWing}
        lowStrike={lowStrike}
        midStrike={midStrike}
        highStrike={highStrike}
        netInput={netInput}
        isCredit={isCredit}
        anchor={anchor}
        useCharm={useCharm}
        strikesValid={strikesValid}
        onSideChange={handleSideChange}
        setContracts={setContracts}
        onSweetSpotChange={handleSweetSpotChange}
        onNarrowChange={handleNarrowChange}
        onWideChange={handleWideChange}
        setLowStrike={setLowStrike}
        setMidStrike={setMidStrike}
        setHighStrike={setHighStrike}
        setSweetSpot={setSweetSpot}
        setNetInput={setNetInput}
        setIsCredit={setIsCredit}
        setUseCharm={setUseCharm}
        onRefreshAnchor={refreshAnchor}
      />

      {/* Results — only when all inputs are valid */}
      {allValid && metrics && (
        <BWBResults
          strategy={strategy}
          side={side}
          contracts={contracts}
          low={low}
          mid={mid}
          high={high}
          net={net}
          metrics={metrics}
          ironFlyMetrics={ironFlyMetrics}
          pnlRows={strategy === 'iron-fly' ? ironFlyRows : pnlRows}
          midStrike={midStrike}
        />
      )}

      {/* Empty state */}
      {!allValid && (
        <div className="text-muted mt-4 text-center text-sm italic">
          Enter three strikes and a fill price to see the P&L profile.
        </div>
      )}
    </SectionBox>
  );
}
