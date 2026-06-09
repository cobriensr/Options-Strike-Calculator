/**
 * Shared retry affordance for the Greek heatmap's degrade states.
 *
 * Three tones map to the three contexts the button appears in:
 *   - neutral: the soft "Reconnecting" first-load placeholder
 *   - rose:    the hard first-load error card
 *   - amber:   the stale-data badge below a still-rendered grid
 *
 * Extracted so the three previously-duplicated `type="button"` retry
 * buttons share one implementation (the tone only changes the classes).
 */

type RetryButtonTone = 'neutral' | 'rose' | 'amber';

const TONE_CLASS: Record<RetryButtonTone, string> = {
  neutral:
    'rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800/60',
  rose: 'rounded border border-rose-700/70 px-2 py-0.5 text-[11px] hover:bg-rose-900/40',
  amber:
    'rounded border border-amber-500/50 px-2 py-0.5 text-[10px] uppercase hover:bg-amber-900/40',
};

interface RetryButtonProps {
  onClick: () => void;
  tone: RetryButtonTone;
}

export function RetryButton({ onClick, tone }: RetryButtonProps) {
  return (
    <button type="button" onClick={onClick} className={TONE_CLASS[tone]}>
      Retry
    </button>
  );
}
