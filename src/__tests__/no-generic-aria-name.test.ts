/**
 * Guard: no bare `span`, `div`, `p` (or other generic element) in src/ is
 * given a screen-reader name with `aria-label` or `aria-labelledby`.
 *
 * ARIA 1.2 prohibits naming an element whose implicit role is generic,
 * paragraph, emphasis, strong, code, subscript, superscript, deletion,
 * insertion or caption, and screen readers mostly ignore the label, so the
 * text never reaches the user. A badge's explanation belongs in a visually
 * hidden `<SrHint>` inside it (src/components/ui/SrHint.tsx), or the element
 * needs a role (`img`, `group`, ...). The panels were cleaned up in the
 * generic-aria-labels work; this keeps a bare name from coming back.
 *
 * What it scans: every .tsx file under src/ outside `__tests__` folders and
 * colocated test files (a fixture may hold a deliberate `<span aria-label>`),
 * parsed with the TypeScript compiler so comments, strings and JSX text never
 * match. It flags an intrinsic element whose tag is in GENERIC_TAGS
 * (helpers/aria.ts, the list the runtime helper
 * `genericElementsWithAriaLabel` uses too) that carries `aria-label` or
 * `aria-labelledby` and has no role and no spread attribute. An empty or
 * whitespace-only role counts as no role (a browser ignores it), and so does a
 * presentational one (`none` or `presentation`, first token, any case):
 * browsers ignore it when a global ARIA attribute such as `aria-label` is
 * present, so the element is still a named generic.
 *
 * What it does not see, on purpose:
 * - a spread (`<span {...props} aria-label="x" />`), which may carry a role;
 * - a component (`<Badge aria-label="x" />`), which is out of scope;
 * - an `<a>` without `href`, which is generic too;
 * - a `role` given as a non-literal expression (`role={r}`), which counts as
 *   a role even when it resolves to nothing, or to `none`, at run time;
 * - elements that may be named (`section`, `fieldset`, `svg`, `td`, ...).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GENERIC_TAGS, genericElementsWithAriaLabel } from './helpers/aria';
import { findGenericAriaNames } from './helpers/generic-aria-scan';

const scan = (source: string): string[] =>
  findGenericAriaNames('fixture.tsx', source);

// The tags ARIA 1.2 gives a role that prohibits a name. Written out here, not
// read from GENERIC_TAGS, so the per-tag tests below can't shrink with the
// list: adding or removing a tag is a deliberate edit to this test too.
const EXPECTED_TAGS = [
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

describe('GENERIC_TAGS', () => {
  it('holds exactly the tags whose role prohibits a name', () => {
    expect(EXPECTED_TAGS).toHaveLength(17);
    expect([...GENERIC_TAGS].sort()).toEqual([...EXPECTED_TAGS].sort());
  });
});

describe('findGenericAriaNames', () => {
  it.each([
    [
      'a span with aria-label',
      '<span aria-label="x">a</span>',
      ['1: span aria-label'],
    ],
    [
      'a self-closing div with aria-labelledby',
      '<div aria-labelledby="h" />',
      ['1: div aria-labelledby'],
    ],
    ['a p with aria-label', '<p aria-label="x">a</p>', ['1: p aria-label']],
    [
      'a figcaption with aria-label (the caption role prohibits a name)',
      '<figcaption aria-label="x">a</figcaption>',
      ['1: figcaption aria-label'],
    ],
    [
      'an aria-label held in an expression',
      '<span aria-label={`${n} open`}>a</span>',
      ['1: span aria-label'],
    ],
    [
      'an aria-label that may be undefined',
      '<span aria-label={tip ? tip : undefined}>a</span>',
      ['1: span aria-label'],
    ],
    [
      'other attributes around the name',
      '<span className="a" aria-label="x" data-x="1">a</span>',
      ['1: span aria-label'],
    ],
    [
      'a span nested in a component child',
      '<Card><span aria-label="x">a</span></Card>',
      ['1: span aria-label'],
    ],
    [
      'a span in a conditional expression',
      '<div>{ok && <span aria-label="x">a</span>}</div>',
      ['1: span aria-label'],
    ],
    [
      'a span passed as a prop value',
      '<Row icon={<span aria-label="x">a</span>} />',
      ['1: span aria-label'],
    ],
    [
      'a span that holds an element with a role',
      '<span aria-label="x"><span role="img">a</span></span>',
      ['1: span aria-label'],
    ],
    [
      'a div with aria-labelledby that holds other elements',
      '<div aria-labelledby="h"><b>t</b></div>',
      ['1: div aria-labelledby'],
    ],
    [
      'both naming attributes, one entry each in source order',
      '<span aria-labelledby="b" aria-label="a" />',
      ['1: span aria-labelledby', '1: span aria-label'],
    ],
    // A browser ignores a presentational role when a global ARIA attribute
    // such as aria-label is present, so these are still named generics.
    [
      'a span with role="presentation"',
      '<span role="presentation" aria-label="x">a</span>',
      ['1: span aria-label'],
    ],
    [
      'a div with role="none"',
      '<div role="none" aria-labelledby="h" />',
      ['1: div aria-labelledby'],
    ],
    [
      'a presentational role as a string-literal expression',
      '<span role={\'none\'} aria-label="x">a</span>',
      ['1: span aria-label'],
    ],
    [
      'a presentational role as a template literal',
      '<span role={`presentation`} aria-label="x">a</span>',
      ['1: span aria-label'],
    ],
    [
      'a presentational role in any case, with padding',
      '<span role=" None " aria-label="x">a</span>',
      ['1: span aria-label'],
    ],
    [
      'a presentational role first in a fallback list',
      '<span role="presentation img" aria-label="x">a</span>',
      ['1: span aria-label'],
    ],
    // A browser ignores an empty role, so it names a generic just the same.
    [
      'an empty role',
      '<span role="" aria-label="x">a</span>',
      ['1: span aria-label'],
    ],
    [
      'a whitespace-only role',
      '<span role="  " aria-label="x">a</span>',
      ['1: span aria-label'],
    ],
    [
      'an empty role as a string-literal expression',
      '<div role={\'\'} aria-labelledby="h" />',
      ['1: div aria-labelledby'],
    ],
    [
      'a blank role as a template literal',
      '<span role={` `} aria-label="x">a</span>',
      ['1: span aria-label'],
    ],
  ])('flags %s', (_name, source, expected) => {
    expect(scan(source)).toEqual(expected);
  });

  it.each(EXPECTED_TAGS)('flags a bare <%s> with an aria-label', (tag) => {
    expect(scan(`<${tag} aria-label="x" />`)).toEqual([`1: ${tag} aria-label`]);
  });

  it.each([
    [
      'a span with an explicit role',
      '<span role="img" aria-label="x">↑</span>',
    ],
    [
      'a span with a role that is a string-literal expression',
      '<span role={\'img\'} aria-label="x" />',
    ],
    [
      'a span whose first role token is a real role',
      '<span role="img none" aria-label="x" />',
    ],
    ['a real role with padding', '<span role=" img " aria-label="x" />'],
    // A known blind spot, pinned so the header's claim stays true: a
    // non-literal role is trusted even if it resolves to `none` at run time.
    [
      'a span whose role is a non-literal expression (a known blind spot)',
      '<span role={r} aria-label="x" />',
    ],
    ['a button', '<button aria-label="x" />'],
    ['a section', '<section aria-label="x" />'],
    ['a fieldset', '<fieldset aria-label="x" />'],
    ['a table cell', '<td aria-label="x">1</td>'],
    ['an svg chart', '<svg aria-label="x" />'],
    ['a heading', '<h2 aria-label="x">t</h2>'],
    [
      'a spread attribute, which may carry a role',
      '<span {...props} aria-label="x" />',
    ],
    ['a spread attribute after the name', '<span aria-label="x" {...props} />'],
    ['a component', '<Badge aria-label="x" />'],
    [
      'a component whose name matches a generic tag but for case',
      '<Span aria-label="x" />',
    ],
    ['a member-expression tag', '<motion.span aria-label="x" />'],
    ['a span with no name attribute', '<span className="x">a</span>'],
    ['a span with aria-hidden', '<span aria-hidden="true">a</span>'],
    [
      'a span with aria-describedby, which is not a name',
      '<span aria-describedby="d">a</span>',
    ],
    [
      'a span with a title, which is a separate question',
      '<span title="x">a</span>',
    ],
    [
      'an aria-label in a comment',
      '// <span aria-label="x">\n/* <div aria-labelledby="h" /> */\nconst a = 1;',
    ],
    [
      'an aria-label in a string',
      'const html = \'<span aria-label="x">a</span>\';',
    ],
    ['an aria-label in JSX text', '<p>set aria-label="x" on it</p>'],
    // A known blind spot, pinned so the header's claim stays true: a link
    // without an href is generic, but an `<a>` with one is a named link.
    ['an <a> (a known blind spot)', '<a aria-label="x">a</a>'],
    ['source with no JSX', 'export const n = 1;'],
    ['an empty file', ''],
  ])('ignores %s', (_name, source) => {
    expect(scan(source)).toEqual([]);
  });

  it('reports the line of the attribute, not of the tag', () => {
    const source = [
      'const A = () => (', // 1
      '  <div>', // 2
      '    <span', // 3
      '      className="x"', // 4
      '      aria-label="y"', // 5
      '    >', // 6
      '      a', // 7
      '    </span>', // 8
      '    <p aria-labelledby="h">t</p>', // 9
      '  </div>', // 10
      ');', // 11
    ].join('\n');
    expect(scan(source)).toEqual([
      '5: span aria-label',
      '9: p aria-labelledby',
    ]);
  });

  it('reports each of two names on its own line', () => {
    const source = [
      'const A = () => (',
      '  <span',
      '    aria-labelledby="h"',
      '    aria-label="x"',
      '  />',
      ');',
    ].join('\n');
    expect(scan(source)).toEqual([
      '3: span aria-labelledby',
      '4: span aria-label',
    ]);
  });

  it('keeps a flagged element beside one that is fine', () => {
    const source = [
      'const A = () => (',
      '  <>',
      '    <span role="img" aria-label="up">↑</span>',
      '    <span aria-label="bad">x</span>',
      '    <section aria-label="ok" />',
      '  </>',
      ');',
    ].join('\n');
    expect(scan(source)).toEqual(['4: span aria-label']);
  });
});

describe('genericElementsWithAriaLabel', () => {
  // The runtime twin of the source guard: both read GENERIC_TAGS and apply the
  // same role rule.
  it.each(EXPECTED_TAGS)('reports a bare <%s> with an aria-label', (tag) => {
    const root = document.createElement('div');
    const el = document.createElement(tag);
    el.setAttribute('aria-label', 'x');
    root.appendChild(el);
    expect(genericElementsWithAriaLabel(root)).toHaveLength(1);
  });

  it.each([
    ['a div with aria-labelledby', '<div aria-labelledby="h"></div>'],
    [
      'a span with role="presentation"',
      '<span role="presentation" aria-label="x"></span>',
    ],
    ['a div with role="none"', '<div role="none" aria-labelledby="h"></div>'],
    [
      'a presentational role in any case',
      '<p role=" NONE " aria-label="x"></p>',
    ],
    [
      'a presentational role first in a fallback list',
      '<span role="none img" aria-label="x"></span>',
    ],
    ['an empty role', '<span role="" aria-label="x"></span>'],
    ['a whitespace-only role', '<span role="  " aria-label="x"></span>'],
  ])('reports %s', (_name, html) => {
    const root = document.createElement('div');
    root.innerHTML = html;
    expect(genericElementsWithAriaLabel(root)).toHaveLength(1);
  });

  it.each([
    ['a span with a role', '<span role="img" aria-label="x"></span>'],
    [
      'a span whose first role token is a real role',
      '<span role="img none" aria-label="x"></span>',
    ],
    ['a real role with padding', '<span role=" img " aria-label="x"></span>'],
    ['a section', '<section aria-label="y"></section>'],
    [
      'a div named by a heading, with a role',
      '<div role="group" aria-labelledby="h"></div>',
    ],
    ['a presentational span with no name', '<span role="none"></span>'],
  ])('skips %s', (_name, html) => {
    const root = document.createElement('div');
    root.innerHTML = html;
    expect(genericElementsWithAriaLabel(root)).toEqual([]);
  });
});

/**
 * Every .tsx file under src/ that ships in the app, as a forward-slash path
 * from src/: not under a `__tests__` folder, and not a colocated test file.
 */
function appSourceFiles(srcDir: string): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .map((p) => p.replaceAll('\\', '/'))
    .filter(
      (p) =>
        p.endsWith('.tsx') &&
        !/\.(test|spec)\.tsx$/.test(p) &&
        !p.split('/').includes('__tests__'),
    );
}

describe('src/ generic-element name guard', () => {
  const srcDir = resolve(process.cwd(), 'src');
  const files = appSourceFiles(srcDir);

  it('scans the app tree, not an empty or wrong directory', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('App.tsx');
    expect(files).toContain('components/ui/SrHint.tsx');
    expect(files).toContain(
      'components/PeriscopeLottery/PeriscopeLotteryPanel.tsx',
    );
  });

  it('leaves out test folders and colocated test files', () => {
    expect(files.some((f) => f.split('/').includes('__tests__'))).toBe(false);
    expect(files.some((f) => /\.(test|spec)\.tsx$/.test(f))).toBe(false);
    // Both kinds exist on disk, so the filter is what keeps them out.
    const all = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).map(
      (p) => p.replaceAll('\\', '/'),
    );
    expect(all).toContain(
      'components/PeriscopeLottery/PeriscopeLotteryPanel.test.tsx',
    );
    expect(all.some((p) => /(^|\/)__tests__\/.+\.tsx$/.test(p))).toBe(true);
  });

  it('gives no bare span, div or other generic element a screen-reader name', () => {
    const offenders = files.flatMap((file) =>
      findGenericAriaNames(
        file,
        readFileSync(resolve(srcDir, file), 'utf8'),
      ).map((hit) => `src/${file}:${hit}`),
    );
    expect(
      offenders,
      'ARIA 1.2 prohibits naming a generic element, and screen readers mostly ' +
        'ignore the label. Put the text in a visually hidden <SrHint> inside ' +
        'the element, or give the element a role. See ' +
        'src/components/ui/SrHint.tsx.',
    ).toEqual([]);
  });
});
