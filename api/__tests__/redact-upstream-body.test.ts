// @vitest-environment node

import { describe, it, expect } from 'vitest';

import { redactUpstreamBody } from '../_lib/redact-upstream-body.js';

describe('redactUpstreamBody', () => {
  it.each([
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNlY3JldA'],
    ['a Schwab-style token', 'I0.b2F1dGgyLmNkYy5zY2h3YWIuY29t.Zk9xQ2Vx'],
    ['a hex secret', '0123456789abcdef0123456789abcdef'],
    ['a base64url secret', 'Zk9x-Q2Vx_aGVsbG8td29ybGQtc2VjcmV0'],
  ])('masks %s', (_label, secret) => {
    const out = redactUpstreamBody(`{"token":"${secret}","error":"x"}`);

    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
    expect(out).toContain('"error":"x"');
  });

  it('leaves ordinary error text untouched', () => {
    const body =
      '{"error":"invalid_request","error_description":"Bad Request: missing grant_type"}';

    expect(redactUpstreamBody(body)).toBe(body);
  });

  it("keeps Schwab's double-encoded invalid_grant readable", () => {
    const body =
      '{"error":"unsupported_token_type","error_description":"400 Bad Request: \\"{\\"error_description\\":\\"Refresh token is invalid, expired or revoked\\",\\"error\\":\\"invalid_grant\\"}\\""}';

    const out = redactUpstreamBody(body);

    expect(out).toContain('invalid_grant');
    expect(out).toContain('unsupported_token_type');
  });

  it('truncates long bodies to 200 characters and reports the full length', () => {
    const out = redactUpstreamBody('x '.repeat(300));

    expect(out.startsWith('x '.repeat(100))).toBe(true);
    expect(out).toContain('600 chars');
    expect(out.length).toBeLessThan(230);
  });

  it('masks before truncating, so no fragment of a token survives the cut', () => {
    // The secret straddles the 200-char boundary.
    const secret = 'A'.repeat(60);

    const out = redactUpstreamBody(`${'y '.repeat(95)}${secret}`);

    expect(out).not.toMatch(/A{5}/);
  });
});
