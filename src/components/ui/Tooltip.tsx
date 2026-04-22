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
 * CSS-only — the popover is absolutely positioned relative to the
 * `position: relative` wrapper. V1 trade-off: no viewport-edge detection,
 * so tooltips near the right/top/bottom edges of the viewport may clip.
 * That's acceptable for this widget (the content lives well inside the
 * viewport in practice). If clipping becomes a real problem, swap in
 * Floating UI — the public API here stays the same.
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
export const Tooltip = memo(function Tooltip({
  content,
  children,
  side = 'top',
  maxWidth = 260,
  className,
}: TooltipProps) {
  const [shown, setShown] = useState(false);
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

  const sideClass = SIDE_CLASS[side];

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
