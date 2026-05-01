/**
 * PATCH /api/periscope-chat-update?id=N
 *
 * In-place update of user-editable annotations on a saved Periscope
 * read or debrief: `calibration_quality` (1-5 stars) and `regime_tag`
 * (pin / drift-and-cap / gap-and-rip / trap / cone-breach / chop /
 * other). Both fields are optional in the request body — only those
 * present are written.
 *
 * Returns the new values of both fields on success so the frontend can
 * mirror server state without a follow-up GET.
 *
 * Authorization: owner-only. Same posture as the rest of the
 * periscope-chat-* family.
 *
 * Rate limit: 60/min — annotations are interactive (clicking stars,
 * cycling regime tags) and may fire several requests in a few seconds.
 *
 * Method: this endpoint accepts both PATCH and POST. PATCH is the
 * semantically-correct verb but some intermediate proxies / browser
 * fetch-from-form paths only allow GET/POST, so POST is also accepted
 * with the same body shape. Owner cookie + BotID gate apply to both.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  respondIfInvalid,
} from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';
import { Sentry, metrics } from './_lib/sentry.js';
import {
  periscopeChatUpdateBodySchema,
  periscopeChatDetailQuerySchema,
} from './_lib/validation.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/periscope-chat-update');

  if (req.method !== 'PATCH' && req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'PATCH or POST only' });
  }

  if (await guardOwnerEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'periscope-chat-update',
    60,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  const idParsed = periscopeChatDetailQuerySchema.safeParse(req.query);
  if (respondIfInvalid(idParsed, res, done)) return;
  const { id } = idParsed.data;

  const bodyParsed = periscopeChatUpdateBodySchema.safeParse(req.body);
  if (respondIfInvalid(bodyParsed, res, done)) return;
  const { calibration_quality, regime_tag, clear } = bodyParsed.data;

  const clearRegime = clear?.includes('regime_tag') ?? false;
  const clearQuality = clear?.includes('calibration_quality') ?? false;
  const hasAnyDirective =
    calibration_quality !== undefined ||
    regime_tag !== undefined ||
    clearRegime ||
    clearQuality;
  if (!hasAnyDirective) {
    done({ status: 400 });
    return res.status(400).json({
      error:
        'Provide at least one of calibration_quality, regime_tag, or clear[].',
    });
  }
  if (clearRegime && regime_tag !== undefined) {
    done({ status: 400 });
    return res.status(400).json({
      error: 'Cannot both set and clear regime_tag in the same request.',
    });
  }
  if (clearQuality && calibration_quality !== undefined) {
    done({ status: 400 });
    return res.status(400).json({
      error:
        'Cannot both set and clear calibration_quality in the same request.',
    });
  }

  try {
    const sql = getDb();

    // Three states per field — set, omitted, or cleared.
    //   set:     write the new value (parameterized)
    //   omitted: COALESCE preserves the existing column value (NULL
    //            param + COALESCE → keep current)
    //   cleared: pass an explicit "clear" sentinel and use a
    //            conditional in SQL to set NULL or COALESCE
    //
    // Neon's tagged template doesn't support fragment composition,
    // so we encode the clear flag as a boolean parameter and let
    // PG's CASE pick the branch.
    const rows = await sql`
      UPDATE periscope_analyses
      SET
        calibration_quality = CASE
          WHEN ${clearQuality}::boolean THEN NULL
          ELSE COALESCE(
            ${calibration_quality ?? null}::smallint,
            calibration_quality
          )
        END,
        regime_tag = CASE
          WHEN ${clearRegime}::boolean THEN NULL
          ELSE COALESCE(
            ${regime_tag ?? null}::text,
            regime_tag
          )
        END
      WHERE id = ${id}
      RETURNING id, calibration_quality, regime_tag
    `;

    if (rows.length === 0) {
      done({ status: 404 });
      return res.status(404).json({ error: 'Read not found' });
    }

    const row = rows[0]!;
    done({ status: 200 });
    return res.status(200).json({
      id: Number(row.id),
      calibration_quality:
        row.calibration_quality == null
          ? null
          : Number(row.calibration_quality),
      regime_tag: (row.regime_tag as string | null) ?? null,
    });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err, id }, 'periscope-chat-update endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
