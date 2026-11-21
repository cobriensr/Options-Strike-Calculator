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
 * deletion, insertion). Elements that may be named (`section`, `th`, `td`,
 * `svg`, headings, ...) are not listed.
 */
const GENERIC_TAGS = [
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
] as const;
const GENERIC_SELECTOR = GENERIC_TAGS.join(',');

/**
 * Every element under `root` that has an `aria-label` but no explicit role
 * and is a bare generic element (a `span`, `div`, `p`, ...), as short HTML
 * snippets for a readable failure.
 *
 * ARIA 1.2 prohibits naming a generic element, and screen readers mostly
 * ignore the label, so the text never reaches the user. A badge's
 * explanation belongs in a visually hidden `<SrHint>` inside the badge
 * instead. An element with an explicit role (`img`, `group`, ...) is fine
 * and is not reported, and neither is an element that may carry a name
 * (a `<section>` region, a `<th>`, a `<button>`).
 */
export function genericElementsWithAriaLabel(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('[aria-label]'))
    .filter((el) => !el.hasAttribute('role') && el.matches(GENERIC_SELECTOR))
    .map(snippet);
}

/** The `SrHint` span that is a direct child of `badge`, if it has one. */
function ownHint(badge: Element): Element | null {
  return (
    Array.from(badge.children).find((c) => c.classList.contains('sr-only')) ??
    null
  );
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

/** The text a sighted user reads in `el`: everything but its own hint. */
function visibleText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  const hint = ownHint(copy);
  if (hint != null) copy.removeChild(hint);
  return squashText(copy.textContent);
}

/**
 * Every element under `root` whose `title` a screen reader would never
 * hear: it has a non-empty `title`, and
 * - no role (an `img` or `group` is named some other way),
 * - isn't natively interactive (a button or link is named by its content),
 * - doesn't already show its title text (its own hint left out).
 * A `title` is mouse-only, so such an element needs a `<SrHint>` as a
 * direct child.
 */
export function titledElementsNeedingHint(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll('[title]')).filter((el) => {
    const title = squashText(el.getAttribute('title'));
    if (title === '') return false;
    if (el.hasAttribute('role') || el.matches(NATIVELY_NAMED)) return false;
    return !visibleText(el).includes(title);
  });
}

/** Snippets of the {@link titledElementsNeedingHint} that have no hint. */
export function titledElementsWithoutHint(root: ParentNode): string[] {
  return titledElementsNeedingHint(root)
    .filter((el) => ownHint(el) == null)
    .map(snippet);
}
