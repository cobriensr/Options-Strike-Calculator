/**
 * Single theme constant backed by CSS custom properties.
 * Light/dark switching is handled entirely by CSS — the `.dark` class
 * overrides `--color-*` vars, and these references resolve automatically.
 *
 * This means color values only need to be defined in one place: index.css.
 */
export const theme = {
  bg: 'var(--color-page)',
  surface: 'var(--color-surface)',
  surfaceAlt: 'var(--color-surface-alt)',
  inputBg: 'var(--color-input)',
  border: 'var(--color-edge)',
  borderStrong: 'var(--color-edge-strong)',
  borderHeavy: 'var(--color-edge-heavy)',
  text: 'var(--color-primary)',
  textSecondary: 'var(--color-secondary)',
  textTertiary: 'var(--color-tertiary)',
  textMuted: 'var(--color-muted)',
  textPlaceholder: 'var(--color-placeholder)',
  accent: 'var(--color-accent)',
  accentBg: 'var(--color-accent-bg)',
  green: 'var(--color-success)',
  red: 'var(--color-danger)',
  caution: 'var(--color-caution)',
  backtest: 'var(--color-backtest)',
  badgeColor: 'var(--color-badge)',
  /** Data-freshness status pills — LIVE polling, vs SCRUBBED-back, vs STALE/historical. */
  statusLive: 'var(--color-status-live)',
  statusScrubbed: 'var(--color-status-scrubbed)',
  statusStale: 'var(--color-status-stale)',
  tooltipBg: 'var(--color-tooltip-bg)',
  tooltipText: 'var(--color-tooltip-text)',
  tooltipCodeBg: 'var(--color-tooltip-code-bg)',
  tooltipCodeText: 'var(--color-tooltip-code-text)',
  focusRing: 'var(--color-focus-ring)',
  tableRowAlt: 'var(--color-table-alt)',
  tableHeader: 'var(--color-table-header)',
  chipBg: 'var(--color-chip-bg)',
  chipActiveBg: 'var(--color-chip-active-bg)',
  chipBorder: 'var(--color-chip-border)',
  chipActiveBorder: 'var(--color-chip-active-border)',
  chipText: 'var(--color-chip-text)',
  chipActiveText: 'var(--color-chip-active-text)',
  chevronColor: 'var(--color-chevron)',
  chartPurple: 'var(--color-chart-purple)',
  chartAmber: 'var(--color-chart-amber)',
} as const;

export type Theme = typeof theme;
