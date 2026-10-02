/**
 * GET /api/auth/schwab-status
 *
 * Owner-only, read-only view of the Schwab login: the refresh token's expiry
 * and whether it is active, expiring (24 h or less), expired, or logged out.
 * Drives the header countdown badge (`SchwabExpiryBadge`).
 *
 * The value is not secret (no token values are returned) but it describes
 * the owner's brokerage session, so it is owner-gated, not guest-readable.
 * A token-store read failure answers 200 `{ state: 'unknown' }` rather than
 * an error: the badge hides on it and the hourly reminder cron is the loud
 * path for a Redis outage.
 *
 * Spec: docs/superpowers/specs/schwab-reauth-2026-09-29.md (A3).
 */

import { withDbReader } from '../_lib/request-scope.js';
import { getSchwabAuthStatus } from '../_lib/schwab.js';

export default withDbReader(
  '/api/auth/schwab-status',
  'schwab_status',
  'owner',
  async (_req, res, done) => {
    const status = await getSchwabAuthStatus();
    res.setHeader('Cache-Control', 'no-store');
    done({ status: 200 });
    res.status(200).json(status);
  },
);
