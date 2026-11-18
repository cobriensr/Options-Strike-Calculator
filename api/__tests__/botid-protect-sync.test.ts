// @vitest-environment node

/**
 * Drift guard for the BotID `protect` list in `src/main.tsx`, both directions.
 *
 * The browser attaches the BotID token only to the paths in that list, and the
 * server rejects a bot only where a handler runs the check. The two have to
 * agree:
 *   - a listed path whose handler never runs the check is dead weight (the
 *     list reads as coverage that the server does not enforce);
 *   - a handler that runs the check but is not listed rejects every guest and
 *     public caller, because their requests carry no token. The owner cookie
 *     skips the check (`checkBot`), so the owner never sees the gap.
 *
 * A handler "runs the bot check" when it imports `checkBot`,
 * `guardOwnerEndpoint` or `guardOwnerOrGuestEndpoint` and calls it (or picks
 * one in a `cond ? guardA : guardB` and calls the result), or calls
 * `withDbReader(` with auth `'owner'` or `'owner-or-guest'`. Both guards wrap
 * `checkBot`, and `withDbReader` runs one of them for every auth but
 * `'public'`. A name that only sits in a comment or a string, is only
 * imported, aliased or used in `typeof`, or is shadowed by a local
 * declaration does not count.
 *
 * The comparison is per path, not per method: one handler file serves all its
 * methods, so a path counts as listed when any entry names it.
 *
 * There is no exemption list. Every path that runs the check needs an entry
 * (CLAUDE.md, "Bot protection"), and an entry for a path only the owner calls
 * does no harm, because `checkBot` skips a valid owner cookie.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

// ── Reading the list ─────────────────────────────────────────

interface ProtectEntry {
  path: string;
  method: string;
}

/**
 * The `{ path, method }` entries inside the `protect: [ ... ]` array, plus the
 * number of `path:` keys there. The two differ when an entry is written in a
 * shape the entry pattern skips, which would otherwise drop it from both
 * directions of the comparison without a sound.
 */
function readProtectEntries(mainSource: string): {
  entries: ProtectEntry[];
  pathKeys: number;
} {
  // The array ends at the first line that starts with `]` (a `[id]` inside an
  // entry never starts a line).
  const block = /protect:\s*\[([\s\S]*?)\n\s*\]/.exec(mainSource)?.[1] ?? '';
  const entries = [
    ...block.matchAll(/\{\s*path:\s*'([^']+)',\s*method:\s*'([A-Z]+)'\s*\}/g),
  ].map(([, path = '', method = '']) => ({ path, method }));
  return { entries, pathKeys: (block.match(/\bpath:/g) ?? []).length };
}

// ── Reading the handlers ─────────────────────────────────────

/** Source with `/* *\/` and `//` comments removed (`://` in a URL stays). */
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|\s)\/\/.*$/gm, '$1');
}

/**
 * Source with the text of every one-line string and template literal emptied.
 * A literal must close on its own line, so a quote or backtick inside a regex
 * literal (api/periscope-chat-list.ts has three backticks in one) can blank
 * at most the rest of its own line, never the code below it.
 */
function blankStrings(code: string): string {
  return code.replaceAll(
    /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`/g,
    (literal) => literal.charAt(0).repeat(2),
  );
}

const GUARD_NAMES = [
  'checkBot',
  'guardOwnerEndpoint',
  'guardOwnerOrGuestEndpoint',
];
const GUARD = `(${GUARD_NAMES.join('|')})`;
/** `guard(` */
const GUARD_CALL = new RegExp(String.raw`\b${GUARD}\s*\(`, 'g');
/**
 * `cond ? guardA : guardB`: the guard is chosen here and called through a
 * variable (api/tracker/contracts.ts).
 */
const GUARD_TERNARY = new RegExp(
  String.raw`\?\s*${GUARD}\s*:\s*${GUARD}\b`,
  'g',
);

/** The guards a source imports by name. A local declaration of the same name does not count. */
function importedGuards(code: string): Set<string> {
  const names = [...code.matchAll(/^import\b[^;{]*\{([^}]*)\}/gm)].flatMap(
    ([, list = '']) => list.split(',').map((name) => name.trim()),
  );
  return new Set(GUARD_NAMES.filter((guard) => names.includes(guard)));
}

/** `withDbReader('<path>', '<label>', '<auth>'`, with the auth mode captured. */
const READER_CALL_WITH_LITERAL_AUTH =
  /^withDbReader\(\s*(['"])[^'"]*\1\s*,\s*(['"])[^'"]*\2\s*,\s*(['"])(?<auth>[^'"]*)\3/;

type BotCheck = 'runs' | 'none' | 'unreadable';

function botCheckOf(source: string): BotCheck {
  const uncommented = stripComments(source);
  const imported = importedGuards(uncommented);
  const code = uncommented.replaceAll(/^import\b[^;]*;/gm, '');
  let viaReader = false;
  for (const call of code.matchAll(/\bwithDbReader\(/g)) {
    const literal = READER_CALL_WITH_LITERAL_AUTH.exec(code.slice(call.index));
    // A computed auth argument cannot be read here: stop rather than guess.
    if (!literal) return 'unreadable';
    if (literal.groups?.auth !== 'public') viaReader = true;
  }
  // An imported guard, called or chosen in a ternary, outside any string.
  const bare = blankStrings(code);
  const viaGuard = [
    ...bare.matchAll(GUARD_CALL),
    ...bare.matchAll(GUARD_TERNARY),
  ].some((match) => match.slice(1).some((name) => imported.has(name)));
  return viaGuard || viaReader ? 'runs' : 'none';
}

/** `api/foo/bar.ts` -> `/api/foo/bar`; `api/foo/index.ts` -> `/api/foo`. */
function routeOf(file: string): string {
  return `/${file.replace(/\.ts$/, '').replace(/\/index$/, '')}`;
}

/** The handler file behind a route, or null when none exists. */
function handlerFileOf(route: string): string | null {
  const stem = route.slice(1);
  return (
    [`${stem}.ts`, `${stem}/index.ts`].find((file) =>
      existsSync(resolve(ROOT, file)),
    ) ?? null
  );
}

/** Every `api/**` handler file (not `_lib`, not tests), as repo-relative paths. */
function listHandlerFiles(dir = 'api'): string[] {
  return readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      if (entry.name === '_lib' || entry.name === '__tests__') return [];
      const child = join(dir, entry.name);
      if (entry.isDirectory()) return listHandlerFiles(child);
      return entry.name.endsWith('.ts') ? [child.replaceAll('\\', '/')] : [];
    },
  );
}

// ── The two directions, over the real tree ───────────────────

function scanTree() {
  const { entries, pathKeys } = readProtectEntries(
    readFileSync(resolve(ROOT, 'src/main.tsx'), 'utf8'),
  );
  const listed = new Set(entries.map((e) => e.path));
  const botCheck = new Map<string, BotCheck>(
    listHandlerFiles().map((file) => [
      routeOf(file),
      botCheckOf(readFileSync(resolve(ROOT, file), 'utf8')),
    ]),
  );
  return { entries, pathKeys, listed, botCheck };
}

describe('botid protect list vs the handlers that run the bot check', () => {
  const { entries, pathKeys, listed, botCheck } = scanTree();

  // Floors under today's counts (about 89 entries, 170 handler files): a
  // reader that finds almost nothing would otherwise pass both directions.
  it('reads a non-empty protect list and handler set', () => {
    expect(entries.length).toBeGreaterThan(80);
    expect(botCheck.size).toBeGreaterThan(100);
  });

  it('reads every protect entry', () => {
    expect(
      entries.length,
      `the reader skipped ${pathKeys - entries.length} of ${pathKeys} entries: each must be written { path: '<route>', method: '<VERB>' }`,
    ).toBe(pathKeys);
  });

  it('reads every withDbReader auth argument as a string literal', () => {
    const unreadable = [...botCheck]
      .filter(([, check]) => check === 'unreadable')
      .map(([route]) => `${route}: withDbReader auth is not a string literal`);
    expect(unreadable).toEqual([]);
  });

  it('lists only paths whose handler runs the bot check', () => {
    const dead = [...listed]
      // An unreadable handler is reported by the test above, not as dead.
      .filter((route) => {
        const check = botCheck.get(route);
        return check !== 'runs' && check !== 'unreadable';
      })
      .map((route) => {
        const file = handlerFileOf(route);
        return file === null
          ? `${route}: listed in src/main.tsx, but there is no handler file`
          : `${route}: listed in src/main.tsx, but ${file} never runs the bot check`;
      });
    expect(dead).toEqual([]);
  });

  it('lists every path whose handler runs the bot check', () => {
    const missing = [...botCheck]
      .filter(([route, check]) => check === 'runs' && !listed.has(route))
      .map(
        ([route]) =>
          `${route}: handler runs the bot check, but src/main.tsx does not list it: add the path to the protect array there`,
      );
    expect(missing).toEqual([]);
  });
});

// ── The reading rules, over small sources ────────────────────

describe('reading a handler source', () => {
  const reader = (auth: string) =>
    `export default withDbReader(\n  '/api/x',\n  'x',\n  ${auth},\n  async () => {},\n);`;
  /** A source that imports `names` from the helpers, then runs `body`. */
  const importing = (names: string, body: string) =>
    `import { ${names} } from '../_lib/api-helpers.js';\n${body}`;

  it.each([
    [
      'a direct checkBot call',
      importing('checkBot', 'await checkBot(req);'),
      'runs',
    ],
    [
      'guardOwnerEndpoint',
      importing(
        'guardOwnerEndpoint',
        'await guardOwnerEndpoint(req, res, done);',
      ),
      'runs',
    ],
    [
      'guardOwnerOrGuestEndpoint',
      importing(
        'guardOwnerOrGuestEndpoint',
        'await guardOwnerOrGuestEndpoint(req, res, done);',
      ),
      'runs',
    ],
    [
      'a guard picked by a ternary, then called',
      importing(
        'guardOwnerEndpoint, guardOwnerOrGuestEndpoint',
        'const guard = isGet ? guardOwnerOrGuestEndpoint : guardOwnerEndpoint;\nawait guard(req, res, done);',
      ),
      'runs',
    ],
    [
      'a guard call below a regex literal that holds backticks',
      importing(
        'checkBot',
        'const fence = /```[a-z]*/g;\nawait checkBot(req);\nconst q = sql`select 1`;',
      ),
      'runs',
    ],
    [
      'a guard after a URL on the same line',
      importing('checkBot', "const u = 'https://x.test'; await checkBot(req);"),
      'runs',
    ],
    ['withDbReader owner', reader("'owner'"), 'runs'],
    ['withDbReader owner-or-guest', reader("'owner-or-guest'"), 'runs'],
    ['withDbReader public', reader("'public'"), 'none'],
    ['withDbReader with a computed auth', reader('AUTH'), 'unreadable'],
    ['no guard at all', 'export default () => {};', 'none'],
    [
      'only an import of the guard',
      importing('checkBot', 'export default () => {};'),
      'none',
    ],
    [
      'only a multi-line import of a guard',
      "import {\n  guardOwnerEndpoint,\n  other,\n} from './a.js';",
      'none',
    ],
    [
      'the guard named in a line comment',
      importing('checkBot', '// calls checkBot(req) later'),
      'none',
    ],
    [
      'the guard named in a block comment',
      importing('guardOwnerEndpoint', '/** Runs guardOwnerEndpoint(req). */'),
      'none',
    ],
    [
      'the guard named in a string literal',
      importing('checkBot', "const note = 'checkBot is skipped for owners';"),
      'none',
    ],
    [
      'a guard call written inside a string literal',
      importing('checkBot', "const hint = 'call checkBot(req) first';"),
      'none',
    ],
    [
      'a guard call written inside a template literal',
      importing('checkBot', 'const hint = `call checkBot(req) first`;'),
      'none',
    ],
    [
      'an alias of the guard that is never called',
      importing('guardOwnerEndpoint', 'const guard = guardOwnerEndpoint;'),
      'none',
    ],
    [
      'typeof the guard',
      importing('guardOwnerEndpoint', 'type G = typeof guardOwnerEndpoint;'),
      'none',
    ],
    [
      'a local checkBot that shadows the guard (no import)',
      'const checkBot = () => ({ isBot: false });\nawait checkBot(req);',
      'none',
    ],
    [
      'a call to a guard that is imported under another name',
      importing('checkBot', 'await guardOwnerEndpoint(req, res, done);'),
      'none',
    ],
  ] as const)('%s -> %s', (_name, source, expected) => {
    expect(botCheckOf(source)).toBe(expected);
  });

  it('flags a computed auth even when another reader is literal', () => {
    expect(botCheckOf(`${reader("'owner'")}\n${reader('AUTH')}`)).toBe(
      'unreadable',
    );
  });

  it.each([
    ['api/alerts.ts', '/api/alerts'],
    ['api/tracker/alerts/[id]/ack.ts', '/api/tracker/alerts/[id]/ack'],
    ['api/foo/index.ts', '/api/foo'],
  ])('maps %s to %s', (file, route) => {
    expect(routeOf(file)).toBe(route);
  });

  const protectSource = (...lines: string[]) =>
    [
      "const other = { path: '/api/not-listed', method: 'GET' };",
      'initBotId({',
      '  protect: [',
      ...lines.map((line) => `    ${line}`),
      '  ],',
      '});',
    ].join('\n');

  it('reads the entries inside the protect array only', () => {
    const source = protectSource(
      "{ path: '/api/a', method: 'GET' },",
      "{ path: '/api/b/[id]', method: 'PATCH' },",
    );
    expect(readProtectEntries(source)).toEqual({
      entries: [
        { path: '/api/a', method: 'GET' },
        { path: '/api/b/[id]', method: 'PATCH' },
      ],
      pathKeys: 2,
    });
  });

  it.each([
    ['double quotes', '{ path: "/api/c", method: "GET" },'],
    ['an extra key', "{ path: '/api/c', method: 'GET', note: 'x' },"],
    ['the keys reversed', "{ method: 'GET', path: '/api/c' },"],
    ['a computed path', "{ path: `/api/${name}`, method: 'GET' },"],
  ])('counts an entry the entry pattern skips (%s)', (_name, entry) => {
    const { entries, pathKeys } = readProtectEntries(
      protectSource("{ path: '/api/a', method: 'GET' },", entry),
    );
    expect(entries).toHaveLength(1);
    expect(pathKeys).toBe(2);
  });
});
