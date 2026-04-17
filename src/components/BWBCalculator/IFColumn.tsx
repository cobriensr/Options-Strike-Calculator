import FillPriceInput from './FillPriceInput';

const INPUT =
  'bg-input border-[1.5px] border-edge-strong hover:border-edge-heavy rounded-lg text-primary p-[10px_12px] text-[15px] font-mono outline-none w-full transition-[border-color] duration-150';

const INPUT_SM = INPUT.replace('p-[10px_12px]', 'p-[8px_10px]').replace(
  'text-[15px]',
  'text-sm',
);

const LABEL =
  'text-tertiary font-sans text-[10px] font-bold uppercase tracking-[0.08em]';

interface IFColumnProps {
  sweetSpot: string;
  wing: number;
  lowStrike: string;
  midStrike: string;
  highStrike: string;
  strikesValid: boolean;
  netInput: string;
  isCredit: boolean;
  onSweetSpotChange: (v: string) => void;
  onWingChange: (v: string) => void;
  setLowStrike: (v: string) => void;
  setMidStrike: (v: string) => void;
  setHighStrike: (v: string) => void;
  setSweetSpot: (v: string) => void;
  setNetInput: (v: string) => void;
  setIsCredit: (v: boolean) => void;
}

export default function IFColumn({
  sweetSpot,
  wing,
  lowStrike,
  midStrike,
  highStrike,
  strikesValid,
  netInput,
  isCredit,
  onSweetSpotChange,
  onWingChange,
  setLowStrike,
  setMidStrike,
  setHighStrike,
  setSweetSpot,
  setNetInput,
  setIsCredit,
}: Readonly<IFColumnProps>) {
  const rows = [
    {
      label: 'Low',
      sub: 'buy 1 put',
      strike: lowStrike,
      setStrike: setLowStrike,
      ariaLabel: 'Iron Fly low strike',
    },
    {
      label: 'Mid',
      sub: 'sell 1 straddle',
      strike: midStrike,
      setStrike: setMidStrike,
      ariaLabel: 'Iron Fly mid strike',
    },
    {
      label: 'High',
      sub: 'buy 1 call',
      strike: highStrike,
      setStrike: setHighStrike,
      ariaLabel: 'Iron Fly high strike',
    },
  ];

  return (
    <div className="border-edge bg-surface-alt/30 rounded-lg border p-3">
      <div className="text-accent mb-3 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Iron Fly
      </div>

      {/* Symmetric by design — no side toggle */}
      <div className="text-muted mb-3 font-sans text-[10px] italic">
        Long put · short straddle · long call (symmetric wings)
      </div>

      {/* Sweet spot + single symmetric wing */}
      <div className="bg-surface-alt mb-3 rounded-lg p-3">
        <div className={LABEL + ' mb-1.5'}>Sweet Spot</div>
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <input
            type="text"
            inputMode="decimal"
            placeholder="e.g. 6500"
            value={sweetSpot}
            onChange={(e) => onSweetSpotChange(e.target.value)}
            className={INPUT_SM}
            aria-label="Iron Fly sweet spot"
          />
          <div>
            <div className={LABEL + ' mb-1'}>Wing</div>
            <input
              type="text"
              inputMode="numeric"
              value={wing}
              onChange={(e) => onWingChange(e.target.value)}
              className={INPUT_SM + ' w-[56px]'}
              aria-label="Iron Fly wing width"
            />
          </div>
        </div>
      </div>

      {/* Strikes — legs fixed regardless of side */}
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
        label="Iron Fly Fill Price"
        ariaLabel="Iron Fly fill price"
        placeholder="e.g. 8.00"
        value={netInput}
        isCredit={isCredit}
        onValueChange={setNetInput}
        onIsCreditChange={setIsCredit}
      />
    </div>
  );
}
