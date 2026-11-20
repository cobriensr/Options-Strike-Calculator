/**
 * dom-accessibility-api 0.5 ships its typings (`dist/index.d.ts`) but its
 * `exports` map has no `types` condition, so TypeScript's bundler resolution
 * can't find them and types the import as `any`. This declares the one
 * function the tests use, with the signature from the package.
 *
 * Testing Library's role queries and jest-dom's `toHaveAccessibleName` use
 * the same W3C accessible-name computation. The tests call it directly where
 * they need the name as a string, to bound its length.
 */
declare module 'dom-accessibility-api' {
  export function computeAccessibleName(
    root: Element,
    options?: { hidden?: boolean },
  ): string;
}
