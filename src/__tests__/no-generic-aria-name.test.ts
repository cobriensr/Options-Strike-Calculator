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
import {
  GENERIC_TAGS,
  genericElementsWithAriaLabel,
  srHintText,
  titledElementsNeedingHint,
  titledElementsWithoutHint,
  titledGenericsWithoutHint,
} from './helpers/aria';
import { appSourceFiles } from './helpers/app-source-files';
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

const rootWith = (html: string): HTMLElement => {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
};

describe('titledElementsNeedingHint', () => {
  // A title is mouse-only. An element is exempt only when a real role names
  // it, the same rule genericElementsWithAriaLabel uses.
  it.each([
    ['a span with no role', '<span title="Explains it">E1</span>'],
    [
      'a span with an empty role',
      '<span role="" title="Explains it">E1</span>',
    ],
    [
      'a span with a whitespace-only role',
      '<span role="  " title="Explains it">E1</span>',
    ],
    [
      'a span with role="none"',
      '<span role="none" title="Explains it">E1</span>',
    ],
    [
      'a span with role="presentation"',
      '<span role="presentation" title="Explains it">E1</span>',
    ],
    [
      'a span whose first role token is presentational',
      '<span role=" None img" title="Explains it">E1</span>',
    ],
  ])('needs a hint on %s', (_name, html) => {
    expect(titledElementsNeedingHint(rootWith(html))).toHaveLength(1);
  });

  it.each([
    [
      'a span with a real role',
      '<span role="img" title="Explains it">E1</span>',
    ],
    [
      'a span whose first role token is real',
      '<span role="img none" title="Explains it">E1</span>',
    ],
    ['a button', '<button title="Explains it">E1</button>'],
    ['a link', '<a href="/x" title="Explains it">E1</a>'],
    ['an element that shows its title text', '<span title="E1">E1</span>'],
    ['an element with an empty title', '<span title="  ">E1</span>'],
  ])('does not need a hint on %s', (_name, html) => {
    expect(titledElementsNeedingHint(rootWith(html))).toEqual([]);
  });
});

describe('srHintText', () => {
  const hintOf = (html: string): string | null =>
    srHintText(rootWith(html).firstElementChild as Element);

  it('reads the hint that is the last child, without its dash', () => {
    expect(
      hintOf('<span>E1<span class="sr-only"> — explains it</span></span>'),
    ).toBe('explains it');
  });

  it('reads no hint when another element follows the sr-only span', () => {
    expect(
      hintOf(
        '<span>E1<span class="sr-only"> — explains it</span><span>late</span></span>',
      ),
    ).toBeNull();
  });

  // A screen reader reads an element's content in order. A hint with visible
  // text after it would be read before that text, so it does not count.
  it('reads no hint when visible text follows the sr-only span', () => {
    expect(
      hintOf('<span title="x">a<span class="sr-only"> — x</span>b</span>'),
    ).toBeNull();
    expect(
      hintOf('<span><span class="sr-only"> — explains it</span>E1</span>'),
    ).toBeNull();
  });

  it('reads the hint when only whitespace follows it', () => {
    expect(
      hintOf(
        '<span>E1<span class="sr-only"> — explains it</span>  \n\t </span>',
      ),
    ).toBe('explains it');
  });

  // A comment node shows nothing and is read as nothing, like whitespace.
  it('reads the hint when only a comment node follows it', () => {
    expect(
      hintOf(
        '<span>E1<span class="sr-only"> — explains it</span><!-- note --></span>',
      ),
    ).toBe('explains it');
    expect(
      hintOf(
        '<span>E1<span class="sr-only"> — explains it</span> <!-- a --> <!-- b --></span>',
      ),
    ).toBe('explains it');
  });

  it('reads no hint from an element with none, or one nested a level down', () => {
    expect(hintOf('<span>E1</span>')).toBeNull();
    expect(
      hintOf(
        '<span><span>E1<span class="sr-only"> — nested</span></span></span>',
      ),
    ).toBeNull();
  });
});

describe('titledGenericsWithoutHint', () => {
  it('reports a titled span with no hint', () => {
    const root = rootWith('<span title="Explains it">E1</span>');
    expect(titledGenericsWithoutHint(root)).toEqual([
      '<span title="Explains it">E1</span>',
    ]);
  });

  it('reports a titled span with role="none"', () => {
    const root = rootWith('<span role="none" title="Explains it">E1</span>');
    expect(titledGenericsWithoutHint(root)).toEqual([
      '<span role="none" title="Explains it">E1</span>',
    ]);
  });

  it.each(GENERIC_TAGS)('reports a titled <%s> with no hint', (tag) => {
    const root = document.createElement('div');
    const el = document.createElement(tag);
    el.setAttribute('title', 'Explains it');
    el.textContent = 'E1';
    root.appendChild(el);
    expect(titledGenericsWithoutHint(root)).toHaveLength(1);
  });

  it('does not report a titled span with a hint as a direct child', () => {
    const root = rootWith(
      '<span title="Explains it">E1<span class="sr-only"> — explains it</span></span>',
    );
    expect(titledGenericsWithoutHint(root)).toEqual([]);
  });

  it('reports a titled span whose hint is nested one level down', () => {
    const root = rootWith(
      '<span title="Explains it"><span>E1<span class="sr-only"> — Explains it</span></span></span>',
    );
    expect(titledGenericsWithoutHint(root)).toHaveLength(1);
    expect(titledElementsWithoutHint(root)).toHaveLength(1);
  });

  // SrHint is the LAST direct child, so an element added after it is a defect
  // the guard has to see (the hint would no longer read last). The hint says
  // what the title says, which is how most hints here read. A hint that no
  // longer comes last must not count as visible text either, or the element
  // would look like it shows its own title and slip past.
  it.each([
    [
      'a span',
      '<span title="Explains it">E1<span class="sr-only"> — Explains it</span><span>late</span></span>',
    ],
    [
      'several elements',
      '<span title="Explains it">E1<span class="sr-only"> — Explains it</span><b>x</b><i>y</i></span>',
    ],
    [
      'an element between two hints',
      '<span title="Explains it">E1<span class="sr-only"> — Explains it</span><b>x</b><span class="sr-only"> — Explains it</span><i>y</i></span>',
    ],
  ])(
    'reports a hint that repeats the title when it is followed by %s',
    (_name, html) => {
      expect(titledGenericsWithoutHint(rootWith(html))).toHaveLength(1);
      expect(titledElementsWithoutHint(rootWith(html))).toHaveLength(1);
    },
  );

  // The same order rule for text: a hint with visible text behind it is read
  // before that text, so the element has no usable hint. The hint is hidden
  // all the same, so it must not count as shown text either.
  it('reports a hint that is followed by visible text', () => {
    const html = '<span title="x">a<span class="sr-only"> — x</span>b</span>';
    expect(titledGenericsWithoutHint(rootWith(html))).toEqual([html]);
    expect(titledElementsWithoutHint(rootWith(html))).toEqual([html]);
  });

  it('accepts a hint that is followed only by whitespace', () => {
    const html =
      '<span title="x">a<span class="sr-only"> — x</span>\n  \t</span>';
    expect(titledGenericsWithoutHint(rootWith(html))).toEqual([]);
    expect(titledElementsWithoutHint(rootWith(html))).toEqual([]);
  });

  it('accepts a hint that comes last after other child elements', () => {
    const root = rootWith(
      '<span title="Explains it">E1<b>x</b><span class="sr-only"> — a</span></span>',
    );
    expect(titledGenericsWithoutHint(root)).toEqual([]);
  });

  it('accepts a last-child hint that repeats the title', () => {
    const html =
      '<span title="Explains it">E1<b>x</b><span class="sr-only"> — Explains it</span></span>';
    expect(titledGenericsWithoutHint(rootWith(html))).toEqual([]);
    expect(titledElementsWithoutHint(rootWith(html))).toEqual([]);
  });

  it('does not report a titled label or a titled td', () => {
    const root = rootWith(
      '<label title="Explains it">Filter</label>' +
        '<table><tbody><tr><td title="Explains it">12</td></tr></tbody></table>',
    );
    // The all-tags check sees both, so only the generic filter spares them.
    expect(titledElementsWithoutHint(root)).toHaveLength(2);
    expect(titledGenericsWithoutHint(root)).toEqual([]);
  });

  it('does not report a titled span with a real role', () => {
    const root = rootWith('<span role="img" title="Explains it">E1</span>');
    expect(titledGenericsWithoutHint(root)).toEqual([]);
  });

  it('does not report a span that already shows its title text', () => {
    const root = rootWith('<span title="E1">E1</span>');
    expect(titledGenericsWithoutHint(root)).toEqual([]);
  });

  it('reports a generic beside a label and leaves the label out', () => {
    const root = rootWith(
      '<label title="Explains it">Filter</label>' +
        '<span title="Also explains">E1</span>',
    );
    expect(titledGenericsWithoutHint(root)).toEqual([
      '<span title="Also explains">E1</span>',
    ]);
  });
});

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
