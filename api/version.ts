// GET /api/version
//
// Returns the commit SHA baked into this Function at build time. Paired
// with the frontend __BUILD_SHA__ canary so we can independently probe
// whether Vercel's per-entrypoint Function cache served a stale bundle:
// compare /api/version's response to the SHA shown in the footer.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BUILD_SHA } from './_lib/build-info.js';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ sha: BUILD_SHA });
}
