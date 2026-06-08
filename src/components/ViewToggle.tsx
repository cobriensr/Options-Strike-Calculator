import type { ViewMode } from '../hooks/useViewMode';

interface ViewToggleProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
}

const VIEWS: Array<{ value: ViewMode; label: string }> = [
  { value: 'calculator', label: 'Calculator' },
  { value: 'alerts', label: 'Options Alerts' },
];

/**
 * Always-visible header control switching between the calculator workspace
 * and the dedicated Options Alerts view. Modeled as navigation (not a tab
 * widget): the views are separate top-level routes keyed off the URL hash,
 * so the active control is marked with aria-current="page" rather than the
 * tablist/tabpanel contract (which would require role=tabpanel + aria-controls
 * + roving tabindex that don't apply here).
 */
export function ViewToggle({ view, onViewChange }: ViewToggleProps) {
  return (
    <nav
      aria-label="Application view"
      className="border-edge-strong bg-surface flex items-center rounded-lg border-[1.5px] p-0.5"
    >
      {VIEWS.map((item) => {
        const active = view === item.value;
        return (
          <button
            key={item.value}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onViewChange(item.value)}
            className={`min-h-[36px] rounded-md px-2.5 font-sans text-[11px] font-semibold transition-colors duration-200 ${
              active
                ? 'bg-accent text-white'
                : 'text-secondary hover:text-primary'
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
