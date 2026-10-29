/**
 * ControlsRow — the header's row of view, status and tool controls.
 *
 * Below xl (1280px) the row scrolls sideways (the header must stay one
 * control row tall; see AppHeader's notes), and fades at its edges show
 * when there is more to scroll that way, like the SectionNav strip under
 * it. That reaches up to 1279px because the owner's full row (backtest
 * pills, Schwab countdown, admin tools) doesn't fit at 1024: squeezed, it
 * wrapped the header to 105px and pushed controls off the page. At xl and
 * up the wrapper's box is dropped (`contents`), the fades are hidden, and
 * the row is laid out as a plain flex row, exactly as before.
 *
 * Layout below xl:
 *
 *   - The wrapper is the bar's flex item. `min-w-0` lets it shrink below
 *     its content; it is positioned, so the fades sit on the row's edges
 *     and don't scroll with it.
 *   - The row's padding keeps a focus ring in view at either end (the
 *     wrapper's negative margins cancel the top, bottom and right
 *     padding; the left padding is the gap after the title). The scroll
 *     padding and `scrollTabbedControlIntoView` do the same for a control
 *     tabbed to part-way off the edge.
 *   - The row is `relative`, so it is the containing block for its
 *     absolutely positioned descendants, such as the visually hidden
 *     (sr-only) text in the Schwab badge, and clips them. Without it they
 *     escaped to the header and widened the page.
 */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

/**
 * Brings a control reached with Tab fully into view. The browser leaves a
 * control that is already partly visible where it is, with its focus ring
 * cut off. It runs on the Tab key's keyup, which fires on the newly
 * focused control, so a click or tap never scrolls the row: scrolling on
 * pointer focus would move the control out from under the pointer and
 * lose the click. React key events bubble through portals, so a dialog
 * opened from the row is skipped. A no-op wherever the whole row is on
 * screen (always at xl and up).
 */
function scrollTabbedControlIntoView(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab') return;
  const focused = document.activeElement;
  if (!focused || !e.currentTarget.contains(focused)) return;
  focused.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Which way the row can still scroll; drives the edge fades. */
function useScrollableEdges(rowRef: RefObject<HTMLElement | null>) {
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const update = () => {
      const maxScroll = row.scrollWidth - row.clientWidth;
      setCanScrollLeft(row.scrollLeft > 1);
      setCanScrollRight(row.scrollLeft < maxScroll - 1);
    };
    // The row's own box rarely changes size; its content does, when a
    // control grows or shrinks (a child resize) or comes and goes (a
    // child added or removed, e.g. the Schwab badge once its status
    // arrives).
    const resizes = new ResizeObserver(update);
    const observeAll = () => {
      resizes.disconnect();
      resizes.observe(row);
      for (const child of row.children) resizes.observe(child);
    };
    const mutations = new MutationObserver(() => {
      observeAll();
      update();
    });
    observeAll();
    mutations.observe(row, { childList: true });
    row.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      row.removeEventListener('scroll', update);
      mutations.disconnect();
      resizes.disconnect();
    };
  }, [rowRef]);

  return { canScrollLeft, canScrollRight };
}

const FADE_CLASS =
  'pointer-events-none absolute inset-y-0 w-6 transition-opacity duration-150 xl:hidden';

export default function ControlsRow({
  children,
}: Readonly<{ children: ReactNode }>) {
  const rowRef = useRef<HTMLDivElement>(null);
  const { canScrollLeft, canScrollRight } = useScrollableEdges(rowRef);

  return (
    <div className="max-xl:relative max-xl:-my-1.5 max-xl:-mr-1.5 max-xl:min-w-0 xl:contents">
      <div
        ref={rowRef}
        onKeyUp={scrollTabbedControlIntoView}
        className="scrollbar-hide flex items-center gap-1.5 max-xl:relative max-xl:scroll-px-1.5 max-xl:overflow-x-auto max-xl:p-1.5 max-xl:*:shrink-0 sm:gap-2"
      >
        {children}
      </div>
      <div
        aria-hidden="true"
        data-testid="controls-fade-left"
        className={`${FADE_CLASS} left-0 ${canScrollLeft ? 'opacity-100' : 'opacity-0'}`}
        style={{
          background:
            'linear-gradient(to right, var(--color-page) 0%, transparent 100%)',
        }}
      />
      <div
        aria-hidden="true"
        data-testid="controls-fade-right"
        className={`${FADE_CLASS} right-0 ${canScrollRight ? 'opacity-100' : 'opacity-0'}`}
        style={{
          background:
            'linear-gradient(to left, var(--color-page) 0%, transparent 100%)',
        }}
      />
    </div>
  );
}
