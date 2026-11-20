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
 * Leave the hint out where it would only repeat the visible text.
 */
export function SrHint({ children }: { children: string }) {
  return (
    <span className="sr-only normal-case select-none">{` — ${children}`}</span>
  );
}
