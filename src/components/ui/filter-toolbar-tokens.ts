/**
 * Shared chip + label tokens for the dense filter toolbars on
 * LotteryFinderSection and SilentBoomSection. Class strings are written
 * out as literals — Tailwind's scanner cannot resolve interpolated
 * variants like `border-${color}-500/70` at build time.
 */

export type FilterChipColor =
  | 'sky'
  | 'rose'
  | 'amber'
  | 'emerald'
  | 'green'
  | 'red'
  | 'blue'
  | 'fuchsia'
  | 'orange'
  | 'purple'
  | 'neutral';

export const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors';

export const CHIP_INACTIVE =
  'border-neutral-700 bg-neutral-800/60 text-neutral-300 hover:border-neutral-600 hover:text-neutral-100';

export const CHIP_ACTIVE: Record<FilterChipColor, string> = {
  sky: 'border-sky-500/70 bg-sky-950/40 text-sky-200',
  rose: 'border-rose-500/70 bg-rose-950/40 text-rose-200',
  amber: 'border-amber-500/70 bg-amber-950/40 text-amber-200',
  emerald: 'border-emerald-500/70 bg-emerald-950/40 text-emerald-200',
  green: 'border-green-500/70 bg-green-950/40 text-green-200',
  red: 'border-red-500/70 bg-red-950/40 text-red-200',
  blue: 'border-blue-500/70 bg-blue-950/40 text-blue-200',
  fuchsia: 'border-fuchsia-500/70 bg-fuchsia-950/40 text-fuchsia-200',
  orange: 'border-orange-500/70 bg-orange-950/40 text-orange-200',
  purple: 'border-purple-500/70 bg-purple-950/40 text-purple-200',
  neutral: 'border-neutral-500 bg-neutral-800 text-neutral-200',
};

export const SECTION_LABEL =
  'text-[10px] font-semibold tracking-[0.08em] text-neutral-400 uppercase';

export const TOOLBAR_DIVIDER = 'mx-1 hidden h-4 w-px bg-neutral-800 sm:block';
