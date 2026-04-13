import type { BWBSide, StrategyMode } from './bwb-math';

const INPUT =
  'bg-input border-[1.5px] border-edge-strong hover:border-edge-heavy rounded-lg text-primary p-[10px_12px] text-[15px] font-mono outline-none w-full transition-[border-color] duration-150';

const INPUT_SM = INPUT.replace('p-[10px_12px]', 'p-[8px_10px]').replace(
  'text-[15px]',
  'text-sm',
);

const LABEL =
  'text-tertiary font-sans text-[10px] font-bold uppercase tracking-[0.08em]';

interface BWBInputsProps {
  strategy: StrategyMode;
  side: BWBSide;
  contracts: number;
  sweetSpot: string;
  narrowWing: number;
  wideWing: number;
  lowStrike: string;
  midStrike: string;
  highStrike: string;
  netInput: string;
  isCredit: boolean;
  anchor: {
    strike: number;
    price: number;
    dist: number;
    charmAdjusted: number;
  } | null;
  useCharm: boolean;
  strikesValid: boolean;
  onSideChange: (s: BWBSide) => void;
  setContracts: (n: number) => void;
  onSweetSpotChange: (value: string) => void;
  onNarrowChange: (value: string) => void;
  onWideChange: (value: string) => void;
  setLowStrike: (v: string) => void;
  setMidStrike: (v: string) => void;
  setHighStrike: (v: string) => void;
  setSweetSpot: (v: string) => void;
  setNetInput: (v: string) => void;
  setIsCredit: (v: boolean) => void;
  setUseCharm: (v: boolean) => void;
  onRefreshAnchor: () => void;
}

export default function BWBInputs({
  strategy,
  side,
  contracts,
  sweetSpot,
  narrowWing,
  wideWing,
  lowStrike,
  midStrike,
  highStrike,
  netInput,
  isCredit,
  anchor,
  useCharm,
  strikesValid,
  onSideChange,
  setContracts,
  onSweetSpotChange,
  onNarrowChange,
  onWideChange,
  setLowStrike,
  setMidStrike,
  setHighStrike,
  setSweetSpot,
  setNetInput,
  setIsCredit,
  setUseCharm,
  onRefreshAnchor,
}: Readonly<BWBInputsProps>) {
  return (
    <>
      {/* Side toggle + Contracts */}
      <div className="mb-4 flex items-center justify-between gap-4">
        {strategy === 'bwb' ? (
          <div className="flex gap-1.5">
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
        ) : (
          <div />
        )}
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
      </div>

      {/* Sweet spot auto-fill (optional) */}
      <div className="bg-surface-alt mb-4 rounded-lg p-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className={LABEL}>Sweet Spot</span>
          <button
            onClick={onRefreshAnchor}
            className="text-muted hover:text-accent cursor-pointer text-xs transition-colors"
            aria-label="Refresh gamma anchor"
            title="Refresh gamma anchor"
          >
            &#x21BB;
          </button>
        </div>

        {/* Gamma anchor suggestion */}
        {anchor &&
          (() => {
            const hasCharmDiff = anchor.charmAdjusted !== anchor.strike;
            const activeStrike = useCharm
              ? anchor.charmAdjusted
              : anchor.strike;
            const activeDist =
              Math.round((activeStrike - anchor.price) * 10) / 10;
            return (
              <div className="border-accent/30 bg-accent/5 mb-2.5 flex items-center gap-2 rounded-md border px-2.5 py-1.5">
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
                {/* gamma / gamma+C toggle — only shown when charm differs */}
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
                  onClick={() => onSweetSpotChange(String(activeStrike))}
                  className="bg-accent/20 hover:bg-accent/30 text-accent ml-auto rounded px-2 py-0.5 text-[10px] font-bold transition-colors"
                >
                  Use
                </button>
              </div>
            );
          })()}

        <div className="grid grid-cols-[1fr_1fr] items-end gap-2 sm:grid-cols-[1fr_auto_auto]">
          <div className="col-span-2 sm:col-span-1">
            <input
              type="text"
              inputMode="decimal"
              placeholder={anchor ? String(anchor.strike) : 'e.g. 6500'}
              value={sweetSpot}
              onChange={(e) => onSweetSpotChange(e.target.value)}
              className={INPUT_SM}
              aria-label="Sweet spot strike"
            />
          </div>
          <div>
            <div className={LABEL + ' mb-1'}>
              {strategy === 'iron-fly' ? 'Lower' : 'Narrow'}
            </div>
            <input
              type="text"
              inputMode="numeric"
              value={narrowWing}
              onChange={(e) => onNarrowChange(e.target.value)}
              className={INPUT_SM + ' w-full sm:w-[60px]'}
              aria-label={
                strategy === 'iron-fly'
                  ? 'Lower wing width'
                  : 'Narrow wing width'
              }
            />
          </div>
          <div>
            <div className={LABEL + ' mb-1'}>
              {strategy === 'iron-fly' ? 'Upper' : 'Wide'}
            </div>
            <input
              type="text"
              inputMode="numeric"
              value={wideWing}
              onChange={(e) => onWideChange(e.target.value)}
              className={INPUT_SM + ' w-full sm:w-[60px]'}
              aria-label={
                strategy === 'iron-fly' ? 'Upper wing width' : 'Wide wing width'
              }
            />
          </div>
        </div>
      </div>

      {/* Strikes */}
      <div className="border-edge rounded-lg border p-3">
        <div className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <div />
          <div className={LABEL + ' text-center'}>Strike</div>
        </div>
        {[
          {
            label: 'Low',
            sub:
              strategy === 'iron-fly'
                ? 'buy 1 put'
                : side === 'calls'
                  ? 'buy 1 call'
                  : 'buy 1 put',
            strike: lowStrike,
            setStrike: setLowStrike,
          },
          {
            label: 'Mid',
            sub:
              strategy === 'iron-fly'
                ? 'sell put + call'
                : side === 'calls'
                  ? 'sell 2 calls'
                  : 'sell 2 puts',
            strike: midStrike,
            setStrike: setMidStrike,
          },
          {
            label: 'High',
            sub:
              strategy === 'iron-fly'
                ? 'buy 1 call'
                : side === 'calls'
                  ? 'buy 1 call'
                  : 'buy 1 put',
            strike: highStrike,
            setStrike: setHighStrike,
          },
        ].map((row) => (
          <div
            key={row.label}
            className="mb-2 grid grid-cols-[auto_1fr] items-center gap-x-3"
          >
            <div className="w-[70px]">
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
              aria-label={row.label + ' strike'}
            />
          </div>
        ))}
      </div>

      {/* Fill Price */}
      <div className="border-edge mt-3 rounded-lg border p-3">
        <div className={LABEL + ' mb-1.5'}>Fill Price</div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode="decimal"
            placeholder="e.g. 0.91"
            value={netInput}
            onChange={(e) => setNetInput(e.target.value)}
            className={INPUT + ' flex-1'}
            aria-label="Net fill price"
          />
          <div className="border-edge flex overflow-hidden rounded-md border">
            <button
              onClick={() => setIsCredit(false)}
              className={`cursor-pointer px-3 py-2 text-xs font-semibold transition-colors ${
                !isCredit
                  ? 'bg-danger/20 text-danger'
                  : 'text-muted hover:text-primary'
              }`}
            >
              Debit
            </button>
            <button
              onClick={() => setIsCredit(true)}
              className={`border-edge cursor-pointer border-l px-3 py-2 text-xs font-semibold transition-colors ${
                isCredit
                  ? 'bg-success/20 text-success'
                  : 'text-muted hover:text-primary'
              }`}
            >
              Credit
            </button>
          </div>
        </div>
      </div>

      {/* Validation hints */}
      {lowStrike && midStrike && highStrike && !strikesValid && (
        <p className="text-danger mt-2 text-xs">
          Strikes must be in ascending order: low {'<'} mid {'<'} high.
        </p>
      )}
    </>
  );
}
