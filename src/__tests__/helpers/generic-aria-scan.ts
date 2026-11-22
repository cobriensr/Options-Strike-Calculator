import ts from 'typescript';
import { GENERIC_TAGS, isPresentationalRole } from './aria';

const GENERIC = new Set<string>(GENERIC_TAGS);
const NAME_ATTRS = new Set(['aria-label', 'aria-labelledby']);

/**
 * The value of a `role` attribute written as a string literal (`role="x"`,
 * `role={'x'}`, ``role={`x`}``), or null for anything else: no value, or an
 * expression the scan can't read (`role={r}`).
 */
function literalRole(attr: ts.JsxAttribute): string | null {
  const init = attr.initializer;
  if (init == null) return null;
  const value = ts.isJsxExpression(init) ? init.expression : init;
  return value != null && ts.isStringLiteralLike(value) ? value.text : null;
}

/**
 * Every intrinsic JSX element in `source` that is a bare generic element (a
 * `span`, `div`, `p`, ... see GENERIC_TAGS) given a screen-reader name, as one
 * `"<line>: <tag> <attr>"` entry per naming attribute, in source order. The
 * line is the attribute's, so a multi-line element points at the offending
 * line, and an element with both `aria-label` and `aria-labelledby` yields two
 * entries.
 *
 * ARIA 1.2 prohibits naming a generic element and screen readers mostly
 * ignore the label; the fix is a visually hidden `<SrHint>` inside the element
 * or a role. An element with a role is not reported, and neither is one with
 * a spread attribute (`{...props}` may carry a role) or a component
 * (`<Badge>`, `<motion.span>`): only a lower-case tag in the list counts.
 * A presentational role (`none`, `presentation`) written as a string literal
 * does not count as a role, because a browser ignores it next to an
 * `aria-label`. A `role` the scan can't read (`role={r}`) counts as one.
 *
 * The source is parsed as TSX, so comments, strings and JSX text never match.
 */
export function findGenericAriaNames(
  fileName: string,
  source: string,
): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];

  const check = (element: ts.JsxOpeningLikeElement) => {
    const { tagName } = element;
    if (!ts.isIdentifier(tagName) || !GENERIC.has(tagName.text)) return;
    const { properties } = element.attributes;
    if (properties.some((p) => ts.isJsxSpreadAttribute(p))) return;

    const attrs = properties.filter(ts.isJsxAttribute);
    const role = attrs.find((a) => a.name.getText(file) === 'role');
    if (role != null) {
      const literal = literalRole(role);
      if (literal == null || !isPresentationalRole(literal)) return;
    }
    for (const attr of attrs) {
      const name = attr.name.getText(file);
      if (!NAME_ATTRS.has(name)) continue;
      const line = file.getLineAndCharacterOfPosition(attr.getStart(file)).line;
      found.push(`${line + 1}: ${tagName.text} ${name}`);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningLikeElement(node)) check(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
