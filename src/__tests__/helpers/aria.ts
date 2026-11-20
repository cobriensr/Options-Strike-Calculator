/**
 * Elements a user can focus or that carry their own role, so `aria-label`
 * is a legitimate name for them.
 */
const NATIVELY_NAMED = 'button, a[href], input, select, textarea, summary';

/**
 * Every element under `root` that has an `aria-label` but no role and isn't
 * natively interactive, as short HTML snippets for a readable failure.
 *
 * ARIA 1.2 prohibits naming a generic element (a bare span or div), and
 * screen readers mostly ignore the label, so the text never reaches the
 * user. A badge's explanation belongs in a visually hidden `<SrHint>`
 * inside the badge instead. An element with an explicit role (`img`,
 * `group`, ...) is fine and is not reported.
 */
export function genericElementsWithAriaLabel(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('[aria-label]'))
    .filter((el) => !el.hasAttribute('role') && !el.matches(NATIVELY_NAMED))
    .map((el) => el.outerHTML.slice(0, 160));
}

/**
 * The visually hidden hint text inside a badge, with the leading
 * separator trimmed. Null when the badge has no `SrHint`.
 */
export function srHintText(badge: Element): string | null {
  const hint = badge.querySelector('.sr-only');
  if (hint == null) return null;
  return (hint.textContent ?? '').replace(/^\s*—\s*/, '').trim();
}
