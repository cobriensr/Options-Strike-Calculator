/**
 * Alpha-tint a CSS color using color-mix().
 * Accepts a CSS color value (including var() references) and a hex alpha string
 * (e.g. '18' for ~9% opacity) matching the old `color + 'HH'` pattern.
 */
export function tint(cssColor: string, hexAlpha: string): string {
  const pct = Math.round((Number.parseInt(hexAlpha, 16) / 255) * 100);
  return `color-mix(in srgb, ${cssColor} ${pct}%, transparent)`;
}

/** Build a data URI for a dropdown chevron. Resolves CSS var if needed. */
export function buildChevronUrl(color: string): string {
  let resolved = color;
  if (color.startsWith('var(') && typeof document !== 'undefined') {
    const prop = color.slice(4, -1);
    resolved =
      getComputedStyle(document.documentElement)
        .getPropertyValue(prop)
        .trim() || color;
  }
  return (
    'url("data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><path d="M3 5l3 3 3-3" fill="none" stroke="${resolved}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    ) +
    '")'
  );
}

/** Table header cell className builder — returns Tailwind classes */
export function mkTh(align: string, colorClass?: string): string {
  const alignCls =
    align === 'center'
      ? 'text-center'
      : align === 'right'
        ? 'text-right'
        : 'text-left';
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
export const tinyLbl =
  'block text-[10px] font-bold uppercase tracking-[0.08em] text-tertiary font-sans mb-1';
