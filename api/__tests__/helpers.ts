// @vitest-environment node

/**
 * Shared test helpers for API tests.
 * Provides mock factories for VercelRequest / VercelResponse.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

export function mockRequest(
  overrides: Partial<VercelRequest> = {},
): VercelRequest {
  return {
    headers: {},
    query: {},
    ...overrides,
  } as unknown as VercelRequest;
}

export function mockResponse(): VercelResponse & {
  _status: number;
  _json: unknown;
  _headers: Record<string, string>;
  _redirectUrl: string;
  _redirectStatus: number;
  _body: string;
  _contentType: string;
} {
  const res = {
    _status: 200,
    _json: null as unknown,
    _headers: {} as Record<string, string>,
    _redirectUrl: '',
    _redirectStatus: 0,
    _body: '',
    _contentType: '',
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: unknown) {
      res._json = data;
      return res;
    },
    send(body: string) {
      res._body = body;
      return res;
    },
    setHeader(key: string, value: string) {
      res._headers[key] = value;
      return res;
    },
    redirect(status: number, url: string) {
      res._redirectStatus = status;
      res._redirectUrl = url;
      return res;
    },
  };
  return res as unknown as VercelResponse & typeof res;
}
