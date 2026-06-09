// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockResponse } from './helpers';

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sendDbErrorResponse } from '../_lib/transient-db-response.js';
import { TransientDbError } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

const SERVER_ERROR_BODY = { error: 'internal error' };

describe('sendDbErrorResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('transient DB error (TransientDbError)', () => {
    it('responds 503 with a Retry-After header and transient body', () => {
      const res = mockResponse();
      sendDbErrorResponse(
        res,
        new TransientDbError(new Error('db attempt timeout')),
        { label: 'greek_heatmap', serverErrorBody: SERVER_ERROR_BODY },
      );

      expect(res._status).toBe(503);
      expect(res._headers['Retry-After']).toBe('5');
      expect(res._json).toEqual({
        error: 'temporarily unavailable',
        transient: true,
      });
    });

    it('logs at warn and increments the <label>.db_timeout metric', () => {
      const res = mockResponse();
      sendDbErrorResponse(
        res,
        new TransientDbError(new Error('db attempt timeout')),
        { label: 'greek_heatmap', serverErrorBody: SERVER_ERROR_BODY },
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(TransientDbError) }),
        'greek_heatmap transient db timeout',
      );
      expect(metrics.increment).toHaveBeenCalledWith(
        'greek_heatmap.db_timeout',
      );
    });

    it('does NOT capture the exception in Sentry on a transient error', () => {
      const res = mockResponse();
      sendDbErrorResponse(
        res,
        new TransientDbError(new Error('db attempt timeout')),
        { label: 'greek_heatmap', serverErrorBody: SERVER_ERROR_BODY },
      );

      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('treats any wrapped Neon transient signature as transient', () => {
      const res = mockResponse();
      sendDbErrorResponse(
        res,
        new TransientDbError(new Error('fetch failed')),
        { label: 'opening_flow_signal', serverErrorBody: SERVER_ERROR_BODY },
      );

      expect(res._status).toBe(503);
      expect(res._headers['Retry-After']).toBe('5');
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith(
        'opening_flow_signal.db_timeout',
      );
    });
  });

  describe('non-transient error', () => {
    it('responds 500 with the passed serverErrorBody', () => {
      const res = mockResponse();
      sendDbErrorResponse(res, new Error('boom'), {
        label: 'greek_heatmap',
        serverErrorBody: { error: 'Internal server error' },
      });

      expect(res._status).toBe(500);
      expect(res._json).toEqual({ error: 'Internal server error' });
      expect(res._headers['Retry-After']).toBeUndefined();
    });

    it('captures the exception in Sentry and logs at error', () => {
      const res = mockResponse();
      const err = new Error('boom');
      sendDbErrorResponse(res, err, {
        label: 'greek_heatmap',
        serverErrorBody: SERVER_ERROR_BODY,
      });

      expect(Sentry.captureException).toHaveBeenCalledWith(err);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err }),
        'greek_heatmap failed',
      );
      expect(metrics.increment).not.toHaveBeenCalled();
    });

    it('treats a non-Error value as non-transient (500)', () => {
      const res = mockResponse();
      sendDbErrorResponse(res, 'just a string', {
        label: 'greek_heatmap',
        serverErrorBody: SERVER_ERROR_BODY,
      });

      expect(res._status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledWith('just a string');
    });

    // The #2 fix: a genuine bug whose message merely contains a transient
    // token ("timeout") is NO LONGER swallowed as a 503. Only errors the DB
    // retry layer actually wrapped in TransientDbError are transient. A bare
    // Error('db attempt timeout') thrown OUTSIDE withDbRetry is a real bug.
    it('does NOT swallow a bare Error whose message contains "timeout"', () => {
      const res = mockResponse();
      const err = new Error('db attempt timeout');
      sendDbErrorResponse(res, err, {
        label: 'greek_heatmap',
        serverErrorBody: SERVER_ERROR_BODY,
      });

      expect(res._status).toBe(500);
      expect(res._headers['Retry-After']).toBeUndefined();
      expect(Sentry.captureException).toHaveBeenCalledWith(err);
      expect(metrics.increment).not.toHaveBeenCalled();
    });
  });

  describe('headersSent guard (no double-write)', () => {
    it('does not write a 503 when the response was already sent', () => {
      const res = mockResponse();
      res.headersSent = true;
      const statusSpy = vi.spyOn(res, 'status');

      sendDbErrorResponse(
        res,
        new TransientDbError(new Error('db attempt timeout')),
        { label: 'greek_heatmap', serverErrorBody: SERVER_ERROR_BODY },
      );

      expect(statusSpy).not.toHaveBeenCalled();
      // Telemetry still runs even when the response is already committed.
      expect(logger.warn).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith(
        'greek_heatmap.db_timeout',
      );
    });

    it('does not write a 500 when the response was already sent', () => {
      const res = mockResponse();
      res.headersSent = true;
      const statusSpy = vi.spyOn(res, 'status');
      const err = new Error('boom');

      sendDbErrorResponse(res, err, {
        label: 'greek_heatmap',
        serverErrorBody: SERVER_ERROR_BODY,
      });

      expect(statusSpy).not.toHaveBeenCalled();
      // Sentry capture still fires for the genuine error.
      expect(Sentry.captureException).toHaveBeenCalledWith(err);
    });
  });
});
