export default function DollarField({
  id,
  label,
  value,
  onChange,
  placeholder,
  wide,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  wide?: boolean;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
      >
        {label}
      </label>
      <div className={`relative ${wide ? 'w-36' : 'w-24'}`}>
        <span className="text-muted pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-sm">
          $
        </span>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value.replaceAll(/[^0-9.]/g, ''));
          }}
          className="bg-input border-edge-strong hover:border-edge-heavy text-primary w-full rounded-lg border-[1.5px] py-[11px] pr-3 pl-7 font-mono text-sm transition-[border-color] duration-150 outline-none"
        />
      </div>
    </div>
  );
}
