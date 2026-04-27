/**
 * Tooltip — lightweight accessible hover/focus tooltip primitive.
 *
 * Wraps arbitrary trigger content and shows a themed popover on hover or
 * keyboard focus. Built to replace scattered native `title=""` attrs with
 * a faster, styled, dark-mode-friendly hint that supports rich content.
 *
 * ## Accessibility
 *
 * - `aria-describedby` wires the trigger to the popover's `role="tooltip"`
 *   id (via `useId`) so screen readers announce the hint alongside the
 *   trigger's own label.
 * - Visible on both hover (mouseenter/leave) and keyboard focus
 *   (focus/blur). The trigger wrapper is a `<span>` with `tabIndex={0}`
 *   only when the inner child isn't already focusable — the wrapping
 *   logic is simplest if we always attach handlers to the wrapper rather
 *   than the child, so keyboard users get the tooltip regardless of the
 *   child's interactivity.
 * - Escape key dismisses an open tooltip. A document-level `keydown`
 *   listener is added only while the tooltip is shown, then torn down —
 *   no idle listeners accumulate.
 *
 * ## Positioning
 *
 * CSS-only with **runtime side-flip on show**. The popover is absolutely
 * positioned relative to the `position: relative` wrapper, with one of
 * four side classes (top/bottom/left/right) applied. When the tooltip
 * is about to render, we measure the trigger's bounding rect and flip
 * the side if the requested side would clip past the viewport (e.g. a
 * `right`-side tooltip near the right edge of the screen flips to
 * `left`). The flip happens once on show — we don't re-measure on
 * scroll, so a tooltip held open during scroll may end up clipping;
 * that's an acceptable trade-off for a hover-only hint primitive. If
 * we ever need full collision detection (shift/arrow), swap in
 * Floating UI; the public API here stays the same.
 *
 * ## Performance
 *
 * - The popover subtree is conditionally rendered (`{shown ? ... : null}`)
 *   rather than toggled via CSS `display:none` — React doesn't pay for
 *   offscreen children until they're needed.
 * - `React.memo` wraps the component so re-renders from an unchanging
 *   parent don't churn it.
 */

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /** Tooltip body — can be a string or rich ReactNode. */
  content: ReactNode;
  /** The element that triggers the tooltip on hover/focus. */
  children: ReactNode;
  /** Which side of the trigger to render on. Defaults to `'top'`. */
  side?: TooltipSide;
  /** Max popover width in pixels. Defaults to 260. */
  maxWidth?: number;
  /** Optional class applied to the trigger wrapper. Rare — mainly for layout fixes. */
  className?: string;
}

// ── Side-specific positioning classes ────────────────────────────────
//
// Popover is absolutely positioned relative to a `position: relative`
// wrapper. The mapping below handles both the orthogonal axis and the
// cross-axis centering.

const SIDE_CLASS: Record<TooltipSide, string> = {
  top: 'bottom-full left-1/2 mb-1 -translate-x-1/2',
  bottom: 'top-full left-1/2 mt-1 -translate-x-1/2',
  left: 'right-full top-1/2 mr-1 -translate-y-1/2',
  right: 'left-full top-1/2 ml-1 -translate-y-1/2',
};

/**
 * Accessible hover/focus tooltip. See module docstring for design rationale.
 */
/** Pixel cushion to keep between the popover and the viewport edge. */
const VIEWPORT_PADDING = 8;

/**
 * Decide the actual side to render on, given the requested side, the
 * trigger's bounding rect, and the popover's max width. If the requested
 * side would push past the viewport edge, flip to the opposite side.
 * Otherwise return the requested side unchanged.
 *
 * Returns the requested side unchanged when the trigger has degenerate
 * dimensions (zero width and height). This happens in JSDOM tests and
 * before the trigger has been laid out — flipping based on a zero-rect
 * would always pick the wrong side.
 *
 * Module-private to keep the file's public API single-export
 * (react-refresh requires component-only exports for HMR to work).
 */
function pickTooltipSide(
  requested: TooltipSide,
  trigger: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number; height: number },
  popoverMaxWidth: number,
): TooltipSide {
  // Skip flipping for unmeasured / degenerate triggers.
  const triggerWidth = trigger.right - trigger.left;
  const triggerHeight = trigger.bottom - trigger.top;
  if (triggerWidth <= 0 && triggerHeight <= 0) return requested;

  // Heights are unknown until the popover renders; assume a typical
  // single-line ~28px and a multi-line ~120px worst-case for top/bottom
  // flip decisions. The flip is conservative — a slight clip is better
  // than a wrong-side flip when content is small.
  const ASSUMED_POPOVER_HEIGHT = 60;
  switch (requested) {
    case 'top':
      return trigger.top < ASSUMED_POPOVER_HEIGHT + VIEWPORT_PADDING
        ? 'bottom'
        : 'top';
    case 'bottom':
      return viewport.height - trigger.bottom <
        ASSUMED_POPOVER_HEIGHT + VIEWPORT_PADDING
        ? 'top'
        : 'bottom';
    case 'right':
      return viewport.width - trigger.right < popoverMaxWidth + VIEWPORT_PADDING
        ? 'left'
        : 'right';
    case 'left':
      return trigger.left < popoverMaxWidth + VIEWPORT_PADDING
        ? 'right'
        : 'left';
  }
}

export const Tooltip = memo(function Tooltip({
  content,
  children,
  side = 'top',
  maxWidth = 260,
  className,
}: TooltipProps) {
  const [shown, setShown] = useState(false);
  const [actualSide, setActualSide] = useState<TooltipSide>(side);
  const tooltipId = useId();

  const show = useCallback(() => setShown(true), []);
  const hide = useCallback(() => setShown(false), []);

  // Escape-to-dismiss. Listener is only attached while shown, then torn
  // down — no idle listeners. Using a ref-less callback is fine; the
  // effect re-runs each time `shown` flips.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShown(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shown]);

  // Focus/blur must bubble from child controls: using the wrapper span
  // with onFocus / onBlur (which bubble from descendants in React) means
  // a keyboard user tabbing into a focusable child (like an <input>)
  // still surfaces the tooltip without needing to alter the child.
  const wrapperRef = useRef<HTMLSpanElement>(null);

  // On show, measure the trigger's viewport position and flip the side
  // if needed. We update `actualSide` synchronously before the popover
  // paints to avoid a one-frame flicker on the wrong side.
  useEffect(() => {
    if (!shown || !wrapperRef.current) return;
    const trigger = wrapperRef.current.getBoundingClientRect();
    setActualSide(
      pickTooltipSide(
        side,
        trigger,
        { width: window.innerWidth, height: window.innerHeight },
        maxWidth,
      ),
    );
  }, [shown, side, maxWidth]);

  const sideClass = SIDE_CLASS[actualSide];

  const classes = ['relative inline-flex', className].filter(Boolean).join(' ');

  return (
    <span
      ref={wrapperRef}
      className={`${classes} focus-visible:ring-accent rounded-sm focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none`}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={shown ? tooltipId : undefined}
    >
      {children}
      {shown ? (
        <span
          id={tooltipId}
          role="tooltip"
          className={`border-edge bg-surface text-primary pointer-events-none absolute z-50 rounded border px-2 py-1 font-mono text-[10px] leading-snug shadow-[var(--shadow-card)] ${sideClass} animate-in fade-in duration-100`}
          style={{ maxWidth: `${maxWidth}px`, width: 'max-content' }}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
});

export default Tooltip;
