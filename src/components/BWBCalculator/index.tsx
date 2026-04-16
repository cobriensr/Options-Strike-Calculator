import { useState, useCallback, useEffect } from 'react';
import type { BWBSide } from './bwb-math';
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

const INPUT =
  'bg-input border-[1.5px] border-edge-strong hover:border-edge-heavy rounded-lg text-primary p-[10px_12px] text-[15px] font-mono outline-none w-full transition-[border-color] duration-150';
const LABEL =
  'text-tertiary font-sans text-[10px] font-bold uppercase tracking-[0.08em]';

interface BWBCalculatorProps {
  selectedDate?: string;
  vix?: string | number | null;
}

export default function BWBCalculator({
  selectedDate,
  vix,
}: Readonly<BWBCalculatorProps>) {
  const [side, setSide] = useState<BWBSide>('calls');
  const [lowStrike, setLowStrike] = useState('');
  const [midStrike, setMidStrike] = useState('');
  const [highStrike, setHighStrike] = useState('');
  const [contracts, setContracts] = useState(1);

  // Dual fill prices — one per strategy
  const [bwbNetInput, setBwbNetInput] = useState('');
  const [bwbIsCredit, setBwbIsCredit] = useState(true);
  const [ifNetInput, setIfNetInput] = useState('');
  const [ifIsCredit, setIfIsCredit] = useState(true);

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

  // Auto-fill strikes from sweet spot + wing widths (BWB convention)
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

  // Parse strikes
  const low = Number.parseFloat(lowStrike);
  const mid = Number.parseFloat(midStrike);
  const high = Number.parseFloat(highStrike);

  const strikesValid =
    Number.isFinite(low) &&
    Number.isFinite(mid) &&
    Number.isFinite(high) &&
    low < mid &&
    mid < high;

  // BWB metrics (independent of Iron Fly)
  const bwbParsed = Number.parseFloat(bwbNetInput);
  const bwbPriceValid = Number.isFinite(bwbParsed) && bwbParsed >= 0;
  const bwbValid = strikesValid && bwbPriceValid;
  const bwbNet = bwbValid ? (bwbIsCredit ? bwbParsed : -bwbParsed) : 0;
  const bwbMetrics = bwbValid
    ? calcMetrics(side, low, mid, high, bwbNet)
    : null;
  const bwbRows = bwbValid
    ? generatePnlRows(side, low, mid, high, bwbNet, contracts)
    : [];

  // Iron Fly metrics (independent of BWB)
  const ifParsed = Number.parseFloat(ifNetInput);
  const ifPriceValid = Number.isFinite(ifParsed) && ifParsed >= 0;
  const ifValid = strikesValid && ifPriceValid;
  const ifNet = ifValid ? (ifIsCredit ? ifParsed : -ifParsed) : 0;
  const ifMetrics = ifValid ? calcIronFlyMetrics(low, mid, high, ifNet) : null;
  const ifRows = ifValid
    ? generateIronFlyPnlRows(low, mid, high, ifNet, contracts)
    : [];
  // BWBResults requires a BWBMetrics prop even for iron-fly (satisfies type
  // contract but values are never rendered — all iron-fly branches read
  // from ironFlyMetrics instead). 'calls' is hardcoded since side is irrelevant.
  const ifBwbMetrics = ifValid
    ? calcMetrics('calls', low, mid, high, ifNet)
    : null;

  const eitherValid = bwbValid || ifValid;

  const handleClear = () => {
    setSweetSpot('');
    setLowStrike('');
    setMidStrike('');
    setHighStrike('');
    setBwbNetInput('');
    setBwbIsCredit(true);
    setIfNetInput('');
    setIfIsCredit(true);
    setContracts(1);
  };

  return (
    <SectionBox
      label="Settlement Pin Calculator"
      collapsible
      headerRight={
        <button
          onClick={handleClear}
          className="border-edge-strong bg-chip-bg text-secondary cursor-pointer rounded-md border-[1.5px] px-3 py-1.5 font-sans text-xs font-semibold hover:border-red-400 hover:text-red-400"
        >
          Clear
        </button>
      }
    >
      <VixRegimeBanner vix={vix} />

      <BWBInputs
        side={side}
        contracts={contracts}
        sweetSpot={sweetSpot}
        narrowWing={narrowWing}
        wideWing={wideWing}
        lowStrike={lowStrike}
        midStrike={midStrike}
        highStrike={highStrike}
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
        setUseCharm={setUseCharm}
        onRefreshAnchor={refreshAnchor}
      />

      {/* Dual fill prices */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="border-edge rounded-lg border p-3">
          <div className={LABEL + ' mb-1.5'}>BWB Fill Price</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="decimal"
              placeholder="e.g. 0.91"
              value={bwbNetInput}
              onChange={(e) => setBwbNetInput(e.target.value)}
              className={INPUT + ' flex-1'}
              aria-label="BWB fill price"
            />
            <div className="border-edge flex overflow-hidden rounded-md border">
              <button
                onClick={() => setBwbIsCredit(false)}
                className={`cursor-pointer px-3 py-2 text-xs font-semibold transition-colors ${
                  !bwbIsCredit
                    ? 'bg-danger/20 text-danger'
                    : 'text-muted hover:text-primary'
                }`}
              >
                Debit
              </button>
              <button
                onClick={() => setBwbIsCredit(true)}
                className={`border-edge cursor-pointer border-l px-3 py-2 text-xs font-semibold transition-colors ${
                  bwbIsCredit
                    ? 'bg-success/20 text-success'
                    : 'text-muted hover:text-primary'
                }`}
              >
                Credit
              </button>
            </div>
          </div>
        </div>

        <div className="border-edge rounded-lg border p-3">
          <div className={LABEL + ' mb-1.5'}>Iron Fly Fill Price</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="decimal"
              placeholder="e.g. 8.00"
              value={ifNetInput}
              onChange={(e) => setIfNetInput(e.target.value)}
              className={INPUT + ' flex-1'}
              aria-label="Iron Fly fill price"
            />
            <div className="border-edge flex overflow-hidden rounded-md border">
              <button
                onClick={() => setIfIsCredit(false)}
                className={`cursor-pointer px-3 py-2 text-xs font-semibold transition-colors ${
                  !ifIsCredit
                    ? 'bg-danger/20 text-danger'
                    : 'text-muted hover:text-primary'
                }`}
              >
                Debit
              </button>
              <button
                onClick={() => setIfIsCredit(true)}
                className={`border-edge cursor-pointer border-l px-3 py-2 text-xs font-semibold transition-colors ${
                  ifIsCredit
                    ? 'bg-success/20 text-success'
                    : 'text-muted hover:text-primary'
                }`}
              >
                Credit
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Side-by-side results */}
      {eitherValid ? (
        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <div className="text-accent mb-1 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
              BWB ({side === 'calls' ? 'Calls' : 'Puts'})
            </div>
            {bwbValid && bwbMetrics ? (
              <BWBResults
                strategy="bwb"
                side={side}
                contracts={contracts}
                low={low}
                mid={mid}
                high={high}
                net={bwbNet}
                metrics={bwbMetrics}
                ironFlyMetrics={null}
                pnlRows={bwbRows}
                midStrike={midStrike}
              />
            ) : (
              <div className="text-muted bg-surface-alt rounded-lg p-6 text-center text-sm italic">
                Enter BWB fill price to see results.
              </div>
            )}
          </div>

          <div>
            <div className="text-accent mb-1 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
              Iron Fly
            </div>
            {ifValid && ifMetrics && ifBwbMetrics ? (
              <BWBResults
                strategy="iron-fly"
                side={side}
                contracts={contracts}
                low={low}
                mid={mid}
                high={high}
                net={ifNet}
                metrics={ifBwbMetrics}
                ironFlyMetrics={ifMetrics}
                pnlRows={ifRows}
                midStrike={midStrike}
              />
            ) : (
              <div className="text-muted bg-surface-alt rounded-lg p-6 text-center text-sm italic">
                Enter Iron Fly fill price to see results.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="text-muted mt-4 text-center text-sm italic">
          Enter three strikes and at least one fill price to see results.
        </div>
      )}
    </SectionBox>
  );
}
