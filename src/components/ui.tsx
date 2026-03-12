import type { ReactNode } from 'react';

/** Reusable section wrapper with label and optional badge */
export function SectionBox({
  label,
  badge,
  headerRight,
  children,
}: {
  th?: unknown;
  label: string;
  badge?: string | null;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="bg-surface border-edge mt-4 rounded-[14px] border-[1.5px] p-[18px] pb-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)] first:mt-0"
    >
      <div className="mb-3.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="text-tertiary font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
            {label}
          </div>
          {badge && (
            <span className="text-accent bg-accent-bg rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold">
              {badge}
            </span>
          )}
        </div>
        {headerRight}
      </div>
      {children}
    </section>
  );
}

/** Chip toggle button */
export function Chip({
  active,
  onClick,
  label,
}: {
  th?: unknown;
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      role="radio"
      aria-checked={active}
      className={
        'cursor-pointer rounded-full border-[1.5px] px-3.5 py-1.5 font-mono text-[13px] font-medium transition-all duration-100 ' +
        (active
          ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
          : 'border-chip-border bg-chip-bg text-chip-text')
      }
    >
      {label}
    </button>
  );
}

/** Error message display */
export function ErrorMsg({
  children,
  id,
}: {
  th?: unknown;
  children: ReactNode;
  id?: string;
}) {
  return (
    <div
      id={id}
      role="alert"
      className="text-danger mt-1.5 font-mono text-[13px] font-medium"
    >
      {children}
    </div>
  );
}
