import type { ViewMode } from '../hooks/useViewMode';

interface ViewToggleProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
}

const TABS: Array<{ value: ViewMode; label: string }> = [
  { value: 'calculator', label: 'Calculator' },
  { value: 'alerts', label: 'Options Alerts' },
];

/**
 * Always-visible header segmented control switching between the calculator
 * workspace and the dedicated Options Alerts view. Wired to `useViewMode`
 * by the parent (AppHeader → App).
 */
export function ViewToggle({ view, onViewChange }: ViewToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="Application view"
      className="border-edge-strong bg-surface flex items-center rounded-lg border-[1.5px] p-0.5"
    >
      {TABS.map((tab) => {
        const active = view === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onViewChange(tab.value)}
            className={`min-h-[36px] rounded-md px-2.5 font-sans text-[11px] font-semibold transition-colors duration-200 ${
              active
                ? 'bg-accent text-white'
                : 'text-secondary hover:text-primary'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
