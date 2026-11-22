import ts from 'typescript';
import { GENERIC_TAGS, countsAsNoRole, squashText } from './aria';
import { literalText } from './generic-aria-scan';

const GENERIC = new Set<string>(GENERIC_TAGS);

/** The component every hint goes through (src/components/ui/SrHint.tsx). */
const HINT_COMPONENT = 'SrHint';

/**
 * The one component whose `title` this scan can read: it takes the hover text
 * as `title` and the same words for a screen reader as `srHint`. Another
 * component's `title` prop is a blind spot, because the scan can't see what
 * that component does with it.
 */
const HINT_PROP_COMPONENT = 'StatusBadge';

export interface TitleOnlyGeneric {
  /** The line of the `title` attribute, 1-based. */
  line: number;
  /** The tag: a generic element (`span`, `div`, ...) or `StatusBadge`. */
  tag: string;
  /** The title initializer's source text, whitespace-collapsed. */
  title: string;
}

/** What a JSX child or a conditional branch puts on the page. */
type Yields = 'hint' | 'nothing' | 'other';

const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
};

const isHintElement = (node: ts.Node): boolean => {
  const opening = ts.isJsxElement(node)
    ? node.openingElement
    : ts.isJsxSelfClosingElement(node)
      ? node
      : null;
  return (
    opening != null &&
    ts.isIdentifier(opening.tagName) &&
    opening.tagName.text === HINT_COMPONENT
  );
};

/**
 * What an expression in a JSX child slot renders: a `<SrHint>`, nothing
 * (`null`, `undefined`, `false`), or anything else. `a && <SrHint>` and a
 * conditional whose branches are hints or nothing (with at least one hint)
 * yield a hint, so a hint that shows only some of the time still counts. A
 * conditional with a visible branch yields `other`: on that branch the
 * element has no hint.
 */
function yields(expression: ts.Expression): Yields {
  const node = unwrap(expression);
  if (isHintElement(node)) return 'hint';
  if (
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  ) {
    return 'nothing';
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return yields(node.right);
  }
  if (ts.isConditionalExpression(node)) {
    const branches = [yields(node.whenTrue), yields(node.whenFalse)];
    if (branches.includes('other')) return 'other';
    return branches.includes('hint') ? 'hint' : 'nothing';
  }
  return 'other';
}

/**
 * Whether a JSX child shows nothing and reads as nothing, like the whitespace
 * and comment nodes `ownHint` (helpers/aria.ts) steps over at run time:
 * whitespace-only text, an empty `{}` that holds only a comment, and a
 * whitespace-only string such as `{' '}`.
 */
function isBlank(child: ts.JsxChild): boolean {
  if (ts.isJsxText(child)) return child.text.trim() === '';
  if (!ts.isJsxExpression(child)) return false;
  if (child.expression == null) return true;
  const value = unwrap(child.expression);
  return ts.isStringLiteralLike(value) && value.text.trim() === '';
}

/**
 * Whether the element ends in a `<SrHint>`, the same rule as `ownHint` at run
 * time: the hint, or a `{c && <SrHint>}` / conditional that yields one, is the
 * last child that isn't blank. A screen reader reads the children in order, so
 * a hint with anything visible after it is read before that text and does not
 * count.
 */
function endsInHint(children: readonly ts.JsxChild[]): boolean {
  const last = children.filter((child) => !isBlank(child)).at(-1);
  if (last == null) return false;
  if (isHintElement(last)) return true;
  return (
    ts.isJsxExpression(last) &&
    last.expression != null &&
    yields(last.expression) === 'hint'
  );
}

/** The element's only content is its own title text (nothing to explain). */
function showsItsTitle(
  title: ts.JsxAttribute,
  children: readonly ts.JsxChild[],
): boolean {
  const literal = literalText(title);
  if (literal == null) return false;
  const shown = children.filter((child) => !isBlank(child));
  const [only] = shown;
  return (
    shown.length === 1 &&
    only != null &&
    ts.isJsxText(only) &&
    squashText(only.text) === squashText(literal)
  );
}

/**
 * Every plain element in `source` that explains itself only in a mouse-hover
 * `title`: a generic element (`span`, `div`, `p`, ... see GENERIC_TAGS) with a
 * `title` and no `<SrHint>` as its last child, and a `<StatusBadge>` with a
 * `title` and no `srHint`. A `title` shows on mouse hover only, so a screen
 * reader or a keyboard user never meets the explanation. The fix is a
 * `<SrHint>` as the element's last child (src/components/ui/SrHint.tsx), or,
 * for a glyph with no words, a `role="img"` and an `aria-label`.
 *
 * It does not flag an element that:
 * - has a role that can carry a name, or one the scan can't read
 *   (`role={r}`); an empty or presentational role (`none`, `presentation`)
 *   does not count as a role, see `countsAsNoRole`;
 * - has a spread attribute (`{...props}` may carry a role or a hint);
 * - has an empty or blank string-literal title, which shows nothing;
 * - is a string-literal title that equals the element's only child text, so
 *   the title says nothing the text does not.
 *
 * What it does not see, on purpose: a `title` on an element that has its own
 * role (`<button>`, `<a>`, `<td>`, `<label>`, ...) and on any component other
 * than `StatusBadge`, and a hint that a component adds from inside.
 *
 * Each hit carries the line of the `title` attribute, the tag, and the title
 * initializer's source text with its whitespace collapsed (so a hit keeps its
 * key when the line moves). The source is parsed as TSX, so comments, strings
 * and JSX text never match.
 */
export function findTitleOnlyGenerics(
  fileName: string,
  source: string,
): TitleOnlyGeneric[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  const found: TitleOnlyGeneric[] = [];

  const check = (
    opening: ts.JsxOpeningLikeElement,
    children: readonly ts.JsxChild[],
  ) => {
    const { tagName } = opening;
    if (!ts.isIdentifier(tagName)) return;
    const isBadge = tagName.text === HINT_PROP_COMPONENT;
    if (!isBadge && !GENERIC.has(tagName.text)) return;
    const { properties } = opening.attributes;
    if (properties.some((p) => ts.isJsxSpreadAttribute(p))) return;

    const attrs = properties.filter(ts.isJsxAttribute);
    const named = (name: string) =>
      attrs.find((a) => a.name.getText(file) === name);
    const title = named('title');
    if (title == null) return;
    const literal = literalText(title);
    if (literal != null && literal.trim() === '') return;

    if (isBadge) {
      if (named('srHint') != null) return;
    } else {
      const role = named('role');
      if (role != null) {
        const roleText = literalText(role);
        if (roleText == null || !countsAsNoRole(roleText)) return;
      }
      if (endsInHint(children) || showsItsTitle(title, children)) return;
    }

    const { line } = file.getLineAndCharacterOfPosition(title.getStart(file));
    found.push({
      line: line + 1,
      tag: tagName.text,
      title: squashText(title.initializer?.getText(file)),
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) check(node.openingElement, node.children);
    else if (ts.isJsxSelfClosingElement(node)) check(node, []);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** One hit in the app tree: a {@link TitleOnlyGeneric} with its file. */
export interface TitleOnlyHit extends TitleOnlyGeneric {
  /** The file, from the repo root (`src/components/...`). */
  file: string;
}

/**
 * A titled element the owner decided to leave without a hint, with the
 * reason. Keyed by the file and the title's source text, not the line, so a
 * line move doesn't break it. An entry covers one element: two elements in a
 * file with the same title text take two entries.
 */
export interface TitleExemption {
  file: string;
  title: string;
  reason: string;
}

export interface ExemptionResult {
  /** Hits no exemption covers, including a repeat the entries don't count. */
  unexpected: TitleOnlyHit[];
  /** Exemptions no hit used: the element was fixed, renamed or removed. */
  stale: TitleExemption[];
}

/**
 * Sets `hits` against `exemptions`. Each hit uses up one entry with its file
 * and title text, and a hit with none left is unexpected. An entry no hit used
 * is stale, so a fixed or removed element can't leave a dead exemption behind.
 */
export function applyExemptions(
  hits: readonly TitleOnlyHit[],
  exemptions: readonly TitleExemption[],
): ExemptionResult {
  const unused = [...exemptions];
  const unexpected: TitleOnlyHit[] = [];
  for (const hit of hits) {
    const at = unused.findIndex(
      (e) => e.file === hit.file && e.title === hit.title,
    );
    if (at === -1) unexpected.push(hit);
    else unused.splice(at, 1);
  }
  return { unexpected, stale: unused };
}
