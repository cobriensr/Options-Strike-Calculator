// @vitest-environment node

/**
 * Pins the security properties of the page headers in vercel.json, not the
 * full strings, so adding a host to connect-src stays a one-line change.
 *
 * Inline scripts are guarded at build time instead: index.html has none,
 * and scripts/check-build-output.mjs fails `npm run review` if one appears.
 * That is why script-src carries no sha256 hashes.
 *
 * Spec: docs/superpowers/specs/review-remediation-2026-10-26.md (X2–X5).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface HeaderBlock {
  source: string;
  headers: { key: string; value: string }[];
}

const { headers: blocks } = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'),
) as { headers: HeaderBlock[] };

/** The catch-all block that carries the page CSP. */
const pageBlock = blocks.find((block) =>
  block.headers.some((h) => h.key === 'Content-Security-Policy'),
);

function header(key: string): string {
  const value = pageBlock?.headers.find((h) => h.key === key)?.value;
  if (value === undefined) throw new Error(`vercel.json has no ${key} header`);
  return value;
}

/** CSP directive name -> its source list. */
function directives(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of header('Content-Security-Policy').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

describe('vercel.json page security headers', () => {
  it('has exactly one Content-Security-Policy header block', () => {
    const withCsp = blocks.filter((block) =>
      block.headers.some((h) => h.key === 'Content-Security-Policy'),
    );
    expect(withCsp).toHaveLength(1);
  });

  it("blocks plugins with object-src 'none'", () => {
    expect(directives().get('object-src')).toEqual(["'none'"]);
  });

  it('allows no inline or eval script, by hash or keyword', () => {
    const scriptSrc = directives().get('script-src') ?? [];
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc.filter((s) => /^'sha(256|384|512)-/.test(s))).toEqual([]);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("keeps style-src 'unsafe-inline' for the <style> lightweight-charts injects", () => {
    expect(directives().get('style-src')).toContain("'unsafe-inline'");
  });

  it('keeps frame-ancestors and base-uri locked to self', () => {
    const csp = directives();
    expect(csp.get('frame-ancestors')).toEqual(["'self'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
  });

  it('opts out of Topics but no longer names the retired interest-cohort', () => {
    const policy = header('Permissions-Policy');
    expect(policy).toContain('browsing-topics=()');
    expect(policy).not.toContain('interest-cohort');
  });
});
