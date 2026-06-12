/**
 * Alpha-tint a CSS color using color-mix().
 * Accepts a CSS color value (including var() references) and a hex alpha string
 * (e.g. '18' for ~9% opacity) matching the old `color + 'HH'` pattern.
 *
 * NOTE: This mixes *toward transparent* — the result is a partially transparent
 * version of the input color, not a lighter shade on an opaque background.
 * If you want a readable tinted panel/card, use `tintedSurface()` instead,
 * which mixes toward a surface color so the result stays opaque.
 */
export function tint(cssColor: string, hexAlpha: string): string {
  const pct = Math.round((Number.parseInt(hexAlpha, 16) / 255) * 100);
  return `color-mix(in srgb, ${cssColor} ${pct}%, transparent)`;
}

/**
 * Mix an accent color *into* a base surface color to produce an opaque,
 * readable tinted panel. Use this for alert backgrounds, badge panels, or
 * any surface that needs to carry a semantic accent hue while keeping high
 * contrast for text layered on top.
 *
 * Unlike `tint()`, this does not cut a transparency hole — the result is a
 * solid color suitable for use behind foreground text.
 */
export function tintedSurface(
  accent: string,
  pct: number,
  surface: string,
): string {
  return `color-mix(in srgb, ${accent} ${pct}%, ${surface})`;
}

/**
 * Resolved chevron stroke colors, mirroring `--color-chevron` in index.css
 * for the light (`:root`) and dark (`.dark`) themes respectively.
 *
 * The SVG data URI bakes the stroke color in at build time, so it cannot
 * reference the CSS variable directly — it must carry a concrete color.
 * Selecting the color from the known `darkMode` flag (rather than reading
 * `getComputedStyle` during render) keeps the chevron in sync with the
 * CURRENT theme: the `.dark` class is toggled in an effect that runs AFTER
 * render, so a getComputedStyle read would always lag one toggle behind.
 */
export const CHEVRON_COLOR_LIGHT = '#5c5950';
export const CHEVRON_COLOR_DARK = '#9898a8';

/** Resolve the chevron stroke color from the active theme flag. */
export function chevronColorForTheme(darkMode: boolean): string {
  return darkMode ? CHEVRON_COLOR_DARK : CHEVRON_COLOR_LIGHT;
}

/**
 * Build a data URI for a dropdown chevron from a concrete stroke color.
 *
 * Pass a resolved color (e.g. via `chevronColorForTheme`) — this function
 * does NOT read computed styles, so the result reflects the color you give
 * it on the current render rather than the previously-applied theme.
 */
export function buildChevronUrl(color: string): string {
  return (
    'url("data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><path d="M3 5l3 3 3-3" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
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

/** Return a CSS color variable based on risk percentage thresholds */
export function riskColor(pct: number): string {
  if (pct > 5) return 'var(--color-danger)';
  if (pct > 3) return 'var(--color-caution)';
  return 'var(--color-success)';
}

/** Tiny label className constant */
export const tinyLbl =
  'block text-[10px] font-bold uppercase tracking-[0.08em] text-tertiary font-sans mb-1';

/** Standard full-width text input styling — used across all input sections */
export const inputCls =
  'bg-input border-[1.5px] border-edge-strong hover:border-edge-heavy rounded-lg text-primary p-[11px_14px] text-base font-mono outline-none w-full box-border transition-[border-color] duration-150';

/** Standard full-width select styling — extends inputCls with chevron appearance */
export const selectCls =
  inputCls +
  ' cursor-pointer appearance-none bg-no-repeat bg-[length:14px_14px] bg-[position:right_12px_center] pr-[34px]';
