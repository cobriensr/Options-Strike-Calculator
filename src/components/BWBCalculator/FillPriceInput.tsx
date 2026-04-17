const INPUT =
  'bg-input border-[1.5px] border-edge-strong hover:border-edge-heavy rounded-lg text-primary p-[10px_12px] text-[15px] font-mono outline-none w-full transition-[border-color] duration-150';

const LABEL =
  'text-tertiary font-sans text-[10px] font-bold uppercase tracking-[0.08em]';

interface FillPriceInputProps {
  label: string;
  ariaLabel: string;
  placeholder: string;
  value: string;
  isCredit: boolean;
  onValueChange: (v: string) => void;
  onIsCreditChange: (v: boolean) => void;
}

export default function FillPriceInput({
  label,
  ariaLabel,
  placeholder,
  value,
  isCredit,
  onValueChange,
  onIsCreditChange,
}: Readonly<FillPriceInputProps>) {
  return (
    <div className="border-edge rounded-lg border p-3">
      <div className={LABEL + ' mb-1.5'}>{label}</div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="decimal"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className={INPUT + ' flex-1'}
          aria-label={ariaLabel}
        />
        <div className="border-edge flex overflow-hidden rounded-md border">
          <button
            onClick={() => onIsCreditChange(false)}
            className={`cursor-pointer px-3 py-2 text-xs font-semibold transition-colors ${
              !isCredit
                ? 'bg-danger/20 text-danger'
                : 'text-muted hover:text-primary'
            }`}
          >
            Debit
          </button>
          <button
            onClick={() => onIsCreditChange(true)}
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
  );
}
