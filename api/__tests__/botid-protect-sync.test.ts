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
 * A handler "runs the bot check" when its source (comments and imports
 * aside) names `checkBot`, `guardOwnerEndpoint` or `guardOwnerOrGuestEndpoint`,
 * or calls `withDbReader(` with auth `'owner'` or `'owner-or-guest'` (the
 * wrapper runs one of those two guards; `'public'` runs none). Only three
 * handlers call `checkBot(` themselves; the rest reach it through the guards.
 *
 * The comparison is per path, not per method: one handler file serves all its
 * methods, so a path counts as listed when any entry names it.
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

/** The `{ path, method }` entries inside the `protect: [ ... ]` array. */
function readProtectEntries(mainSource: string): ProtectEntry[] {
  // The array ends at the first line that starts with `]` (a `[id]` inside an
  // entry never starts a line).
  const block = /protect:\s*\[([\s\S]*?)\n\s*\]/.exec(mainSource)?.[1] ?? '';
  return [
    ...block.matchAll(/\{\s*path:\s*'([^']+)',\s*method:\s*'([A-Z]+)'\s*\}/g),
  ].map(([, path = '', method = '']) => ({ path, method }));
}

// ── Reading the handlers ─────────────────────────────────────

/**
 * Source with `import` statements and `/* *\/` and `//` comments removed
 * (`://` in a URL stays), so a guard that is only imported or only mentioned
 * does not count.
 */
function stripImportsAndComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|\s)\/\/.*$/gm, '$1')
    .replaceAll(/^import\b[^;]*;/gm, '');
}

/**
 * A guard named anywhere outside an `import` statement: a call, or the
 * function picked by a ternary and called as `guard(...)` (api/tracker/
 * contracts.ts does the second).
 */
const GUARD_REFERENCE =
  /\b(?:checkBot|guardOwnerEndpoint|guardOwnerOrGuestEndpoint)\b/;

/** `withDbReader('<path>', '<label>', '<auth>'`, with the auth mode captured. */
const READER_CALL_WITH_LITERAL_AUTH =
  /^withDbReader\(\s*(['"])[^'"]*\1\s*,\s*(['"])[^'"]*\2\s*,\s*(['"])(?<auth>[^'"]*)\3/;

type BotCheck = 'runs' | 'none' | 'unreadable';

function botCheckOf(source: string): BotCheck {
  const code = stripImportsAndComments(source);
  let viaReader = false;
  for (const call of code.matchAll(/\bwithDbReader\(/g)) {
    const literal = READER_CALL_WITH_LITERAL_AUTH.exec(code.slice(call.index));
    // A computed auth argument cannot be read here: stop rather than guess.
    if (!literal) return 'unreadable';
    if (literal.groups?.auth !== 'public') viaReader = true;
  }
  return GUARD_REFERENCE.test(code) || viaReader ? 'runs' : 'none';
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
  const entries = readProtectEntries(
    readFileSync(resolve(ROOT, 'src/main.tsx'), 'utf8'),
  );
  const listed = new Set(entries.map((e) => e.path));
  const botCheck = new Map<string, BotCheck>(
    listHandlerFiles().map((file) => [
      routeOf(file),
      botCheckOf(readFileSync(resolve(ROOT, file), 'utf8')),
    ]),
  );
  return { entries, listed, botCheck };
}

describe('botid protect list vs the handlers that run the bot check', () => {
  const { entries, listed, botCheck } = scanTree();

  // Floors well under today's counts (about 85 entries, 170 handler files): a
  // reader that silently finds nothing would otherwise pass both directions.
  it('reads a non-empty protect list and handler set', () => {
    expect(entries.length).toBeGreaterThan(50);
    expect(botCheck.size).toBeGreaterThan(100);
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
          `${route}: handler runs the bot check, but src/main.tsx does not list it`,
      );
    expect(missing).toEqual([]);
  });
});

// ── The reading rules, over small sources ────────────────────

describe('reading a handler source', () => {
  const reader = (auth: string) =>
    `export default withDbReader(\n  '/api/x',\n  'x',\n  ${auth},\n  async () => {},\n);`;

  it.each([
    ['a direct checkBot call', 'await checkBot(req);', 'runs'],
    ['guardOwnerEndpoint', 'await guardOwnerEndpoint(req, res, done);', 'runs'],
    [
      'guardOwnerOrGuestEndpoint',
      'await guardOwnerOrGuestEndpoint(req, res, done);',
      'runs',
    ],
    ['withDbReader owner', reader("'owner'"), 'runs'],
    ['withDbReader owner-or-guest', reader("'owner-or-guest'"), 'runs'],
    ['withDbReader public', reader("'public'"), 'none'],
    ['withDbReader with a computed auth', reader('AUTH'), 'unreadable'],
    ['no guard at all', 'export default () => {};', 'none'],
    [
      'only an import of the guard',
      "import { checkBot } from './a.js';",
      'none',
    ],
    [
      'only a multi-line import of a guard',
      "import {\n  guardOwnerEndpoint,\n  other,\n} from './a.js';",
      'none',
    ],
    [
      'a guard picked by a ternary, then called',
      'const guard = isGet ? guardOwnerOrGuestEndpoint : guardOwnerEndpoint;\nawait guard(req, res, done);',
      'runs',
    ],
    [
      'the guard named in a line comment',
      '// calls checkBot(req) later',
      'none',
    ],
    [
      'the guard named in a block comment',
      '/** Runs guardOwnerEndpoint(req) first. */',
      'none',
    ],
    [
      'a guard after a URL on the same line',
      "const u = 'https://x.test'; await checkBot(req);",
      'runs',
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

  it('reads the entries inside the protect array only', () => {
    const source = [
      "const other = { path: '/api/not-listed', method: 'GET' };",
      'initBotId({',
      '  protect: [',
      "    { path: '/api/a', method: 'GET' },",
      "    { path: '/api/b/[id]', method: 'PATCH' },",
      '    ],',
      '  });',
    ].join('\n');
    expect(readProtectEntries(source)).toEqual([
      { path: '/api/a', method: 'GET' },
      { path: '/api/b/[id]', method: 'PATCH' },
    ]);
  });
});
