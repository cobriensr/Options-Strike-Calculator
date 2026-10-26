/**
 * Build-output check: pure logic, no I/O. The CLI wrapper is
 * scripts/check-build-output.mjs, which `npm run review` runs right after
 * `vite build`.
 *
 * It reads the built dist/index.html and fails on:
 *
 *   - an inline `<script>` (no src). The CSP in vercel.json has no hash or
 *     nonce for one, so the browser would block it.
 *   - no `<script src>` entry at all, i.e. not a Vite build.
 *   - a chunk index.html loads that is not in dist/.
 *
 * The parser reads the HTML `vite build` writes, not arbitrary HTML: a `>`
 * inside a quoted attribute value would end the tag early, and spaces around
 * an attribute's `=` are not expected.
 *
 * Spec: docs/superpowers/specs/review-remediation-2026-10-26.md (F2, X4).
 */

/** 1-based line of `offset` in `text`. */
function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

/** Replace each `<!-- ... -->` with spaces, keeping offsets and newlines. */
function blankComments(html) {
  let out = '';
  let pos = 0;
  for (;;) {
    const start = html.indexOf('<!--', pos);
    if (start === -1) return out + html.slice(pos);
    const close = html.indexOf('-->', start + 4);
    const end = close === -1 ? html.length : close + 3;
    out += html.slice(pos, start) + html.slice(start, end).replace(/./g, ' ');
    pos = end;
  }
}

/** `name`, `name=value`, `name="value"` or `name='value'` (no spaces around `=`). */
const ATTRIBUTE = /([\w:.-]+)(?:=("[^"]*"|'[^']*'|[^\s>]+))?/g;

/** Attribute name (lower-cased) -> value ('' for a bare attribute). */
function parseAttributes(text) {
  const attrs = new Map();
  for (const [, name, raw = ''] of text.matchAll(ATTRIBUTE)) {
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    attrs.set(name.toLowerCase(), quoted ? raw.slice(1, -1) : raw);
  }
  return attrs;
}

/**
 * The next `<name ...>` start tag at or after `from`, or null. `lower` is the
 * lower-cased `text`. `<scripts>` does not match `script`. `end` is just past
 * the tag's `>` (the end of the text when it has none).
 */
function nextStartTag(text, lower, name, from) {
  const open = `<${name}`;
  for (let pos = from; ; ) {
    const start = lower.indexOf(open, pos);
    if (start === -1) return null;
    pos = start + open.length;
    const next = lower.charAt(pos);
    if (next !== '>' && next !== '/' && !/\s/.test(next)) continue;
    const close = lower.indexOf('>', pos);
    const attrsEnd = close === -1 ? text.length : close;
    return {
      start,
      end: close === -1 ? text.length : close + 1,
      attrs: parseAttributes(text.slice(pos, attrsEnd)),
    };
  }
}

const SNIPPET_MAX = 80;

/** One line, at most SNIPPET_MAX characters. */
function snippetOf(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX
    ? `${flat.slice(0, SNIPPET_MAX - 3)}...`
    : flat;
}

/**
 * The parts of a built index.html this check needs: every `<script src>`, every
 * `<link rel="modulepreload">` href, and every inline `<script>` with its line
 * and a one-line snippet. Tags inside HTML comments are ignored, and a
 * script's body is never read as markup. An unclosed `<script>` runs to the
 * end of the file, as a browser would read it.
 */
export function parseIndexHtml(html) {
  const text = blankComments(html);
  const lower = text.toLowerCase();

  const scriptSrcs = [];
  const inlineScripts = [];
  for (let pos = 0; ; ) {
    const tag = nextStartTag(text, lower, 'script', pos);
    if (tag === null) break;
    const close = lower.indexOf('</script', tag.end);
    const closeEnd = close === -1 ? -1 : lower.indexOf('>', close);
    pos = closeEnd === -1 ? text.length : closeEnd + 1;
    const src = tag.attrs.get('src');
    if (src) {
      scriptSrcs.push(src);
    } else {
      inlineScripts.push({
        line: lineAt(text, tag.start),
        snippet: snippetOf(html.slice(tag.start, pos)),
      });
    }
  }

  const modulepreloads = [];
  for (let pos = 0; ; ) {
    const tag = nextStartTag(text, lower, 'link', pos);
    if (tag === null) break;
    pos = tag.end;
    const rel = (tag.attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const href = tag.attrs.get('href');
    if (rel.includes('modulepreload') && href) modulepreloads.push(href);
  }

  return { scriptSrcs, modulepreloads, inlineScripts };
}

const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/**
 * Site-root path of a local href (`./assets/a.js` and `assets/a.js` become
 * `/assets/a.js`), or null for an external URL, which is not build output.
 */
function servedPath(href) {
  if (EXTERNAL.test(href)) return null;
  const bare = href.split(/[?#]/)[0];
  return bare.startsWith('/') ? bare : `/${bare.replace(/^(?:\.\/)+/, '')}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function basename(served) {
  return served.slice(served.lastIndexOf('/') + 1);
}

/**
 * Check a built dist/index.html against the chunks in dist/.
 *
 * @param {object} input
 * @param {string} input.html  dist/index.html text.
 * @param {Map<string, string>} input.chunks  Served path (`/assets/x.js`) ->
 *   source, for every JS file the build wrote under dist/assets.
 * @returns {{ ok: boolean, messages: string[] }} One line per problem plus a
 *   footer when failing; one summary line when passing.
 */
export function checkBuildOutput({ html, chunks }) {
  const parsed = parseIndexHtml(html);
  const problems = [];

  if (parsed.scriptSrcs.length === 0) {
    problems.push(
      'dist/index.html has no <script src> entry. Is it a `vite build` output?',
    );
  }

  for (const { line, snippet } of parsed.inlineScripts) {
    problems.push(
      `dist/index.html line ${line} has an inline <script> (no src): ${snippet}. ` +
        'The CSP allows no inline scripts, so the browser would block it.',
    );
  }

  // Everything the browser fetches before first paint: the entry script(s)
  // plus Vite's modulepreload list, which is the entry's full static graph.
  const firstPaint = [];
  for (const href of [...parsed.scriptSrcs, ...parsed.modulepreloads]) {
    const served = servedPath(href);
    if (served === null || firstPaint.includes(served)) continue;
    firstPaint.push(served);
    if (!chunks.has(served)) {
      problems.push(`dist/index.html loads ${served}, which is not in dist/.`);
    }
  }

  if (problems.length > 0) {
    return {
      ok: false,
      messages: [
        ...problems.map((p) => `build output: ${p}`),
        `build output: FAILED, ${plural(problems.length, 'problem')} in dist/index.html.`,
      ],
    };
  }

  return {
    ok: true,
    messages: [
      `build output: OK, first paint loads ${plural(firstPaint.length, 'chunk')} ` +
        `(${firstPaint.map(basename).join(', ')}); no inline scripts`,
    ],
  };
}
