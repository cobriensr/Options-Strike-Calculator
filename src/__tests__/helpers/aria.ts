/**
 * Elements a user can focus or that carry their own role, so `aria-label`
 * is a legitimate name for them.
 */
const NATIVELY_NAMED = 'button, a[href], input, select, textarea, summary';

/** Whitespace-collapsed text, so a title and its hint compare as read. */
export const squashText = (s: string | null | undefined): string =>
  (s ?? '').replace(/\s+/g, ' ').trim();

const snippet = (el: Element): string => el.outerHTML.slice(0, 160);

/**
 * HTML elements whose implicit ARIA role prohibits a name (ARIA 1.2:
 * generic, paragraph, emphasis, strong, code, subscript, superscript,
 * deletion, insertion, caption). Elements that may be named (`section`, `th`,
 * `td`, `svg`, headings, ...) are not listed.
 *
 * One list for two guards: the runtime helper below and the source scan in
 * `generic-aria-scan.ts`.
 */
export const GENERIC_TAGS = [
  'span',
  'div',
  'p',
  'i',
  'b',
  'em',
  'strong',
  'small',
  'code',
  'sub',
  'sup',
  'del',
  'ins',
  's',
  'u',
  'caption',
  'figcaption',
] as const;
const GENERIC_SELECTOR = GENERIC_TAGS.join(',');

/**
 * Whether a `role` value leaves the element without a role that can carry a
 * name, so a bare generic element with it is still a named generic. That is
 * a value that is empty or only whitespace (a browser ignores an empty role),
 * or a presentational one: its first token (case and padding aside) is `none`
 * or `presentation`, which strip an element's semantics but are ignored when
 * a global ARIA attribute such as `aria-label` is present. Shared by the
 * runtime helper below and the source scan in `generic-aria-scan.ts`, so both
 * apply one rule.
 */
export function countsAsNoRole(role: string): boolean {
  const first = role.trim().toLowerCase().split(/\s+/)[0];
  return first === '' || first === 'none' || first === 'presentation';
}

/**
 * Every element under `root` that has an `aria-label` or `aria-labelledby`
 * but no role and is a bare generic element (a `span`, `div`, `p`, ...), as
 * short HTML snippets for a readable failure.
 *
 * ARIA 1.2 prohibits naming a generic element, and screen readers mostly
 * ignore the label, so the text never reaches the user. A badge's
 * explanation belongs in a visually hidden `<SrHint>` inside the badge
 * instead. An element with a role (`img`, `group`, ...) is fine and is not
 * reported, and neither is an element that may carry a name (a `<section>`
 * region, a `<th>`, a `<button>`). An empty or presentational role (`none`,
 * `presentation`) does not count as a role, see {@link countsAsNoRole}.
 */
export function genericElementsWithAriaLabel(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('[aria-label],[aria-labelledby]'))
    .filter((el) => {
      const role = el.getAttribute('role');
      const hasRole = role != null && !countsAsNoRole(role);
      return !hasRole && el.matches(GENERIC_SELECTOR);
    })
    .map(snippet);
}

/**
 * The `SrHint` span that is the last element child of `badge`, if it has one.
 * A hint is always the last child, so an `sr-only` span with another element
 * after it is not counted: whatever was added behind it would otherwise pass
 * unnoticed.
 */
function ownHint(badge: Element): Element | null {
  const last = badge.lastElementChild;
  return last != null && last.classList.contains('sr-only') ? last : null;
}

/**
 * The visually hidden hint text of a badge (its own `SrHint` child), with
 * the leading separator trimmed. Null when the badge has none.
 */
export function srHintText(badge: Element): string | null {
  const hint = ownHint(badge);
  if (hint == null) return null;
  return (hint.textContent ?? '').replace(/^\s*—\s*/, '').trim();
}

/**
 * The text a sighted user reads in `el`: everything but its hidden hints.
 * Every `sr-only` descendant is left out, at any depth, not only the
 * last-child hint that {@link ownHint} recognizes. A hint with an element
 * after it, or one nested a level down, is hidden all the same; counting its
 * text as visible would let a title it repeats pass as shown, and the
 * misplaced hint would go unreported.
 */
function visibleText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const hint of copy.querySelectorAll('.sr-only')) {
    hint.remove();
  }
  return squashText(copy.textContent);
}

/**
 * Every element under `root` whose `title` a screen reader would never
 * hear: it has a non-empty `title`, and
 * - no real role (an `img` or `group` is named some other way; an empty or
 *   presentational role does not count, see {@link countsAsNoRole}),
 * - isn't natively interactive (a button or link is named by its content),
 * - doesn't already show its title text (every `.sr-only` descendant left
 *   out, see {@link visibleText}).
 * A `title` is mouse-only, so such an element needs a `<SrHint>` as a
 * direct child.
 */
export function titledElementsNeedingHint(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll('[title]')).filter((el) => {
    const title = squashText(el.getAttribute('title'));
    if (title === '') return false;
    const role = el.getAttribute('role');
    const hasRole = role != null && !countsAsNoRole(role);
    if (hasRole || el.matches(NATIVELY_NAMED)) return false;
    return !visibleText(el).includes(title);
  });
}

/** Snippets of the {@link titledElementsNeedingHint} that have no hint. */
export function titledElementsWithoutHint(root: ParentNode): string[] {
  return titledElementsNeedingHint(root)
    .filter((el) => ownHint(el) == null)
    .map(snippet);
}

/**
 * Snippets of the {@link titledElementsWithoutHint} limited to bare generic
 * elements (`GENERIC_TAGS`: a `span`, `div`, `p`, ...), the same boundary as
 * {@link genericElementsWithAriaLabel}. Titled elements that are not generic
 * (a `<label>`, a `<td>`) are out of scope here.
 */
export function titledGenericsWithoutHint(root: ParentNode): string[] {
  return titledElementsNeedingHint(root)
    .filter((el) => el.matches(GENERIC_SELECTOR) && ownHint(el) == null)
    .map(snippet);
}
