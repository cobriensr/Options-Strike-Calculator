// @vitest-environment node

/**
 * /api/periscope-chat — 410 Gone deprecation stub tests.
 *
 * The full manual-chat handler was removed in Phase 4d of
 * docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md. These
 * tests only verify the 410 contract + X-Deprecation-Replacement
 * header so any stale frontend tab gets a clear signal to retry against
 * /api/periscope-auto-playbook.
 */

import { describe, it, expect, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/sentry.js', () => ({
  metrics: {
    request: vi.fn().mockReturnValue(vi.fn()),
  },
}));

import handler from '../periscope-chat.js';

describe('/api/periscope-chat (deprecated 410 stub)', () => {
  it('returns 410 Gone on POST', () => {
    const req = mockRequest({ method: 'POST', body: {} });
    const res = mockResponse();
    handler(req, res);
    expect(res._status).toBe(410);
  });

  it('returns 410 Gone on GET (stale clients may probe with any method)', () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    handler(req, res);
    expect(res._status).toBe(410);
  });

  it('sets X-Deprecation-Replacement header pointing at the new endpoint', () => {
    const req = mockRequest({ method: 'POST', body: {} });
    const res = mockResponse();
    handler(req, res);
    expect(res._headers['X-Deprecation-Replacement']).toBe(
      '/api/periscope-auto-playbook',
    );
  });

  it('includes a deprecation message + replacement in the JSON body', () => {
    const req = mockRequest({ method: 'POST', body: {} });
    const res = mockResponse();
    handler(req, res);
    const body = res._json as { error: string; replacement: string };
    expect(body.replacement).toBe('/api/periscope-auto-playbook');
    expect(body.error).toMatch(/deprecated/i);
  });
});
