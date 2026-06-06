import { useState, type ReactNode } from 'react';

interface CompactDisclosureProps {
  label: string;
  /** Optional trailing summary (e.g. active-filter count) shown on the trigger row. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Sticky, collapsible header for dense/compact panes. The trigger row stays
 * pinned to the top of the nearest scroll container (`sticky top-0`) so the
 * controls it hides (e.g. a filter toolbar) are always one click away while
 * the content below scrolls. Collapsed by default to maximize visible rows.
 */
export function CompactDisclosure({
  label,
  summary,
  defaultOpen = false,
  children,
}: CompactDisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-edge bg-page sticky top-0 z-10 border-b">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-secondary hover:text-primary flex w-full items-center gap-2 px-3 py-1.5 font-sans text-[11px] font-semibold"
      >
        <span aria-hidden="true">{open ? '⌄' : '›'}</span>
        <span>{label}</span>
        {summary != null && (
          <span className="text-tertiary ml-auto font-normal">{summary}</span>
        )}
      </button>
      {open && <div className="px-3 pb-2">{children}</div>}
    </div>
  );
}
