import type { ViewMode } from '../hooks/useViewMode';

interface ViewToggleProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
}

const VIEWS: Array<{ value: ViewMode; label: string; short: string }> = [
  { value: 'calculator', label: 'Calculator', short: 'Calc' },
  { value: 'alerts', label: 'Options Alerts', short: 'Alerts' },
];

/**
 * Always-visible header control switching between the calculator workspace
 * and the dedicated Options Alerts view. Modeled as navigation (not a tab
 * widget): the views are separate top-level routes keyed off the URL hash,
 * so the active control is marked with aria-current="page" rather than the
 * tablist/tabpanel contract (which would require role=tabpanel + aria-controls
 * + roving tabindex that don't apply here).
 *
 * A phone (below sm) shows the short labels with tighter padding, so the
 * toggle and the header's status pills fit at 320px. The full label stays
 * the button's accessible name there, visually hidden, and contains the
 * short one (WCAG 2.5.3, label in name). The button is `relative` so the
 * visually hidden label is positioned, and clipped, with it: in the
 * header's sideways-scrolling row an unpositioned one escaped the row's
 * clip and widened the page.
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
            className={`relative min-h-[36px] rounded-md px-2 font-sans text-[11px] font-semibold transition-colors duration-200 sm:px-2.5 ${
              active
                ? 'bg-accent text-white'
                : 'text-secondary hover:text-primary'
            }`}
          >
            <span aria-hidden="true" className="sm:hidden">
              {item.short}
            </span>
            <span className="max-sm:sr-only">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
