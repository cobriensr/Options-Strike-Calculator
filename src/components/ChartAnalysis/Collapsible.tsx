import { useState } from 'react';

interface Props {
  title: string;
  color: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export default function Collapsible({
  title,
  color,
  defaultOpen,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="border-edge overflow-hidden rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left"
        style={{ backgroundColor: color + '06' }}
      >
        <span
          className="font-sans text-[9px] font-bold tracking-wider uppercase"
          style={{ color }}
        >
          {title}
        </span>
        <span
          className="text-muted text-[12px] transition-transform"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          {'\u25BE'}
        </span>
      </button>
      {open && <div className="px-3 pt-1.5 pb-3">{children}</div>}
    </div>
  );
}
