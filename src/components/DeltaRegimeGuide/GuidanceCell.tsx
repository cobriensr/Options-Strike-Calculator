interface Props {
  label: string;
  delta: number;
  desc: string;
  color: string;
}

export default function GuidanceCell({ label, delta, desc, color }: Readonly<Props>) {
  return (
    <div className="text-center">
      <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
        {label}
      </div>
      <div
        className="mt-0.5 font-mono text-xl font-extrabold"
        style={{ color }}
      >
        {delta}
        {'\u0394'}
      </div>
      <div className="text-muted font-mono text-[10px]">{desc}</div>
    </div>
  );
}
