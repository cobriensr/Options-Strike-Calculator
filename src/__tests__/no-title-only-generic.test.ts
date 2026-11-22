/**
 * Guard: no plain element in src/ explains itself only in a `title`.
 *
 * A `title` shows on mouse hover. A screen reader or a keyboard user never
 * meets it, so a badge, chip or cell whose explanation lives only there leaves
 * those users without it. The explanation also goes in a visually hidden
 * `<SrHint>` as the element's last child (src/components/ui/SrHint.tsx), and
 * the `title` stays for the mouse. A glyph-only element (`↑↑`, `★★★★`) gets
 * `role="img"` and an `aria-label` instead. The panels were cleaned up in the
 * title-only-hints work (docs/superpowers/specs/2026-11-21-title-only-hints.md);
 * this keeps a hover-only explanation from coming back. It is the source-level
 * twin of the runtime helper `titledGenericsWithoutHint` (helpers/aria.ts) and
 * of `no-generic-aria-name.test.ts`, and reads the same tag list and role rule.
 *
 * What it scans: every .tsx file under src/ outside `__tests__` folders and
 * colocated test files, parsed with the TypeScript compiler. The rule and its
 * limits are on `findTitleOnlyGenerics` (helpers/title-hint-scan.ts).
 *
 * The owner's exemptions are listed below with their reasons.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { appSourceFiles } from './helpers/app-source-files';
import { GENERIC_TAGS } from './helpers/aria';
import {
  applyExemptions,
  findTitleOnlyGenerics,
  type TitleExemption,
  type TitleOnlyHit,
} from './helpers/title-hint-scan';

const scan = (source: string) => findTitleOnlyGenerics('fixture.tsx', source);

describe('findTitleOnlyGenerics', () => {
  it.each([
    ['a span with a string title', '<span title="x">a</span>', 'span', '"x"'],
    [
      'a div with an expression title',
      '<div title={t}>{v}</div>',
      'div',
      '{t}',
    ],
    [
      'a span with an empty role (a browser ignores it)',
      '<span title="x" role="">a</span>',
      'span',
      '"x"',
    ],
    [
      'a span with role="none"',
      '<span title="x" role="none">a</span>',
      'span',
      '"x"',
    ],
    [
      'a span with role="presentation"',
      '<span title="x" role="presentation">a</span>',
      'span',
      '"x"',
    ],
    [
      'a self-closing span',
      '<span title="x" className="bar" />',
      'span',
      '"x"',
    ],
    [
      'a title held in a template literal',
      '<b title={`${n} open`}>a</b>',
      'b',
      '{`${n} open`}',
    ],
    [
      'a StatusBadge with a title and no srHint',
      '<StatusBadge label="A" title="x" />',
      'StatusBadge',
      '"x"',
    ],
    [
      'a StatusBadge whose title is an expression',
      '<StatusBadge label="A" title={t} />',
      'StatusBadge',
      '{t}',
    ],
    [
      'a span nested in a component child',
      '<Card><span title="x">a</span></Card>',
      'span',
      '"x"',
    ],
    [
      'a span in a conditional expression',
      '<div>{ok && <span title="x">a</span>}</div>',
      'span',
      '"x"',
    ],
    [
      'a span passed as a prop value',
      '<Row icon={<span title="x">a</span>} />',
      'span',
      '"x"',
    ],
    [
      'a title that differs from the text it sits on',
      '<span title="abc">ab</span>',
      'span',
      '"abc"',
    ],
    [
      'a title that merely sits in a longer text (not its only child)',
      '<span title="ab">ab<b>c</b></span>',
      'span',
      '"ab"',
    ],
    // The hint has to be the last child: a screen reader reads the children in
    // order, so one with anything visible after it is read before that text.
    [
      'a hint with an element after it',
      '<span title="x">a<SrHint>y</SrHint><b>z</b></span>',
      'span',
      '"x"',
    ],
    [
      'a hint with text after it',
      '<span title="x">a<SrHint>y</SrHint>b</span>',
      'span',
      '"x"',
    ],
    [
      'a hint with an expression after it',
      '<span title="x">a<SrHint>y</SrHint>{n}</span>',
      'span',
      '"x"',
    ],
    [
      'a hint before the label',
      '<span title="x"><SrHint>y</SrHint>a</span>',
      'span',
      '"x"',
    ],
    [
      'a conditional hint with an element after it',
      '<span title="x">a{c && <SrHint>y</SrHint>}<b>z</b></span>',
      'span',
      '"x"',
    ],
    [
      'a hint nested a level down, not a direct child',
      '<span title="x"><b>a<SrHint>y</SrHint></b></span>',
      'span',
      '"x"',
    ],
    [
      'a hint inside a fragment, not a direct child',
      '<span title="x">a<><SrHint>y</SrHint></></span>',
      'span',
      '"x"',
    ],
    [
      'a conditional whose other branch shows something',
      '<span title="x">a{c ? <SrHint>y</SrHint> : <b>z</b>}</span>',
      'span',
      '"x"',
    ],
    [
      'an && whose right side is not a hint',
      '<span title="x">a{c && <b>y</b>}</span>',
      'span',
      '"x"',
    ],
    [
      'a hint in a component that is not SrHint (a known blind spot)',
      '<span title="x">a<Hint>y</Hint></span>',
      'span',
      '"x"',
    ],
    [
      'an ad-hoc sr-only span, which is not a SrHint',
      '<span title="x">a<span className="sr-only">y</span></span>',
      'span',
      '"x"',
    ],
    // An srHint written as nothing is no hint: SrHint would render an empty
    // dash. A dynamic srHint stays accepted (a known blind spot, below).
    [
      'a StatusBadge with an empty srHint',
      '<StatusBadge label="A" title="x" srHint="" />',
      'StatusBadge',
      '"x"',
    ],
    [
      'a StatusBadge with a blank srHint',
      '<StatusBadge label="A" title="x" srHint="  " />',
      'StatusBadge',
      '"x"',
    ],
    [
      'a StatusBadge with an empty string-expression srHint',
      '<StatusBadge label="A" title="x" srHint={\'\'} />',
      'StatusBadge',
      '"x"',
    ],
    [
      'a StatusBadge with a literal undefined srHint',
      '<StatusBadge label="A" title="x" srHint={undefined} />',
      'StatusBadge',
      '"x"',
    ],
    // aria-hidden hides an element only when it is literally true.
    [
      'a span with aria-hidden="false"',
      '<span aria-hidden="false" title="x">a</span>',
      'span',
      '"x"',
    ],
    [
      'a span with aria-hidden={false}',
      '<span aria-hidden={false} title="x">a</span>',
      'span',
      '"x"',
    ],
    [
      'a span whose aria-hidden is a non-literal expression',
      '<span aria-hidden={hidden} title="x">a</span>',
      'span',
      '"x"',
    ],
    [
      'a span inside an ancestor with aria-hidden="false"',
      '<div aria-hidden="false"><span title="x">a</span></div>',
      'span',
      '"x"',
    ],
    [
      'a span inside a component with aria-hidden (a known blind spot)',
      '<Icon aria-hidden="true"><span title="x">a</span></Icon>',
      'span',
      '"x"',
    ],
  ])('flags %s', (_name, source, tag, title) => {
    expect(scan(source)).toEqual([{ line: 1, tag, title }]);
  });

  // The tag list itself is pinned in no-generic-aria-name.test.ts.
  it.each(GENERIC_TAGS)('flags a titled <%s>', (tag) => {
    expect(scan(`<${tag} title="x">a</${tag}>`)).toEqual([
      { line: 1, tag, title: '"x"' },
    ]);
  });

  it.each([
    ['a hint as the last child', '<span title="x">a<SrHint>y</SrHint></span>'],
    [
      'a hint with an interpolated child',
      '<span title="x">a<SrHint>{`${n} open`}</SrHint></span>',
    ],
    [
      'a hint after other child elements',
      '<span title="x">a<b>b</b><SrHint>y</SrHint></span>',
    ],
    [
      'a conditional hint written with &&',
      '<span title="x">a{c && <SrHint>y</SrHint>}</span>',
    ],
    [
      'a conditional hint written with a ternary',
      '<span title="x">a{c ? <SrHint>y</SrHint> : null}</span>',
    ],
    [
      'a ternary that holds the hint in the other branch',
      '<span title="x">a{c ? undefined : <SrHint>y</SrHint>}</span>',
    ],
    [
      'a ternary whose branches are both hints',
      '<span title="x">a{c ? <SrHint>y</SrHint> : <SrHint>z</SrHint>}</span>',
    ],
    [
      'a hint in parentheses',
      '<span title="x">a{c && (<SrHint>y</SrHint>)}</span>',
    ],
    [
      'a chain of conditions before the hint',
      '<span title="x">a{c != null && d && <SrHint>y</SrHint>}</span>',
    ],
    [
      'a hint followed by a comment',
      '<span title="x">a<SrHint>y</SrHint>{/* why */}</span>',
    ],
    [
      'a hint followed by a {" "} string',
      '<span title="x">a<SrHint>y</SrHint>{" "}</span>',
    ],
    [
      'a hint with whitespace and newlines after it',
      '<span title="x">\n  a\n  <SrHint>y</SrHint>\n</span>',
    ],
    [
      'a hint in a multi-line element',
      [
        'const A = () => (',
        '  <span',
        '    title={t}',
        '  >',
        '    {label}',
        '    <SrHint>y</SrHint>',
        '  </span>',
        ');',
      ].join('\n'),
    ],
    [
      'a role="img" glyph',
      '<span role="img" aria-label="x" title="x">↑</span>',
    ],
    [
      'a role as a string-literal expression',
      '<span role={\'img\'} title="x" />',
    ],
    ['a role with a real first token', '<span role="img none" title="x" />'],
    [
      'a non-literal role (a known blind spot, as in the aria-label guard)',
      '<span role={r} title="x">a</span>',
    ],
    ['a button', '<button title="x" />'],
    ['a link', '<a href="/x" title="x">a</a>'],
    ['a table cell', '<td title="x">1</td>'],
    ['a label', '<label title="x">Filter</label>'],
    ['a fieldset', '<fieldset title="x" />'],
    ['an svg', '<svg title="x" />'],
    [
      'a string title equal to the only text child',
      '<span title="ab">ab</span>',
    ],
    [
      'a string-expression title equal to the only text child',
      "<span title={'ab'}>ab</span>",
    ],
    [
      'a title equal to the text, spacing aside',
      '<span title="a  b">\n  a b\n</span>',
    ],
    ['a span with an empty title', '<span title="">a</span>'],
    ['a span with a blank title', '<span title="  ">a</span>'],
    [
      'a span with a literal undefined title',
      '<span title={undefined}>a</span>',
    ],
    // A screen reader skips an aria-hidden element and everything in it, so a
    // hint there would never be read.
    [
      'a span with aria-hidden="true"',
      '<span aria-hidden="true" title="x">a</span>',
    ],
    [
      'a span with aria-hidden={true}',
      '<span aria-hidden={true} title="x">a</span>',
    ],
    [
      'a span with aria-hidden as a string expression',
      '<span aria-hidden={\'true\'} title="x">a</span>',
    ],
    [
      'a span with a bare aria-hidden (React renders "true")',
      '<span aria-hidden title="x">a</span>',
    ],
    [
      'a span with aria-hidden after the title',
      '<span title="x" aria-hidden="true">a</span>',
    ],
    [
      'a self-closing span with aria-hidden',
      '<span aria-hidden="true" title="x" />',
    ],
    [
      'a span inside an aria-hidden div',
      '<div aria-hidden="true"><span title="x">a</span></div>',
    ],
    [
      'a span deep inside an aria-hidden svg, through an expression',
      '<svg aria-hidden="true"><g>{ok && <span title="x">a</span>}</g></svg>',
    ],
    [
      'a StatusBadge inside an aria-hidden div',
      '<div aria-hidden="true"><StatusBadge label="A" title="x" /></div>',
    ],
    ['a span with no title', '<span className="x">a</span>'],
    [
      'a span with a spread, which may carry a role',
      '<span {...p} title="x">a</span>',
    ],
    ['a spread after the title', '<span title="x" {...p}>a</span>'],
    [
      'a StatusBadge with a title and an srHint',
      '<StatusBadge title="x" srHint="y" />',
    ],
    [
      'a StatusBadge with an expression srHint',
      '<StatusBadge label="A" title={t} srHint={h} />',
    ],
    ['a StatusBadge with no title', '<StatusBadge label="A" />'],
    [
      'a StatusBadge with a spread, which may carry an srHint',
      '<StatusBadge {...p} title="x" />',
    ],
    [
      'a component other than StatusBadge (a known blind spot)',
      '<Badge title="x" />',
    ],
    [
      'a component whose name matches a generic tag but for case',
      '<Span title="x">a</Span>',
    ],
    ['a member-expression tag', '<motion.span title="x">a</motion.span>'],
    [
      'a title in a comment',
      '// <span title="x">a</span>\n/* <div title="x" /> */\nconst a = 1;',
    ],
    ['a title in a string', 'const html = \'<span title="x">a</span>\';'],
    ['a title in JSX text', '<p>set title="x" on it</p>'],
    ['source with no JSX', 'export const n = 1;'],
    ['an empty file', ''],
  ])('ignores %s', (_name, source) => {
    expect(scan(source)).toEqual([]);
  });

  it('reports the line of the title attribute, not of the tag', () => {
    const source = [
      'const A = () => (', // 1
      '  <div>', // 2
      '    <span', // 3
      '      className="x"', // 4
      '      title="y"', // 5
      '    >', // 6
      '      a', // 7
      '    </span>', // 8
      '    <p title="z">t</p>', // 9
      '  </div>', // 10
      ');', // 11
    ].join('\n');
    expect(scan(source)).toEqual([
      { line: 5, tag: 'span', title: '"y"' },
      { line: 9, tag: 'p', title: '"z"' },
    ]);
  });

  it('collapses the whitespace of a multi-line title', () => {
    const source = [
      '<span',
      '  title={',
      '    ok',
      "      ? 'a'",
      "      : 'b'",
      '  }',
      '>',
      '  x',
      '</span>',
    ].join('\n');
    expect(scan(source)).toEqual([
      { line: 2, tag: 'span', title: "{ ok ? 'a' : 'b' }" },
    ]);
  });

  it('keeps a flagged element beside one that is fine', () => {
    const source = [
      'const A = () => (',
      '  <>',
      '    <span title="ok">a<SrHint>y</SrHint></span>',
      '    <span title="bad">x</span>',
      '    <button title="fine" />',
      '  </>',
      ');',
    ].join('\n');
    expect(scan(source)).toEqual([{ line: 4, tag: 'span', title: '"bad"' }]);
  });

  it('hides only the aria-hidden element and what is inside it, not its siblings', () => {
    const source = [
      '<>',
      '  <div aria-hidden="true"><span title="in">a</span></div>',
      '  <span title="after">b</span>',
      '</>',
    ].join('\n');
    expect(scan(source)).toEqual([{ line: 3, tag: 'span', title: '"after"' }]);
  });

  it('flags both an outer and an inner element that lack a hint', () => {
    const source = '<span title="a">x<span title="b">y</span></span>';
    expect(scan(source)).toEqual([
      { line: 1, tag: 'span', title: '"a"' },
      { line: 1, tag: 'span', title: '"b"' },
    ]);
  });
});

const hit = (
  file: string,
  title: string,
  line = 1,
  tag = 'span',
): TitleOnlyHit => ({ file, title, line, tag });

const exemption = (file: string, title: string): TitleExemption => ({
  file,
  title,
  reason: 'a reason',
});

describe('applyExemptions', () => {
  it('passes a hit that an exemption covers', () => {
    expect(
      applyExemptions(
        [hit('src/A.tsx', '"x"')],
        [exemption('src/A.tsx', '"x"')],
      ),
    ).toEqual({ unexpected: [], stale: [] });
  });

  it('reports a hit that no exemption covers', () => {
    const h = hit('src/A.tsx', '"x"', 7);
    expect(applyExemptions([h], [])).toEqual({ unexpected: [h], stale: [] });
  });

  it('keys by file and title: the same title in another file is not covered', () => {
    const elsewhere = hit('src/B.tsx', '"x"');
    const e = exemption('src/A.tsx', '"x"');
    expect(applyExemptions([elsewhere], [e])).toEqual({
      unexpected: [elsewhere],
      stale: [e],
    });
  });

  it('keys by file and title: another title in the same file is not covered', () => {
    const other = hit('src/A.tsx', '"y"');
    const e = exemption('src/A.tsx', '"x"');
    expect(applyExemptions([other], [e])).toEqual({
      unexpected: [other],
      stale: [e],
    });
  });

  it('keeps matching when the line moves', () => {
    expect(
      applyExemptions(
        [hit('src/A.tsx', '"x"', 900)],
        [exemption('src/A.tsx', '"x"')],
      ),
    ).toEqual({ unexpected: [], stale: [] });
  });

  it('reports an exemption that matches nothing as stale', () => {
    const e = exemption('src/A.tsx', '"x"');
    expect(applyExemptions([], [e])).toEqual({ unexpected: [], stale: [e] });
  });

  it('reports the exemption that no hit used, not the one that did', () => {
    const used = exemption('src/A.tsx', '"x"');
    const dead = exemption('src/A.tsx', '"y"');
    expect(applyExemptions([hit('src/A.tsx', '"x"')], [used, dead])).toEqual({
      unexpected: [],
      stale: [dead],
    });
  });

  it('takes one entry per element when two share a file and title', () => {
    const hits = [hit('src/A.tsx', '"x"', 3), hit('src/A.tsx', '"x"', 9)];
    const e = exemption('src/A.tsx', '"x"');
    expect(applyExemptions(hits, [e, e])).toEqual({
      unexpected: [],
      stale: [],
    });
  });

  it('reports a second element that shares the title of a one-entry exemption', () => {
    const second = hit('src/A.tsx', '"x"', 20);
    expect(
      applyExemptions(
        [hit('src/A.tsx', '"x"', 3), second],
        [exemption('src/A.tsx', '"x"')],
      ),
    ).toEqual({ unexpected: [second], stale: [] });
  });
});

const CHIP_IN_TOGGLE =
  'A chip inside the ticker-group toggle button, whose hidden text joins the ' +
  "button's accessible name. Its visible text already explains it (the " +
  'count, strikes, premium, last-hit time or best peak), so it keeps only a ' +
  'title. LotteryFinderTickerGroup.test.tsx and SilentBoomTickerGroup.test.tsx ' +
  "pin that set ('keeps a hint on exactly the chips whose visible text is " +
  "cryptic') and the cap on the button's name.";
const EXPIRY_CHIP =
  'The expiry chip inside the contract link. Its text already shows the ' +
  'expiry and the DTE, so a hint would only repeat it. LotteryRow.test.tsx ' +
  'and SilentBoomRow.test.tsx pin it as the one titled chip without a hint ' +
  '(`expiryChip`).';

/**
 * The owner's exemptions: titled plain elements that stay without a hint, each
 * with the reason. Keyed by file and title text, so a line move doesn't break
 * an entry. `title` is the title initializer's source text, whitespace
 * collapsed, exactly as `findTitleOnlyGenerics` reports it. The guard fails on
 * an entry that no longer matches an element.
 */
const EXEMPTIONS: TitleExemption[] = [
  // Lottery Finder ticker-group header: count, strikes, premium, last hit and
  // best peak (the "best peak" label and its value each carry a title).
  {
    file: 'src/components/LotteryFinder/LotteryFinderTickerGroup.tsx',
    title: `"Number of distinct (chain × day) triggers for this ticker today. The feed collapses repeat fires on the same chain to the most recent row, so this count is unique chains, not raw alert hits."`,
    reason: CHIP_IN_TOGGLE,
  },
  {
    file: 'src/components/LotteryFinder/LotteryFinderTickerGroup.tsx',
    title: `"Distinct (strike, side) pairs hit by alerts in this group. Up to 3 shown then '+N more'; the trailing (Npt) is the strike-range spread in points between min and max."`,
    reason: CHIP_IN_TOGGLE,
  },
  {
    file: 'src/components/LotteryFinder/LotteryFinderTickerGroup.tsx',
    title: `"Sum of trigger-window premium across this ticker's fires"`,
    reason: CHIP_IN_TOGGLE,
  },
  {
    file: 'src/components/LotteryFinder/LotteryFinderTickerGroup.tsx',
    title: `"Most recent alert trigger time (CT) for this ticker today."`,
    reason: CHIP_IN_TOGGLE,
  },
  {
    file: 'src/components/LotteryFinder/LotteryFinderTickerGroup.tsx',
    title: `"Best peak return across every alert for this ticker today. Look-ahead reference (not tradeable) — expand the row to see realized exits per the selected policy."`,
    reason: CHIP_IN_TOGGLE,
  },
  {
    file: 'src/components/LotteryFinder/LotteryFinderTickerGroup.tsx',
    title: `"Best peak return across every alert for this ticker today. Look-ahead reference (not tradeable)."`,
    reason: CHIP_IN_TOGGLE,
  },
  // Silent Boom ticker-group header: the same five chips.
  {
    file: 'src/components/SilentBoom/SilentBoomTickerGroup.tsx',
    title: `"Number of distinct (chain × spike-bucket) silent-boom alerts for this ticker today. Each spike bucket counts once per chain even if the same contract spikes again later in the session."`,
    reason: CHIP_IN_TOGGLE,
  },
  {
    file: 'src/components/SilentBoom/SilentBoomTickerGroup.tsx',
    title: `"Distinct (strike, side) pairs hit by alerts in this group. Up to 3 shown then '+N more'; the trailing (Npt) is the strike-range spread in points between min and max."`,
    reason: CHIP_IN_TOGGLE,
  },
  {
    file: 'src/components/SilentBoom/SilentBoomTickerGroup.tsx',
    title: `"Sum of spike-bucket premium across this ticker's alerts"`,
    reason: CHIP_IN_TOGGLE,
  },
  {
    file: 'src/components/SilentBoom/SilentBoomTickerGroup.tsx',
    title: `"Most recent alert spike-bucket time (CT) for this ticker today."`,
    reason: CHIP_IN_TOGGLE,
  },
  {
    file: 'src/components/SilentBoom/SilentBoomTickerGroup.tsx',
    title: `"Best peak return across every alert for this ticker today. Look-ahead reference (not tradeable) — expand the row to see realized exits per the selected policy."`,
    reason: CHIP_IN_TOGGLE,
  },
  {
    file: 'src/components/SilentBoom/SilentBoomTickerGroup.tsx',
    title: `"Best peak return across every alert for this ticker today. Look-ahead reference (not tradeable)."`,
    reason: CHIP_IN_TOGGLE,
  },
  // The expiry chip in a row's contract link.
  {
    file: 'src/components/LotteryFinder/LotteryRow.tsx',
    title: '{dteTooltip}',
    reason: EXPIRY_CHIP,
  },
  {
    file: 'src/components/SilentBoom/SilentBoomRow.tsx',
    title: '{dteTooltip}',
    reason: EXPIRY_CHIP,
  },
  {
    file: 'src/components/GreekFlowPanel/Verdict.tsx',
    title:
      '{`${fmtTime(run.startTs)}–${fmtTime(run.endTs)} — ${KIND_LABEL[run.kind]} (${run.pointCount} min)`}',
    reason:
      'The timeline run bars are children of a role="img" whose aria-label ' +
      'names the whole timeline, so a hint inside one would never be read. An ' +
      "image's children are not read. GreekFlowPanel.test.tsx filters the runs " +
      'out of its hint check by test id.',
  },
  {
    file: 'src/components/Tracker/ContractRow.tsx',
    title: "{contract.notes ?? ''}",
    reason:
      'The title is the notes text the cell shows (truncated), so it says ' +
      'nothing the text does not. The title is an expression, so the literal ' +
      'rule cannot see that.',
  },
];

// The file walk both source guards share. The real tree has no `.tsx` under a
// `__tests__` folder that is not also a `.test.tsx`, so only a fixture tree
// shows what each part of the filter keeps out.
describe('appSourceFiles', () => {
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'app-source-files-'));
    const files = [
      'A.tsx',
      'B.test.tsx',
      'C.spec.tsx',
      'D.ts',
      'sub/E.tsx',
      '__tests__/F.tsx',
      'sub/__tests__/G.tsx',
      'sub/__tests__/deep/H.tsx',
    ];
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), '');
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the app .tsx files and leaves out tests and non-tsx files', () => {
    expect(appSourceFiles(root).sort()).toEqual(['A.tsx', 'sub/E.tsx']);
  });
});

describe('src/ title-only guard', () => {
  const srcDir = resolve(process.cwd(), 'src');
  const files = appSourceFiles(srcDir);
  let hits: TitleOnlyHit[] = [];

  // Reads and parses every app source file with the TypeScript compiler. A
  // whole-tree parse timed out at the default 15 s under machine load in
  // api/__tests__/no-session-set.test.ts, so the scan runs in a hook with a
  // 60 s limit of its own and the tests assert its result.
  beforeAll(() => {
    hits = files.flatMap((file) =>
      findTitleOnlyGenerics(
        file,
        readFileSync(resolve(srcDir, file), 'utf8'),
      ).map((h) => ({ ...h, file: `src/${file}` })),
    );
  }, 60_000);

  it('scans the app tree, not an empty or wrong directory', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('App.tsx');
    expect(files).toContain('components/ui/SrHint.tsx');
    expect(files).toContain('components/LotteryFinder/LotteryRow.tsx');
  });

  // A new exemption is an owner decision, so adding one means editing this
  // count too. A hit that is not on the list is fixed with a <SrHint>.
  it('lists the 16 exemptions the plan allows, each with a reason', () => {
    expect(EXEMPTIONS).toHaveLength(16);
    expect(EXEMPTIONS.filter((e) => e.reason.trim() === '')).toEqual([]);
  });

  it('leaves no plain element explained only in a hover title', () => {
    const { unexpected } = applyExemptions(hits, EXEMPTIONS);
    const lines = unexpected.map(
      (h) => `${h.file}:${h.line} ${h.tag} ${h.title}`,
    );
    expect(
      lines,
      'A title shows on mouse hover only, so a screen reader or a keyboard ' +
        'user never meets it. Add a <SrHint> as the last child of the element ' +
        '(the title stays for the mouse), or, for a glyph with no words, a ' +
        'role="img" and an aria-label. See src/components/ui/SrHint.tsx.',
    ).toEqual([]);
  });

  it('has no exemption that matches nothing', () => {
    const { stale } = applyExemptions(hits, EXEMPTIONS);
    const lines = stale.map((e) => `${e.file} ${e.title}`);
    expect(
      lines,
      'An exemption in EXEMPTIONS matches no titled element, so the element ' +
        'was fixed, renamed or removed. Delete or correct the entry.',
    ).toEqual([]);
  });
});
