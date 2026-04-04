interface Props {
  items: string[];
  icon?: string;
  color?: string;
  defaultColor: string;
}

export default function BulletList({
  items,
  icon,
  color,
  defaultColor,
}: Readonly<Props>) {
  return (
    <div className="grid gap-1">
      {items.map((item) => (
        <div
          key={item.slice(0, 80)}
          className="text-secondary flex gap-1.5 text-[11px] leading-relaxed"
        >
          <span className="shrink-0" style={{ color: color ?? defaultColor }}>
            {icon ?? '\u2022'}
          </span>
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}
