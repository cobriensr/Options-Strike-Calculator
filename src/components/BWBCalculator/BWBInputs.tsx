import type { BWBSide } from './bwb-math';
import BWBColumn from './BWBColumn';
import IFColumn from './IFColumn';

const LABEL =
  'text-tertiary font-sans text-[10px] font-bold uppercase tracking-[0.08em]';

interface BWBInputsProps {
  // Shared
  contracts: number;
  setContracts: (n: number) => void;
  anchor: {
    strike: number;
    price: number;
    dist: number;
    charmAdjusted: number;
  } | null;
  useCharm: boolean;
  setUseCharm: (v: boolean) => void;
  onRefreshAnchor: () => void;
  onUseAnchor: (strike: number) => void;

  // BWB
  bwbSide: BWBSide;
  bwbSweetSpot: string;
  bwbNarrowWing: number;
  bwbWideWing: number;
  bwbLowStrike: string;
  bwbMidStrike: string;
  bwbHighStrike: string;
  bwbStrikesValid: boolean;
  bwbNetInput: string;
  bwbIsCredit: boolean;
  onBwbSideChange: (s: BWBSide) => void;
  onBwbSweetSpotChange: (v: string) => void;
  onBwbNarrowChange: (v: string) => void;
  onBwbWideChange: (v: string) => void;
  setBwbLowStrike: (v: string) => void;
  setBwbMidStrike: (v: string) => void;
  setBwbHighStrike: (v: string) => void;
  setBwbSweetSpot: (v: string) => void;
  setBwbNetInput: (v: string) => void;
  setBwbIsCredit: (v: boolean) => void;

  // IF
  ifSweetSpot: string;
  ifWing: number;
  ifLowStrike: string;
  ifMidStrike: string;
  ifHighStrike: string;
  ifStrikesValid: boolean;
  ifNetInput: string;
  ifIsCredit: boolean;
  onIfSweetSpotChange: (v: string) => void;
  onIfWingChange: (v: string) => void;
  setIfLowStrike: (v: string) => void;
  setIfMidStrike: (v: string) => void;
  setIfHighStrike: (v: string) => void;
  setIfSweetSpot: (v: string) => void;
  setIfNetInput: (v: string) => void;
  setIfIsCredit: (v: boolean) => void;
}

export default function BWBInputs({
  contracts,
  setContracts,
  anchor,
  useCharm,
  setUseCharm,
  onRefreshAnchor,
  onUseAnchor,
  bwbSide,
  bwbSweetSpot,
  bwbNarrowWing,
  bwbWideWing,
  bwbLowStrike,
  bwbMidStrike,
  bwbHighStrike,
  bwbStrikesValid,
  bwbNetInput,
  bwbIsCredit,
  onBwbSideChange,
  onBwbSweetSpotChange,
  onBwbNarrowChange,
  onBwbWideChange,
  setBwbLowStrike,
  setBwbMidStrike,
  setBwbHighStrike,
  setBwbSweetSpot,
  setBwbNetInput,
  setBwbIsCredit,
  ifSweetSpot,
  ifWing,
  ifLowStrike,
  ifMidStrike,
  ifHighStrike,
  ifStrikesValid,
  ifNetInput,
  ifIsCredit,
  onIfSweetSpotChange,
  onIfWingChange,
  setIfLowStrike,
  setIfMidStrike,
  setIfHighStrike,
  setIfSweetSpot,
  setIfNetInput,
  setIfIsCredit,
}: Readonly<BWBInputsProps>) {
  return (
    <>
      {/* Shared header: contracts + gamma anchor */}
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-0">
          <span className={LABEL + ' mr-2'}>Contracts</span>
          <button
            onClick={() => setContracts(Math.max(1, contracts - 1))}
            className="border-edge-strong bg-chip-bg text-primary flex h-8 w-8 cursor-pointer items-center justify-center rounded-l-md border-[1.5px] border-r-0 font-mono text-base font-bold"
          >
            {'\u2212'}
          </button>
          <input
            type="text"
            inputMode="numeric"
            value={contracts}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value);
              if (!Number.isNaN(v) && v >= 1 && v <= 999) setContracts(v);
              else if (e.target.value === '') setContracts(1);
            }}
            className="border-edge-strong bg-input text-primary h-8 w-[48px] border-[1.5px] text-center font-mono text-[15px] font-semibold outline-none"
            aria-label="Number of contracts"
          />
          <button
            onClick={() => setContracts(Math.min(999, contracts + 1))}
            className="border-edge-strong bg-chip-bg text-primary flex h-8 w-8 cursor-pointer items-center justify-center rounded-r-md border-[1.5px] border-l-0 font-mono text-base font-bold"
          >
            +
          </button>
        </div>

        <button
          onClick={onRefreshAnchor}
          className="text-muted hover:text-accent cursor-pointer text-xs transition-colors"
          aria-label="Refresh gamma anchor"
          title="Refresh gamma anchor"
        >
          &#x21BB;
        </button>
      </div>

      {/* Shared gamma anchor banner */}
      {anchor &&
        (() => {
          const hasCharmDiff = anchor.charmAdjusted !== anchor.strike;
          const activeStrike = useCharm ? anchor.charmAdjusted : anchor.strike;
          const activeDist =
            Math.round((activeStrike - anchor.price) * 10) / 10;
          return (
            <div className="border-accent/30 bg-accent/5 mb-4 flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5">
              <span className="text-accent text-[10px] font-bold tracking-widest uppercase">
                {'\u03B3'} Anchor
              </span>
              <span className="text-primary font-mono text-sm font-semibold">
                {activeStrike}
              </span>
              <span className="text-muted text-[10px]">
                ({activeDist > 0 ? '+' : ''}
                {activeDist} from {anchor.price})
              </span>
              {hasCharmDiff && (
                <div className="border-edge flex overflow-hidden rounded border text-[9px] font-bold">
                  <button
                    onClick={() => setUseCharm(false)}
                    className={`px-1.5 py-0.5 transition-colors ${
                      !useCharm
                        ? 'bg-accent text-white'
                        : 'text-muted hover:text-primary'
                    }`}
                  >
                    {'\u03B3'}
                  </button>
                  <button
                    onClick={() => setUseCharm(true)}
                    className={`border-edge border-l px-1.5 py-0.5 transition-colors ${
                      useCharm
                        ? 'bg-accent text-white'
                        : 'text-muted hover:text-primary'
                    }`}
                  >
                    {'\u03B3'}+C
                  </button>
                </div>
              )}
              <button
                onClick={() => onUseAnchor(activeStrike)}
                className="bg-accent/20 hover:bg-accent/30 text-accent ml-auto rounded px-2 py-0.5 text-[10px] font-bold transition-colors"
              >
                Use
              </button>
            </div>
          );
        })()}

      {/* Two input columns side-by-side */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BWBColumn
          side={bwbSide}
          sweetSpot={bwbSweetSpot}
          narrowWing={bwbNarrowWing}
          wideWing={bwbWideWing}
          lowStrike={bwbLowStrike}
          midStrike={bwbMidStrike}
          highStrike={bwbHighStrike}
          strikesValid={bwbStrikesValid}
          netInput={bwbNetInput}
          isCredit={bwbIsCredit}
          onSideChange={onBwbSideChange}
          onSweetSpotChange={onBwbSweetSpotChange}
          onNarrowChange={onBwbNarrowChange}
          onWideChange={onBwbWideChange}
          setLowStrike={setBwbLowStrike}
          setMidStrike={setBwbMidStrike}
          setHighStrike={setBwbHighStrike}
          setSweetSpot={setBwbSweetSpot}
          setNetInput={setBwbNetInput}
          setIsCredit={setBwbIsCredit}
        />
        <IFColumn
          sweetSpot={ifSweetSpot}
          wing={ifWing}
          lowStrike={ifLowStrike}
          midStrike={ifMidStrike}
          highStrike={ifHighStrike}
          strikesValid={ifStrikesValid}
          netInput={ifNetInput}
          isCredit={ifIsCredit}
          onSweetSpotChange={onIfSweetSpotChange}
          onWingChange={onIfWingChange}
          setLowStrike={setIfLowStrike}
          setMidStrike={setIfMidStrike}
          setHighStrike={setIfHighStrike}
          setSweetSpot={setIfSweetSpot}
          setNetInput={setIfNetInput}
          setIsCredit={setIfIsCredit}
        />
      </div>
    </>
  );
}
