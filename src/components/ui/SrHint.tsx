/**
 * Visually hidden explanation for a badge or chip, placed inside it after
 * the visible label so a screen reader reads the label, then the hint.
 *
 * The badges keep a `title` for mouse hover. `aria-label` on a bare span or
 * div is not an option: ARIA 1.2 prohibits naming a generic element, and
 * screen readers mostly ignore it, so the hover text never reached them.
 * Text inside the element does. The leading dash keeps the label and the
 * hint from running together when read aloud (the Schwab expiry badge uses
 * the same separator).
 *
 * `normal-case` keeps a badge's `uppercase` from reaching the hint: a browser
 * exposes the transformed text, so a screen reader would read it shouted.
 *
 * `select-none` keeps the hint out of selections and copies, so copying a
 * row's text pastes only what is visible. Screen readers are unaffected, and
 * browser find-in-page still matches the hidden text.
 *
 * `top-0 left-0` stop the hint from widening the page on a phone. `sr-only`
 * is `position: absolute` with no offsets, so the hint stays at the static
 * position it would have had in the flow. Inside a table in a horizontal
 * scroller that is the right-most column, and a scroller that is not itself
 * positioned neither contains nor clips an absolute child: the page scrolled
 * sideways (the hint sat at x=585 on a 375px screen). With both offsets set
 * it sits at the corner of its containing block, the nearest positioned
 * ancestor or the page origin, which is always on screen. Reading order is
 * DOM order, so it does not change. `StatusBadge`'s `relative` is the
 * narrower, older cure for the same trap and is harmless beside this.
 *
 * Leave the hint out where it would only repeat the visible text.
 */
export function SrHint({ children }: { children: string }) {
  return (
    <span className="sr-only top-0 left-0 normal-case select-none">
      {` — ${children}`}
    </span>
  );
}
