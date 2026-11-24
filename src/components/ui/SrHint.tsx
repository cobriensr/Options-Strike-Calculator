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
 * The hint carries no offset (no `top-0 left-0` or the like). `sr-only` is
 * `position: absolute` with no offsets, so its box stays at the static
 * position it would have had in the flow: right after the text it explains,
 * which is where a screen reader that scrolls to its reading position
 * (VoiceOver on iOS) expects it. An offset would move the box to the corner
 * of its containing block, which for most rows is the page origin, and send
 * such a reader to the top of the page at every hint.
 *
 * The cost is containment, and the caller pays it. An absolute box is
 * contained and clipped only by a positioned ancestor, so a horizontal
 * scroller that holds hints must be positioned itself (`relative`), as
 * `ScrollHint` is. Without that, a hint in a table's right-most column sits
 * past the edge of a phone and the page scrolls sideways (the hint was at
 * x=585 on a 375px screen). A `StatusBadge` with a hint is `relative` for the
 * same reason. Give any `overflow-x-auto` or `overflow-y-auto` container that
 * wraps hinted content `relative` too (an `overflow-y-auto` box scrolls
 * sideways as well, because its `overflow-x` computes to `auto`).
 *
 * Leave the hint out where it would only repeat the visible text.
 */
export function SrHint({ children }: { children: string }) {
  return (
    <span className="sr-only normal-case select-none">{` — ${children}`}</span>
  );
}
