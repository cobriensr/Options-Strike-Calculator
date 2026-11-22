import ts from 'typescript';

/**
 * The value of a JSX attribute written as a string literal (`role="x"`,
 * `role={'x'}`, ``role={`x`}``), or null for anything else: no value, or an
 * expression the scan can't read (`role={r}`). Shared by the two source scans,
 * `generic-aria-scan.ts` and `title-hint-scan.ts`.
 *
 * It lives in a file of its own, not in `aria.ts`, because it needs the
 * TypeScript compiler at run time. Some 55 jsdom component tests import
 * `aria.ts`, and each would pay about 200 ms to load the compiler for nothing.
 */
export function literalText(attr: ts.JsxAttribute): string | null {
  const init = attr.initializer;
  if (init == null) return null;
  const value = ts.isJsxExpression(init) ? init.expression : init;
  return value != null && ts.isStringLiteralLike(value) ? value.text : null;
}
