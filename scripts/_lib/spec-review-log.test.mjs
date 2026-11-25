// @vitest-environment node

/**
 * Tests for the review-log reader behind the spec review gate's pre-commit
 * check (scripts/spec-review-check.mjs): parsing the log, keying a doc path,
 * deciding which docs have no review on record, and the block messages. All
 * pure, no spawn; the CLI's own tests are spec-review-check.cli.test.mjs.
 * Design: docs/superpowers/specs/2026-11-21-spec-review-gate-design.md,
 * "The pre-commit backstop".
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blockMessage,
  docKey,
  logPathFor,
  missingLogMessage,
  parseLog,
  unreviewed,
} from './spec-review-log.mjs';

/** One log line: epoch, event, session, agent, key, path, tab-separated. */
function line(epoch, event, session, agent, key, docPath = '-') {
  return [epoch, event, session, agent, key, docPath].join('\t');
}

/** A log event as parseLog returns it. */
function event(name, agent, key) {
  return { epoch: 100, event: name, session: 's1', agent, key, path: '-' };
}

const SPEC = 'docs/superpowers/specs/a.md';
const PLAN = 'docs/superpowers/plans/b.md';

describe('parseLog', () => {
  it('reads the six fields of each line', () => {
    const text = [
      line(1700000000, 'write', 's1', '-', 'specs/a.md', 'F:/x/a.md'),
      line(1700000050, 'start', 's1', 'agent-1', 'specs/a.md'),
    ].join('\n');

    expect(parseLog(text)).toEqual([
      {
        epoch: 1700000000,
        event: 'write',
        session: 's1',
        agent: '-',
        key: 'specs/a.md',
        path: 'F:/x/a.md',
      },
      {
        epoch: 1700000050,
        event: 'start',
        session: 's1',
        agent: 'agent-1',
        key: 'specs/a.md',
        path: '-',
      },
    ]);
  });

  it('reads CRLF lines, leaving no carriage return in the path field', () => {
    const text = `${line(1, 'write', 's1', '-', 'specs/a.md', 'F:/x/a.md')}\r\n${line(2, 'done', 's1', 'agent-1', '-', '-')}\r\n`;

    const events = parseLog(text);

    expect(events.map((e) => e.event)).toEqual(['write', 'done']);
    expect(events.map((e) => e.path)).toEqual(['F:/x/a.md', '-']);
  });

  it('reads a last line with no final newline', () => {
    expect(parseLog(line(1, 'waive', 's1', '-', 'specs/a.md'))).toHaveLength(1);
  });

  it('skips a line with five fields', () => {
    const text = ['1', 'start', 's1', 'agent-1', 'specs/a.md'].join('\t');

    expect(parseLog(text)).toEqual([]);
  });

  it('skips a line with seven fields', () => {
    const text = `${line(1, 'start', 's1', 'agent-1', 'specs/a.md')}\textra`;

    expect(parseLog(text)).toEqual([]);
  });

  it.each(['abc', '', '1.5', '-1', '12x'])(
    'skips a line whose epoch is %j',
    (epoch) => {
      expect(
        parseLog(line(epoch, 'start', 's1', 'agent-1', 'specs/a.md')),
      ).toEqual([]);
    },
  );

  it('skips blank lines and keeps the good lines around a bad one', () => {
    const text = [
      line(1, 'start', 's1', 'agent-1', 'specs/a.md'),
      '',
      'garbage with no tabs',
      line(2, 'done', 's1', 'agent-1', '-'),
    ].join('\n');

    expect(parseLog(text).map((e) => e.event)).toEqual(['start', 'done']);
  });

  it('keeps any event name', () => {
    const names = ['block', 'release', 'ask', 'announced', 'write', 'new'];
    const text = names
      .map((name) => line(1, name, 's1', '-', 'specs/a.md'))
      .join('\n');

    expect(parseLog(text).map((e) => e.event)).toEqual(names);
  });

  it('returns nothing for an empty log', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('docKey', () => {
  it.each([
    [
      'a Windows path, upper-cased',
      String.raw`F:\x\docs\superpowers\specs\A.md`,
      'specs/a.md',
    ],
    [
      'a JSON-escaped Windows path',
      String.raw`F:\\x\\docs\\superpowers\\specs\\A.md`,
      'specs/a.md',
    ],
    ['a repo-relative plan', 'docs/superpowers/plans/b.md', 'plans/b.md'],
    ['an MSYS path', '/f/x/docs/superpowers/specs/a.md', 'specs/a.md'],
    [
      'a name run into the folder before it',
      'xdocs/superpowers/specs/a.md',
      'specs/a.md',
    ],
    [
      'an upper-case folder and extension',
      String.raw`Docs\Superpowers\Specs\X.MD`,
      'specs/x.md',
    ],
    [
      'dots, dashes and underscores in the name',
      'docs/superpowers/specs/v1.2_x-y.md',
      'specs/v1.2_x-y.md',
    ],
    [
      'a sentence period after the name',
      'docs/superpowers/specs/a.md.',
      'specs/a.md',
    ],
    [
      'the first valid name, past a name that is not one',
      'docs/superpowers/specs/a.bak, docs/superpowers/plans/b.md',
      'plans/b.md',
    ],
  ])('keys %s', (_label, input, key) => {
    expect(docKey(input)).toBe(key);
  });

  it.each([
    ['a folder the rule does not name', 'src/a.md'],
    ['another folder under docs', 'docs/tmp/a.md'],
    ['an extension that only starts with .md', 'docs/superpowers/specs/a.mdx'],
    ['a name that goes on past .md', 'docs/superpowers/specs/a.md.bak'],
    ['a name that is only the extension', 'docs/superpowers/specs/.md'],
    ['a space in the name', 'docs/superpowers/specs/my spec.md'],
    ['a subfolder', 'docs/superpowers/specs/sub/a.md'],
    ['a folder with no doc after it', 'docs/superpowers/specs/'],
    ['an empty string', ''],
  ])('gives null for %s', (_label, input) => {
    expect(docKey(input)).toBeNull();
  });
});

describe('unreviewed', () => {
  it.each([
    [
      'a start and a done for one agent',
      [event('start', 'a1', 'specs/a.md'), event('done', 'a1', '-')],
      [],
    ],
    [
      'a done logged before its start',
      [event('done', 'a1', '-'), event('start', 'a1', 'specs/a.md')],
      [],
    ],
    ['a waive', [event('waive', '-', 'specs/a.md')], []],
    ['a start with no done', [event('start', 'a1', 'specs/a.md')], [SPEC]],
    ['a done with no start', [event('done', 'a1', '-')], [SPEC]],
    [
      'a start and a done for different agents',
      [event('start', 'a1', 'specs/a.md'), event('done', 'a2', '-')],
      [SPEC],
    ],
    ['nothing for the key', [], [SPEC]],
    [
      'a start and a done, and a waive, for other keys only',
      [
        event('start', 'a1', 'specs/other.md'),
        event('done', 'a1', '-'),
        event('waive', '-', 'plans/a.md'),
      ],
      [SPEC],
    ],
    [
      'block, release, ask and announced lines and no start, done or waive',
      [
        event('block', '-', 'specs/a.md'),
        event('block', '-', 'specs/a.md'),
        event('release', '-', 'specs/a.md'),
        event('ask', '-', 'specs/a.md'),
        event('announced', '-', 'specs/a.md'),
        event('write', '-', 'specs/a.md'),
      ],
      [SPEC],
    ],
  ])('with %s in the log', (_label, events, expected) => {
    expect(unreviewed([SPEC], events)).toEqual(expected);
  });

  it('counts a start for the key and a done that carries no key', () => {
    // A brief that names two docs gets one start per key and a single done.
    const events = [
      event('start', 'a1', 'specs/a.md'),
      event('start', 'a1', 'specs/c.md'),
      event('done', 'a1', '-'),
    ];

    expect(unreviewed([SPEC, 'docs/superpowers/specs/c.md'], events)).toEqual(
      [],
    );
  });

  it('keys specs and plans apart', () => {
    const events = [
      event('start', 'a1', 'plans/a.md'),
      event('done', 'a1', '-'),
    ];

    expect(unreviewed([SPEC, 'docs/superpowers/plans/a.md'], events)).toEqual([
      SPEC,
    ]);
  });

  it('returns only the unreviewed paths, in the order given', () => {
    const events = [
      event('start', 'a1', 'plans/b.md'),
      event('done', 'a1', '-'),
    ];
    const third = 'docs/superpowers/specs/c.md';

    expect(unreviewed([SPEC, PLAN, third], events)).toEqual([SPEC, third]);
  });

  it('keys a path the way docKey does, whatever its slashes and case', () => {
    const events = [event('waive', '-', 'specs/a.md')];

    expect(
      unreviewed([String.raw`F:\x\docs\superpowers\specs\A.md`], events),
    ).toEqual([]);
  });

  it('lists a path no key can be made from, which no review or waiver could settle', () => {
    const events = [event('waive', '-', 'specs/my.md')];
    const odd = 'docs/superpowers/specs/my spec.md';

    expect(unreviewed([odd], events)).toEqual([odd]);
  });

  it('returns nothing for no paths', () => {
    expect(unreviewed([], [])).toEqual([]);
  });
});

describe('blockMessage', () => {
  it('names the doc, both fixes and the waiver phrase, word for word', () => {
    expect(blockMessage([SPEC])).toBe(
      [
        'spec-review gate: commit blocked. These new docs have no spec-reviewer run and no waiver on record:',
        `  ${SPEC}`,
        'Run the spec-reviewer on each (CLAUDE.md, Plan First), or ask the owner to type "waive review specs/a.md" at the start of a prompt. Then commit again.',
      ].join('\n'),
    );
  });

  it('lists every doc and puts every key in the one waiver phrase', () => {
    const message = blockMessage([SPEC, PLAN]);

    expect(message).toContain(`\n  ${SPEC}\n  ${PLAN}\n`);
    expect(message).toContain('"waive review specs/a.md plans/b.md"');
  });

  it('leaves out of the phrase a doc that has no key, and says to rename it', () => {
    const odd = 'docs/superpowers/specs/my spec.md';

    const message = blockMessage([odd, SPEC]);

    expect(message).toContain(`  ${odd}\n`);
    expect(message).toContain('"waive review specs/a.md"');
    expect(message).toContain(`No review or waiver can name ${odd}:`);
    expect(message.endsWith('Rename it before the commit.')).toBe(true);
  });

  it('offers no waiver phrase when no doc has a key', () => {
    const odd = 'docs/superpowers/specs/sub/a.md';

    const message = blockMessage([odd]);

    expect(message).not.toContain('waive review');
    expect(message).toContain(
      'Run the spec-reviewer on each (CLAUDE.md, Plan First). Then commit again.',
    );
    expect(message).toContain(`No review or waiver can name ${odd}:`);
  });

  it('adds no rename note when every doc has a key', () => {
    expect(blockMessage([SPEC, PLAN])).not.toContain('Rename it');
  });
});

describe('missingLogMessage', () => {
  it('names the log, then lists the docs and the fixes as blockMessage does', () => {
    const logPath = path.join('repo', '.claude', 'state', 'spec-reviews.tsv');

    expect(missingLogMessage(logPath, [SPEC])).toBe(
      [
        `spec-review gate: commit blocked. There is no review log at ${logPath}, so these new docs have no recorded review:`,
        `  ${SPEC}`,
        'Run the spec-reviewer on each (CLAUDE.md, Plan First), or ask the owner to type "waive review specs/a.md" at the start of a prompt. Then commit again.',
      ].join('\n'),
    );
  });
});

describe('logPathFor', () => {
  const main = path.resolve('some', 'main-checkout');
  const log = path.join(main, '.claude', 'state', 'spec-reviews.tsv');

  it('puts the log beside the repository folder, from a relative .git', () => {
    expect(logPathFor('.git', main)).toBe(log);
  });

  it('finds the main checkout from a worktree, where git gives an absolute common dir', () => {
    const worktree = path.resolve('some', 'main-checkout', '.worktrees', 'wt');

    expect(logPathFor(path.join(main, '.git'), worktree)).toBe(log);
  });

  it('reads a relative common dir against the folder it was asked in', () => {
    const subfolder = path.join(main, 'scripts');

    expect(logPathFor(path.join('..', '.git'), subfolder)).toBe(log);
  });
});
