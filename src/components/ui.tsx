import {
  memo,
  useRef,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';

/** Reusable section wrapper with label and optional badge */
export const SectionBox = memo(function SectionBox({
  label,
  badge,
  headerRight,
  collapsible,
  defaultCollapsed,
  children,
}: {
  label: string;
  badge?: string | null;
  headerRight?: ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);
  const toggle = useCallback(() => setCollapsed((v) => !v), []);
  const isOpen = !collapsible || !collapsed;

  return (
    <section
      aria-label={label}
      className={
        'animate-fade-in-up bg-surface border-edge border-t-accent mt-6 flex flex-col rounded-[14px] border-[1.5px] border-t-[3px] p-[18px] pb-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)] first:mt-0' +
        (isOpen ? ' h-full' : ' self-start')
      }
    >
      <div
        className={
          (isOpen ? 'mb-3.5 ' : '') +
          'flex items-center justify-between' +
          (collapsible ? ' cursor-pointer select-none' : '')
        }
        onClick={collapsible ? toggle : undefined}
        role={collapsible ? 'button' : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-label={collapsible ? `Toggle ${label}` : undefined}
        aria-expanded={collapsible ? isOpen : undefined}
        onKeyDown={
          collapsible
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle();
                }
              }
            : undefined
        }
      >
        <div className="flex items-center gap-2.5">
          {collapsible && (
            <span
              className="text-muted text-[12px] transition-transform duration-200"
              style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
              aria-hidden="true"
            >
              &#x25BE;
            </span>
          )}
          <h2 className="text-tertiary font-sans text-[13px] font-bold tracking-[0.12em] uppercase">
            {label}
          </h2>
          {badge && (
            <span className="text-accent bg-accent-bg rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold">
              {badge}
            </span>
          )}
        </div>
        {/* Wrap headerRight to stop clicks from toggling collapse */}
        {headerRight && collapsible ? (
          <div onClick={(e) => e.stopPropagation()}>{headerRight}</div>
        ) : (
          headerRight
        )}
      </div>
      {isOpen && <div className="flex min-h-0 flex-1 flex-col">{children}</div>}
    </section>
  );
});

/** Chip toggle button */
export const Chip = memo(function Chip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={
        'cursor-pointer rounded-full border-[1.5px] px-3.5 py-1.5 font-mono text-[13px] font-medium transition-all duration-100 ' +
        (active
          ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
          : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt')
      }
    >
      {label}
    </button>
  );
});

/** Wrapper that shows a right-edge fade when content overflows horizontally */
export function ScrollHint({ children }: Readonly<{ children: ReactNode }>) {
  const ref = useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = useState(false);

  const check = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanScroll(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [check]);

  return (
    <div className="relative">
      <div ref={ref} onScroll={check} className="overflow-x-auto">
        {children}
      </div>
      {canScroll && (
        <div
          className="pointer-events-none absolute top-0 right-0 bottom-0 w-8"
          style={{
            background:
              'linear-gradient(to right, transparent, var(--color-surface))',
          }}
        />
      )}
    </div>
  );
}

/** Status badge with tinted background — used in the header for LIVE, CLOSED, BACKTEST, etc. */
export const StatusBadge = memo(function StatusBadge({
  label,
  color,
  dot,
  title,
  href,
}: {
  label: string;
  color: string;
  dot?: boolean;
  title?: string;
  href?: string;
}) {
  const cls = 'rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold';
  const style = {
    backgroundColor: `color-mix(in srgb, ${color} 9%, transparent)`,
    color,
  };
  const content = (
    <>
      {dot && '● '}
      {label}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className={cls + ' no-underline'}
        style={style}
        title={title}
      >
        {content}
      </a>
    );
  }

  return (
    <span className={cls} style={style} title={title}>
      {content}
    </span>
  );
});

/** Error message display */
export const ErrorMsg = memo(function ErrorMsg({
  children,
  id,
}: {
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
});
