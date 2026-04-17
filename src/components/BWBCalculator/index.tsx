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

interface BWBCalculatorProps {
  selectedDate?: string;
  vix?: string | number | null;
}

export default function BWBCalculator({
  selectedDate,
  vix,
}: Readonly<BWBCalculatorProps>) {
  // Shared
  const [contracts, setContracts] = useState(1);

  // BWB state
  const [bwbSide, setBwbSide] = useState<BWBSide>('calls');
  const [bwbLowStrike, setBwbLowStrike] = useState('');
  const [bwbMidStrike, setBwbMidStrike] = useState('');
  const [bwbHighStrike, setBwbHighStrike] = useState('');
  const [bwbSweetSpot, setBwbSweetSpot] = useState('');
  const [bwbNarrowWing, setBwbNarrowWing] = useState(20);
  const [bwbWideWing, setBwbWideWing] = useState(40);
  const [bwbNetInput, setBwbNetInput] = useState('');
  const [bwbIsCredit, setBwbIsCredit] = useState(true);

  // Iron Fly state
  const [ifLowStrike, setIfLowStrike] = useState('');
  const [ifMidStrike, setIfMidStrike] = useState('');
  const [ifHighStrike, setIfHighStrike] = useState('');
  const [ifSweetSpot, setIfSweetSpot] = useState('');
  const [ifWing, setIfWing] = useState(20);
  const [ifNetInput, setIfNetInput] = useState('');
  const [ifIsCredit, setIfIsCredit] = useState(true);

  // Shared gamma anchor
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

  // BWB strike auto-fill (asymmetric)
  const fillBwbStrikes = useCallback(
    (ss: number, narrow: number, wide: number, s: BWBSide) => {
      if (s === 'calls') {
        setBwbLowStrike(String(ss - narrow));
        setBwbMidStrike(String(ss));
        setBwbHighStrike(String(ss + wide));
      } else {
        setBwbLowStrike(String(ss - wide));
        setBwbMidStrike(String(ss));
        setBwbHighStrike(String(ss + narrow));
      }
    },
    [],
  );

  // IF strike auto-fill (symmetric)
  const fillIfStrikes = useCallback((ss: number, wing: number) => {
    setIfLowStrike(String(ss - wing));
    setIfMidStrike(String(ss));
    setIfHighStrike(String(ss + wing));
  }, []);

  const handleBwbSweetSpotChange = (value: string) => {
    setBwbSweetSpot(value);
    const ss = Number.parseFloat(value);
    if (Number.isFinite(ss))
      fillBwbStrikes(ss, bwbNarrowWing, bwbWideWing, bwbSide);
  };

  const handleBwbNarrowChange = (value: string) => {
    const n = Number.parseInt(value);
    if (Number.isFinite(n) && n > 0) {
      setBwbNarrowWing(n);
      const ss = Number.parseFloat(bwbSweetSpot);
      if (Number.isFinite(ss)) fillBwbStrikes(ss, n, bwbWideWing, bwbSide);
    }
  };

  const handleBwbWideChange = (value: string) => {
    const w = Number.parseInt(value);
    if (Number.isFinite(w) && w > 0) {
      setBwbWideWing(w);
      const ss = Number.parseFloat(bwbSweetSpot);
      if (Number.isFinite(ss)) fillBwbStrikes(ss, bwbNarrowWing, w, bwbSide);
    }
  };

  const handleBwbSideChange = (s: BWBSide) => {
    setBwbSide(s);
    const ss = Number.parseFloat(bwbSweetSpot);
    if (Number.isFinite(ss)) fillBwbStrikes(ss, bwbNarrowWing, bwbWideWing, s);
  };

  const handleIfSweetSpotChange = (value: string) => {
    setIfSweetSpot(value);
    const ss = Number.parseFloat(value);
    if (Number.isFinite(ss)) fillIfStrikes(ss, ifWing);
  };

  const handleIfWingChange = (value: string) => {
    const w = Number.parseInt(value);
    if (Number.isFinite(w) && w > 0) {
      setIfWing(w);
      const ss = Number.parseFloat(ifSweetSpot);
      if (Number.isFinite(ss)) fillIfStrikes(ss, w);
    }
  };

  // Shared γ-anchor Use → fills both sweet spots
  const handleUseAnchor = useCallback(
    (strike: number) => {
      const s = String(strike);
      setBwbSweetSpot(s);
      setIfSweetSpot(s);
      fillBwbStrikes(strike, bwbNarrowWing, bwbWideWing, bwbSide);
      fillIfStrikes(strike, ifWing);
    },
    [
      bwbNarrowWing,
      bwbWideWing,
      bwbSide,
      ifWing,
      fillBwbStrikes,
      fillIfStrikes,
    ],
  );

  // BWB parse + validate
  const bwbLow = Number.parseFloat(bwbLowStrike);
  const bwbMid = Number.parseFloat(bwbMidStrike);
  const bwbHigh = Number.parseFloat(bwbHighStrike);
  const bwbStrikesValid =
    Number.isFinite(bwbLow) &&
    Number.isFinite(bwbMid) &&
    Number.isFinite(bwbHigh) &&
    bwbLow < bwbMid &&
    bwbMid < bwbHigh;

  const bwbParsed = Number.parseFloat(bwbNetInput);
  const bwbPriceValid = Number.isFinite(bwbParsed) && bwbParsed >= 0;
  const bwbValid = bwbStrikesValid && bwbPriceValid;
  const bwbNet = bwbValid ? (bwbIsCredit ? bwbParsed : -bwbParsed) : 0;
  const bwbMetrics = bwbValid
    ? calcMetrics(bwbSide, bwbLow, bwbMid, bwbHigh, bwbNet)
    : null;
  const bwbRows = bwbValid
    ? generatePnlRows(bwbSide, bwbLow, bwbMid, bwbHigh, bwbNet, contracts)
    : [];

  // IF parse + validate
  const ifLow = Number.parseFloat(ifLowStrike);
  const ifMid = Number.parseFloat(ifMidStrike);
  const ifHigh = Number.parseFloat(ifHighStrike);
  const ifStrikesValid =
    Number.isFinite(ifLow) &&
    Number.isFinite(ifMid) &&
    Number.isFinite(ifHigh) &&
    ifLow < ifMid &&
    ifMid < ifHigh;

  const ifParsed = Number.parseFloat(ifNetInput);
  const ifPriceValid = Number.isFinite(ifParsed) && ifParsed >= 0;
  const ifValid = ifStrikesValid && ifPriceValid;
  const ifNet = ifValid ? (ifIsCredit ? ifParsed : -ifParsed) : 0;
  const ifMetrics = ifValid
    ? calcIronFlyMetrics(ifLow, ifMid, ifHigh, ifNet)
    : null;
  const ifRows = ifValid
    ? generateIronFlyPnlRows(ifLow, ifMid, ifHigh, ifNet, contracts)
    : [];
  // BWBResults requires BWBMetrics for type-contract; IF branch never reads it
  const ifBwbMetrics = ifValid
    ? calcMetrics('calls', ifLow, ifMid, ifHigh, ifNet)
    : null;

  const eitherValid = bwbValid || ifValid;

  const handleClear = () => {
    setBwbSweetSpot('');
    setBwbLowStrike('');
    setBwbMidStrike('');
    setBwbHighStrike('');
    setBwbNetInput('');
    setBwbIsCredit(true);
    setIfSweetSpot('');
    setIfLowStrike('');
    setIfMidStrike('');
    setIfHighStrike('');
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
        contracts={contracts}
        setContracts={setContracts}
        anchor={anchor}
        useCharm={useCharm}
        setUseCharm={setUseCharm}
        onRefreshAnchor={refreshAnchor}
        onUseAnchor={handleUseAnchor}
        bwbSide={bwbSide}
        bwbSweetSpot={bwbSweetSpot}
        bwbNarrowWing={bwbNarrowWing}
        bwbWideWing={bwbWideWing}
        bwbLowStrike={bwbLowStrike}
        bwbMidStrike={bwbMidStrike}
        bwbHighStrike={bwbHighStrike}
        bwbStrikesValid={bwbStrikesValid}
        bwbNetInput={bwbNetInput}
        bwbIsCredit={bwbIsCredit}
        onBwbSideChange={handleBwbSideChange}
        onBwbSweetSpotChange={handleBwbSweetSpotChange}
        onBwbNarrowChange={handleBwbNarrowChange}
        onBwbWideChange={handleBwbWideChange}
        setBwbLowStrike={setBwbLowStrike}
        setBwbMidStrike={setBwbMidStrike}
        setBwbHighStrike={setBwbHighStrike}
        setBwbSweetSpot={setBwbSweetSpot}
        setBwbNetInput={setBwbNetInput}
        setBwbIsCredit={setBwbIsCredit}
        ifSweetSpot={ifSweetSpot}
        ifWing={ifWing}
        ifLowStrike={ifLowStrike}
        ifMidStrike={ifMidStrike}
        ifHighStrike={ifHighStrike}
        ifStrikesValid={ifStrikesValid}
        ifNetInput={ifNetInput}
        ifIsCredit={ifIsCredit}
        onIfSweetSpotChange={handleIfSweetSpotChange}
        onIfWingChange={handleIfWingChange}
        setIfLowStrike={setIfLowStrike}
        setIfMidStrike={setIfMidStrike}
        setIfHighStrike={setIfHighStrike}
        setIfSweetSpot={setIfSweetSpot}
        setIfNetInput={setIfNetInput}
        setIfIsCredit={setIfIsCredit}
      />

      {/* Side-by-side results */}
      {eitherValid ? (
        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <div className="text-accent mb-1 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
              BWB ({bwbSide === 'calls' ? 'Calls' : 'Puts'})
            </div>
            {bwbValid && bwbMetrics ? (
              <BWBResults
                strategy="bwb"
                side={bwbSide}
                contracts={contracts}
                low={bwbLow}
                mid={bwbMid}
                high={bwbHigh}
                net={bwbNet}
                metrics={bwbMetrics}
                ironFlyMetrics={null}
                pnlRows={bwbRows}
                midStrike={bwbMidStrike}
              />
            ) : (
              <div className="text-muted bg-surface-alt rounded-lg p-6 text-center text-sm italic">
                Enter BWB strikes and fill price to see results.
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
                side="calls"
                contracts={contracts}
                low={ifLow}
                mid={ifMid}
                high={ifHigh}
                net={ifNet}
                metrics={ifBwbMetrics}
                ironFlyMetrics={ifMetrics}
                pnlRows={ifRows}
                midStrike={ifMidStrike}
              />
            ) : (
              <div className="text-muted bg-surface-alt rounded-lg p-6 text-center text-sm italic">
                Enter Iron Fly strikes and fill price to see results.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="text-muted mt-4 text-center text-sm italic">
          Enter strikes and a fill price in either column to see results.
        </div>
      )}
    </SectionBox>
  );
}
