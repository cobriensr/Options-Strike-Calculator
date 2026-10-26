import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { parseIndexHtml, checkBuildOutput } from './build-output.mjs';

/**
 * index.html in the layout `vite build` writes: the entry module script,
 * then one modulepreload link per static dependency of the entry.
 */
function viteHtml({
  entry = '/assets/index-abc.js',
  preloads = ['/assets/vendor-def.js'],
  head = '',
  body = '',
} = {}) {
  const preloadTags = preloads
    .map((href) => `    <link rel="modulepreload" crossorigin href="${href}">`)
    .join('\n');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <title>0DTE Strike Calculator</title>',
    head,
    `    <script type="module" crossorigin src="${entry}"></script>`,
    preloadTags,
    '    <link rel="stylesheet" crossorigin href="/assets/index-xyz.css">',
    '  <link rel="manifest" href="/manifest.webmanifest"></head>',
    '  <body>',
    '    <div id="root"></div>',
    body,
    '  </body>',
    '</html>',
  ].join('\n');
}

/** Map of served path -> source, as the CLI builds it from dist/assets. */
function chunks(entries) {
  return new Map(Object.entries(entries));
}

const CLEAN_CHUNKS = {
  '/assets/index-abc.js': 'import "./vendor-def.js";',
  '/assets/vendor-def.js': 'export const createElement = 1;',
};

describe('parseIndexHtml', () => {
  it('collects the entry script and the modulepreload links of a Vite build', () => {
    const parsed = parseIndexHtml(
      viteHtml({
        preloads: ['/assets/vendor-def.js', '/assets/sentry-ghi.js'],
      }),
    );
    expect(parsed.scriptSrcs).toEqual(['/assets/index-abc.js']);
    expect(parsed.modulepreloads).toEqual([
      '/assets/vendor-def.js',
      '/assets/sentry-ghi.js',
    ]);
    expect(parsed.inlineScripts).toEqual([]);
  });

  it('reports a <script> without src as inline, with its 1-based line', () => {
    const html = viteHtml({ head: '    <script>window.x = 1;</script>' });
    const parsed = parseIndexHtml(html);
    expect(parsed.inlineScripts).toEqual([
      { line: 6, snippet: '<script>window.x = 1;</script>' },
    ]);
    expect(parsed.scriptSrcs).toEqual(['/assets/index-abc.js']);
  });

  it('treats an empty src attribute as inline', () => {
    const parsed = parseIndexHtml(
      viteHtml({ body: '<script src="">alert(1)</script>' }),
    );
    expect(parsed.inlineScripts).toHaveLength(1);
  });

  it('reads single-quoted, unquoted and upper-case attributes', () => {
    const parsed = parseIndexHtml(
      [
        "<SCRIPT TYPE=module SRC='/assets/index-abc.js'></SCRIPT>",
        '<LINK REL=modulepreload HREF=/assets/vendor-def.js>',
      ].join('\n'),
    );
    expect(parsed.scriptSrcs).toEqual(['/assets/index-abc.js']);
    expect(parsed.modulepreloads).toEqual(['/assets/vendor-def.js']);
  });

  it('matches modulepreload as one token of a space-separated rel list', () => {
    const parsed = parseIndexHtml(
      '<link rel="prefetch modulepreload" href="/assets/a.js">',
    );
    expect(parsed.modulepreloads).toEqual(['/assets/a.js']);
  });

  it('ignores stylesheet, manifest and preconnect links', () => {
    const parsed = parseIndexHtml(viteHtml({ preloads: [] }));
    expect(parsed.modulepreloads).toEqual([]);
  });

  it('ignores tags inside HTML comments', () => {
    const parsed = parseIndexHtml(
      viteHtml({
        head: '<!-- <script>old()</script> <link rel="modulepreload" href="/assets/old.js"> -->',
      }),
    );
    expect(parsed.inlineScripts).toEqual([]);
    expect(parsed.modulepreloads).toEqual(['/assets/vendor-def.js']);
  });

  it('does not read <scripts> or <linked> as script or link tags', () => {
    const parsed = parseIndexHtml(
      '<scripts>x</scripts><linked rel="modulepreload" href="/a.js">',
    );
    expect(parsed.inlineScripts).toEqual([]);
    expect(parsed.modulepreloads).toEqual([]);
  });

  it('does not read markup inside a script body as tags', () => {
    const parsed = parseIndexHtml(
      '<script src="/assets/a.js">var s = "<script>x<\\/script>";</script>',
    );
    expect(parsed.scriptSrcs).toEqual(['/assets/a.js']);
    expect(parsed.inlineScripts).toEqual([]);
  });

  it('flattens and truncates a long inline script to an 80-character snippet', () => {
    const body = `\n  ${'x'.repeat(200)}\n`;
    const [inline] = parseIndexHtml(`<script>${body}</script>`).inlineScripts;
    expect(inline.snippet).toHaveLength(80);
    expect(inline.snippet.startsWith('<script> xxx')).toBe(true);
    expect(inline.snippet.endsWith('...')).toBe(true);
  });

  it('reports an unclosed <script> as inline instead of skipping it', () => {
    const parsed = parseIndexHtml('<html><script>never closed');
    expect(parsed.inlineScripts).toEqual([
      { line: 1, snippet: '<script>never closed' },
    ]);
  });
});

describe('checkBuildOutput', () => {
  it('passes a clean build and names the first-paint chunks', () => {
    const result = checkBuildOutput({
      html: viteHtml(),
      chunks: chunks(CLEAN_CHUNKS),
    });
    expect(result).toEqual({
      ok: true,
      messages: [
        'build output: OK, first paint loads 2 chunks (index-abc.js, vendor-def.js); no inline scripts',
      ],
    });
  });

  it('fails on an inline script, naming its line', () => {
    const result = checkBuildOutput({
      html: viteHtml({ head: '    <script>window.x = 1;</script>' }),
      chunks: chunks(CLEAN_CHUNKS),
    });
    expect(result.ok).toBe(false);
    expect(result.messages).toEqual([
      'build output: dist/index.html line 6 has an inline <script> (no src): ' +
        '<script>window.x = 1;</script>. The CSP allows no inline scripts, ' +
        'so the browser would block it.',
      'build output: FAILED, 1 problem in dist/index.html.',
    ]);
  });

  it('fails when index.html has no <script src> entry', () => {
    const result = checkBuildOutput({
      html: '<!doctype html><html><body></body></html>',
      chunks: chunks(CLEAN_CHUNKS),
    });
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      'build output: dist/index.html has no <script src> entry. ' +
        'Is it a `vite build` output?',
    );
  });

  it('fails when index.html loads a chunk that is not in dist/assets', () => {
    const result = checkBuildOutput({
      html: viteHtml({
        preloads: ['/assets/vendor-def.js', '/assets/gone.js'],
      }),
      chunks: chunks(CLEAN_CHUNKS),
    });
    expect(result.ok).toBe(false);
    expect(result.messages).toEqual([
      'build output: dist/index.html loads /assets/gone.js, which is not in dist/.',
      'build output: FAILED, 1 problem in dist/index.html.',
    ]);
  });

  it('resolves relative hrefs against the site root', () => {
    const result = checkBuildOutput({
      html: viteHtml({
        entry: './assets/index-abc.js',
        preloads: ['assets/vendor-def.js'],
      }),
      chunks: chunks(CLEAN_CHUNKS),
    });
    expect(result.ok).toBe(true);
  });

  it('skips external scripts, which are not build output', () => {
    const result = checkBuildOutput({
      html: viteHtml({
        body: '<script src="https://va.vercel-scripts.com/v1/script.js"></script>',
      }),
      chunks: chunks(CLEAN_CHUNKS),
    });
    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain('first paint loads 2 chunks');
  });

  it('counts every problem in the footer', () => {
    const result = checkBuildOutput({
      html: viteHtml({
        head: '<script>a()</script><script>b()</script>',
        preloads: ['/assets/gone.js'],
      }),
      chunks: chunks(CLEAN_CHUNKS),
    });
    expect(result.ok).toBe(false);
    expect(result.messages).toHaveLength(4);
    expect(result.messages.at(-1)).toBe(
      'build output: FAILED, 3 problems in dist/index.html.',
    );
  });
});

describe('check-build-output CLI', () => {
  // vitest runs from the repo root (same convention as check-coverage-floor).
  const cli = path.resolve(process.cwd(), 'scripts', 'check-build-output.mjs');
  let cwd;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'build-output-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Write dist/index.html plus dist/assets/<name> files, then run the CLI. */
  function runCli({ html, assets = {} } = {}) {
    if (html !== undefined) {
      mkdirSync(path.join(cwd, 'dist', 'assets'), { recursive: true });
      writeFileSync(path.join(cwd, 'dist', 'index.html'), html);
      for (const [name, source] of Object.entries(assets)) {
        writeFileSync(path.join(cwd, 'dist', 'assets', name), source);
      }
    }
    return spawnSync(process.execPath, [cli], { cwd, encoding: 'utf8' });
  }

  const CLEAN_ASSETS = {
    'index-abc.js': CLEAN_CHUNKS['/assets/index-abc.js'],
    'vendor-def.js': CLEAN_CHUNKS['/assets/vendor-def.js'],
    'index-abc.js.map': '{"version":3}',
  };

  it('exits 1 with a clear message when dist/ is missing', () => {
    const result = runCli();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'build output: FAILED, dist/ not found. It is written by `vite build`; run that first.',
    );
  });

  it('exits 1 when dist/ exists but has no index.html', () => {
    mkdirSync(path.join(cwd, 'dist'));
    const result = runCli();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'build output: FAILED, dist/index.html not found.',
    );
  });

  it('exits 0 and prints the summary on a clean build', () => {
    const result = runCli({ html: viteHtml(), assets: CLEAN_ASSETS });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'build output: OK, first paint loads 2 chunks (index-abc.js, vendor-def.js)',
    );
    expect(result.stderr).toBe('');
  });

  it('exits 1 and prints each problem to stderr on a failing build', () => {
    const result = runCli({
      html: viteHtml({ head: '<script>window.x = 1;</script>' }),
      assets: CLEAN_ASSETS,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('has an inline <script> (no src)');
    expect(result.stderr).toContain(
      'build output: FAILED, 1 problem in dist/index.html.',
    );
    expect(result.stdout).toBe('');
  });

  it('exits 1 when a chunk index.html loads is missing from dist/assets', () => {
    const result = runCli({
      html: viteHtml(),
      assets: { 'index-abc.js': CLEAN_ASSETS['index-abc.js'] },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'loads /assets/vendor-def.js, which is not in dist/.',
    );
  });
});
