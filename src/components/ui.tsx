import {
  memo,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { CollapseAllContext } from './collapse-context';

function SectionTitle({
  label,
  badge,
  badgeColor,
}: {
  label: string;
  badge?: string | null;
  badgeColor?: string;
}) {
  return (
    <>
      <h2 className="text-tertiary font-sans text-[13px] font-bold tracking-[0.12em] uppercase">
        {label}
      </h2>
      {badge && (
        <span
          className={
            'rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold' +
            (badgeColor ? '' : ' text-accent bg-accent-bg')
          }
          style={
            badgeColor
              ? {
                  color: badgeColor,
                  backgroundColor: `color-mix(in srgb, ${badgeColor} 15%, transparent)`,
                }
              : undefined
          }
        >
          {badge}
        </span>
      )}
    </>
  );
}

/**
 * Reusable section wrapper with label and optional badge.
 *
 * Default-collapse rule for the codebase (apply when adding new
 * collapsible UI):
 *   - **Core / primary panels** (Results, Risk, Regime, Futures, etc.):
 *     `defaultCollapsed=false` — they answer the user's primary question
 *     and should be visible on load.
 *   - **Drill-down / per-row detail** (IVAnomalies row, PositionMonitor
 *     row, ChartAnalysis sub-tabs): start collapsed — secondary content
 *     that the user opts into per-row.
 *   - **Optional/uploaded data** (PositionMonitor parent panel): start
 *     collapsed — content is empty until the user provides input.
 *
 * Sub-sections nested inside a `SectionBox` (e.g. IronCondor inside
 * Results) typically use a smaller inline header rather than a nested
 * `SectionBox`; nesting full SectionBoxes inflates the visual hierarchy.
 */
export const SectionBox = memo(function SectionBox({
  label,
  badge,
  badgeColor,
  headerRight,
  collapsible,
  defaultCollapsed,
  children,
}: {
  label: string;
  badge?: string | null;
  /** When provided, overrides the default accent color for the badge. */
  badgeColor?: string;
  headerRight?: ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);
  const toggle = useCallback(() => setCollapsed((v) => !v), []);
  const isOpen = !collapsible || !collapsed;

  // Respond to "collapse all" / "expand all" broadcast. Only applies when
  // this section is collapsible; non-collapsible sections are unaffected.
  const signal = useContext(CollapseAllContext);
  const prevVersionRef = useRef(signal.version);
  useEffect(() => {
    if (!collapsible) return;
    if (signal.version === prevVersionRef.current) return;
    prevVersionRef.current = signal.version;
    setCollapsed(signal.collapsed);
  }, [collapsible, signal]);

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
          (isOpen ? 'mb-3.5 ' : '') + 'flex items-center justify-between'
        }
      >
        {collapsible ? (
          <button
            type="button"
            className="flex flex-1 cursor-pointer items-center gap-2.5 text-left select-none"
            onClick={toggle}
            aria-label={`Toggle ${label}`}
            aria-expanded={isOpen}
          >
            <span
              className="text-muted text-[12px] transition-transform duration-200"
              style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
              aria-hidden="true"
            >
              &#x25BE;
            </span>
            <SectionTitle label={label} badge={badge} badgeColor={badgeColor} />
          </button>
        ) : (
          <div className="flex items-center gap-2.5">
            <SectionTitle label={label} badge={badge} badgeColor={badgeColor} />
          </div>
        )}
        {headerRight}
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
        'inline-flex min-h-[44px] cursor-pointer items-center rounded-full border-[1.5px] px-3.5 py-1.5 font-mono text-[13px] font-medium transition-all duration-100 lg:min-h-0 ' +
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
export function ScrollHint({
  children,
  className,
}: Readonly<{ children: ReactNode; className?: string }>) {
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
    <div className={className ? `relative ${className}` : 'relative'}>
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
