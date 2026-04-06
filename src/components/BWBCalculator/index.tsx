import { useState, useCallback, useEffect } from 'react';
import type { BWBSide } from './bwb-math';
import { calcMetrics, generatePnlRows } from './bwb-math';
import BWBInputs from './BWBInputs';
import BWBResults from './BWBResults';

interface BWBCalculatorProps {
  selectedDate?: string;
}

export default function BWBCalculator({
  selectedDate,
}: Readonly<BWBCalculatorProps>) {
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
    (ss: number, narrow: number, wide: number, s: BWBSide) => {
      if (s === 'calls') {
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
    if (Number.isFinite(ss)) fillStrikes(ss, narrowWing, wideWing, side);
  };

  const handleNarrowChange = (value: string) => {
    const n = Number.parseInt(value);
    if (Number.isFinite(n) && n > 0) {
      setNarrowWing(n);
      const ss = Number.parseFloat(sweetSpot);
      if (Number.isFinite(ss)) fillStrikes(ss, n, wideWing, side);
    }
  };

  const handleWideChange = (value: string) => {
    const w = Number.parseInt(value);
    if (Number.isFinite(w) && w > 0) {
      setWideWing(w);
      const ss = Number.parseFloat(sweetSpot);
      if (Number.isFinite(ss)) fillStrikes(ss, narrowWing, w, side);
    }
  };

  const handleSideChange = (s: BWBSide) => {
    setSide(s);
    const ss = Number.parseFloat(sweetSpot);
    if (Number.isFinite(ss)) fillStrikes(ss, narrowWing, wideWing, s);
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
    <section
      aria-label="BWB live calculator"
      className="animate-fade-in-up bg-surface border-edge border-t-accent mt-6 flex flex-col rounded-[14px] border-[1.5px] border-t-[3px] p-[18px] pb-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"
    >
      <BWBInputs
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
        onClear={handleClear}
        onRefreshAnchor={refreshAnchor}
      />

      {/* Results — only when all inputs are valid */}
      {allValid && metrics && (
        <BWBResults
          side={side}
          contracts={contracts}
          low={low}
          mid={mid}
          high={high}
          net={net}
          metrics={metrics}
          pnlRows={pnlRows}
          midStrike={midStrike}
        />
      )}

      {/* Empty state */}
      {!allValid && (
        <div className="text-muted mt-4 text-center text-sm italic">
          Enter three strikes and a fill price to see the P&L profile.
        </div>
      )}
    </section>
  );
}
