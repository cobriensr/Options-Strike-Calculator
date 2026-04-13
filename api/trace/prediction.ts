import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';

const todayUtc = () => new Date().toISOString().slice(0, 10);

const PredictionSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .refine((d) => d <= todayUtc(), 'date cannot be in the future'),
  predicted_close: z.number().positive(),
  confidence: z.enum(['high', 'medium', 'low']),
  notes: z.string().optional(),
  gamma_regime: z.enum(['positive', 'negative']).nullable().optional(),
});

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const sql = getDb();

  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT
          tp.date::text,
          tp.predicted_close::float,
          tp.confidence,
          tp.notes,
          tp.current_price::float,
          tp.actual_close::float,
          tp.created_at,
          tp.gamma_regime,
          tf.vix::float   AS vix,
          tf.vix1d::float AS vix1d
        FROM trace_predictions tp
        LEFT JOIN training_features tf ON tf.date = tp.date
        ORDER BY tp.date DESC
        LIMIT 60
      `;
      res.status(200).json(rows);
    } catch (err) {
      logger.error({ err }, 'trace/prediction GET failed');
      res.status(500).json({ error: 'Failed to load predictions' });
    }
    return;
  }

  if (req.method === 'POST') {
    const parsed = PredictionSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid input', details: parsed.error.format() });
      return;
    }
    const { date, predicted_close, confidence, notes, gamma_regime } =
      parsed.data;
    try {
      const [row] = await sql`
        INSERT INTO trace_predictions (date, predicted_close, confidence, notes, gamma_regime)
        VALUES (${date}, ${predicted_close}, ${confidence}, ${notes ?? null}, ${gamma_regime ?? null})
        ON CONFLICT (date) DO UPDATE SET
          predicted_close = EXCLUDED.predicted_close,
          confidence      = EXCLUDED.confidence,
          notes           = EXCLUDED.notes,
          gamma_regime    = EXCLUDED.gamma_regime,
          updated_at      = now()
        RETURNING date::text, predicted_close::float, confidence, notes, actual_close::float, current_price::float, gamma_regime
      `;
      res.status(200).json(row);
    } catch (err) {
      logger.error({ err }, 'trace/prediction POST failed');
      res.status(500).json({ error: 'Failed to save prediction' });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const date = req.query['date'];
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
      return;
    }
    try {
      await sql`DELETE FROM trace_predictions WHERE date = ${date}`;
      res.status(200).json({ deleted: date });
    } catch (err) {
      logger.error({ err }, 'trace/prediction DELETE failed');
      res.status(500).json({ error: 'Failed to delete prediction' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
