interface Props {
  label: string;
  value: string;
  accent?: string;
  large?: boolean;
}

export default function StatBox({ label, value, accent, large }: Props) {
  return (
    <div>
      <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
        {label}
      </div>
      <div
        className={`mt-0.5 font-mono ${large ? 'text-[22px] font-extrabold' : 'text-sm font-semibold'}`}
        style={{ color: accent ?? 'var(--color-accent)' }}
      >
        {value}
      </div>
    </div>
  );
}
