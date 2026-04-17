import type { BWBSide } from './bwb-math';
import FillPriceInput from './FillPriceInput';

const INPUT =
  'bg-input border-[1.5px] border-edge-strong hover:border-edge-heavy rounded-lg text-primary p-[10px_12px] text-[15px] font-mono outline-none w-full transition-[border-color] duration-150';

const INPUT_SM = INPUT.replace('p-[10px_12px]', 'p-[8px_10px]').replace(
  'text-[15px]',
  'text-sm',
);

const LABEL =
  'text-tertiary font-sans text-[10px] font-bold uppercase tracking-[0.08em]';

interface BWBColumnProps {
  side: BWBSide;
  sweetSpot: string;
  narrowWing: number;
  wideWing: number;
  lowStrike: string;
  midStrike: string;
  highStrike: string;
  strikesValid: boolean;
  netInput: string;
  isCredit: boolean;
  onSideChange: (s: BWBSide) => void;
  onSweetSpotChange: (v: string) => void;
  onNarrowChange: (v: string) => void;
  onWideChange: (v: string) => void;
  setLowStrike: (v: string) => void;
  setMidStrike: (v: string) => void;
  setHighStrike: (v: string) => void;
  setSweetSpot: (v: string) => void;
  setNetInput: (v: string) => void;
  setIsCredit: (v: boolean) => void;
}

export default function BWBColumn({
  side,
  sweetSpot,
  narrowWing,
  wideWing,
  lowStrike,
  midStrike,
  highStrike,
  strikesValid,
  netInput,
  isCredit,
  onSideChange,
  onSweetSpotChange,
  onNarrowChange,
  onWideChange,
  setLowStrike,
  setMidStrike,
  setHighStrike,
  setSweetSpot,
  setNetInput,
  setIsCredit,
}: Readonly<BWBColumnProps>) {
  const rows = [
    {
      label: 'Low',
      sub: side === 'calls' ? 'buy 1 call' : 'buy 1 put',
      strike: lowStrike,
      setStrike: setLowStrike,
      ariaLabel: 'BWB low strike',
    },
    {
      label: 'Mid',
      sub: side === 'calls' ? 'sell 2 calls' : 'sell 2 puts',
      strike: midStrike,
      setStrike: setMidStrike,
      ariaLabel: 'BWB mid strike',
    },
    {
      label: 'High',
      sub: side === 'calls' ? 'buy 1 call' : 'buy 1 put',
      strike: highStrike,
      setStrike: setHighStrike,
      ariaLabel: 'BWB high strike',
    },
  ];

  return (
    <div className="border-edge bg-surface-alt/30 rounded-lg border p-3">
      <div className="text-accent mb-3 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        BWB
      </div>

      {/* Side toggle */}
      <div className="mb-3 flex gap-1.5">
        {(['calls', 'puts'] as const).map((s) => (
          <button
            key={s}
            onClick={() => onSideChange(s)}
            className={
              'cursor-pointer rounded-md border-[1.5px] px-4 py-1.5 font-sans text-xs font-semibold transition-colors duration-100 ' +
              (side === s
                ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt')
            }
          >
            {s === 'calls' ? 'Calls' : 'Puts'}
          </button>
        ))}
      </div>

      {/* Sweet spot + asymmetric wings */}
      <div className="bg-surface-alt mb-3 rounded-lg p-3">
        <div className={LABEL + ' mb-1.5'}>Sweet Spot</div>
        <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
          <input
            type="text"
            inputMode="decimal"
            placeholder="e.g. 6500"
            value={sweetSpot}
            onChange={(e) => onSweetSpotChange(e.target.value)}
            className={INPUT_SM}
            aria-label="BWB sweet spot"
          />
          <div>
            <div className={LABEL + ' mb-1'}>Narrow</div>
            <input
              type="text"
              inputMode="numeric"
              value={narrowWing}
              onChange={(e) => onNarrowChange(e.target.value)}
              className={INPUT_SM + ' w-[56px]'}
              aria-label="BWB narrow wing width"
            />
          </div>
          <div>
            <div className={LABEL + ' mb-1'}>Wide</div>
            <input
              type="text"
              inputMode="numeric"
              value={wideWing}
              onChange={(e) => onWideChange(e.target.value)}
              className={INPUT_SM + ' w-[56px]'}
              aria-label="BWB wide wing width"
            />
          </div>
        </div>
      </div>

      {/* Strikes */}
      <div className="border-edge mb-3 rounded-lg border p-3">
        {rows.map((row) => (
          <div
            key={row.label}
            className="mb-2 grid grid-cols-[auto_1fr] items-center gap-x-3 last:mb-0"
          >
            <div className="whitespace-nowrap">
              <span className="text-primary font-sans text-sm font-semibold">
                {row.label}
              </span>
              <span className="text-muted ml-1 text-[10px]">({row.sub})</span>
            </div>
            <input
              type="text"
              inputMode="decimal"
              placeholder="e.g. 6500"
              value={row.strike}
              onChange={(e) => {
                row.setStrike(e.target.value);
                setSweetSpot('');
              }}
              className={INPUT}
              aria-label={row.ariaLabel}
            />
          </div>
        ))}
      </div>

      {lowStrike && midStrike && highStrike && !strikesValid && (
        <p className="text-danger mb-3 text-xs">
          Strikes must be in ascending order: low {'<'} mid {'<'} high.
        </p>
      )}

      <FillPriceInput
        label="BWB Fill Price"
        ariaLabel="BWB fill price"
        placeholder="e.g. 0.91"
        value={netInput}
        isCredit={isCredit}
        onValueChange={setNetInput}
        onIsCreditChange={setIsCredit}
      />
    </div>
  );
}
