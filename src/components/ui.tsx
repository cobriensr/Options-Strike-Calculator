import type { ReactNode } from 'react';

/** Build a data URI for a dropdown chevron */
export function buildChevronUrl(color: string): string {
  return (
    'url("data:image/svg+xml,' +
    encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><path d="M3 5l3 3 3-3" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`) +
    '")'
  );
}

/** Reusable section wrapper with label and optional badge */
export function SectionBox({ label, badge, headerRight, children }: {
  th?: unknown; label: string; badge?: string | null; headerRight?: ReactNode; children: ReactNode;
}) {
  return (
    <section aria-label={label} className="bg-surface border-[1.5px] border-edge rounded-[14px] p-[18px] pb-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)] mt-4 first:mt-0">
      <div className="flex justify-between items-center mb-3.5">
        <div className="flex items-center gap-2.5">
          <div className="font-sans text-[11px] font-bold uppercase tracking-[0.14em] text-tertiary">{label}</div>
          {badge && <span className="text-[10px] font-semibold text-accent bg-accent-bg px-2 py-0.5 rounded-full font-mono">{badge}</span>}
        </div>
        {headerRight}
      </div>
      {children}
    </section>
  );
}

/** Chip toggle button */
export function Chip({ active, onClick, label }: {
  th?: unknown; active: boolean; onClick: () => void; label: string;
}) {
  return (
    <button onClick={onClick} role="radio" aria-checked={active} className={
      'px-3.5 py-1.5 rounded-full text-[13px] font-medium cursor-pointer border-[1.5px] font-mono transition-all duration-100 ' +
      (active
        ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
        : 'border-chip-border bg-chip-bg text-chip-text')
    }>
      {label}
    </button>
  );
}

/** Error message display */
export function ErrorMsg({ children, id }: { th?: unknown; children: ReactNode; id?: string }) {
  return (
    <div id={id} role="alert" className="text-[13px] text-danger mt-1.5 font-mono font-medium">
      {children}
    </div>
  );
}

/** Table header cell className builder — returns Tailwind classes */
export function mkTh(align: string, colorClass?: string): string {
  const alignCls = align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left';
  return `px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.06em] whitespace-nowrap border-b-2 border-edge font-sans ${colorClass ?? 'text-tertiary'} ${alignCls}`;
}

/** Table data cell className builder — returns Tailwind classes */
export function mkTd(): string {
  return 'px-3 py-2.5 border-b border-edge whitespace-nowrap text-sm';
}

/** Format a dollar amount with commas, no cents for values >= $100 */
export function fmtDollar(value: number): string {
  if (Math.abs(value) >= 100) {
    return Math.round(value).toLocaleString('en-US');
  }
  return value.toFixed(2);
}

/** Tiny label className constant */
export const tinyLbl = 'block text-[10px] font-bold uppercase tracking-[0.08em] text-tertiary font-sans mb-1';
