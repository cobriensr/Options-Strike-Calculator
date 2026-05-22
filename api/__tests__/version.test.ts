import { describe, it, expect, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../version.js';
import { BUILD_SHA } from '../_lib/build-info.js';

describe('GET /api/version', () => {
  it('returns the BUILD_SHA bundled into the Function', () => {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const setHeader = vi.fn();
    const res = { status, json, setHeader } as unknown as VercelResponse;

    handler({} as VercelRequest, res);

    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ sha: BUILD_SHA });
  });
});
