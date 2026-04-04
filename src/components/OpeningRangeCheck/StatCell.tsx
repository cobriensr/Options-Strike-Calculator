interface Props {
  label: string;
  value: string;
  sub: string;
  color: string;
}

export default function StatCell({ label, value, sub, color }: Readonly<Props>) {
  return (
    <div className="text-center">
      <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-[17px] font-bold" style={{ color }}>
        {value}
      </div>
      <div className="text-muted font-mono text-[10px]">{sub}</div>
    </div>
  );
}
