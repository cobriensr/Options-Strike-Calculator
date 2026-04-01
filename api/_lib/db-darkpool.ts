/**
 * Dark pool snapshot persistence.
 *
 * Stores clustered dark pool data captured at analysis time
 * so it can be correlated with outcomes and fed into the ML pipeline.
 */

import { getDb } from './db.js';
import type { DarkPoolCluster } from './darkpool.js';

export interface DarkPoolSnapshotInput {
  date: string;
  timestamp: string;
  snapshotId: number | null;
  spxPrice: number | null;
  clusters: DarkPoolCluster[];
}

export async function saveDarkPoolSnapshot(
  input: DarkPoolSnapshotInput,
): Promise<number | null> {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO dark_pool_snapshots (
      date, timestamp, snapshot_id, spx_price, clusters
    ) VALUES (
      ${input.date},
      ${input.timestamp},
      ${input.snapshotId},
      ${input.spxPrice},
      ${JSON.stringify(input.clusters)}
    )
    ON CONFLICT (date, timestamp) DO UPDATE SET
      snapshot_id = EXCLUDED.snapshot_id,
      spx_price = EXCLUDED.spx_price,
      clusters = EXCLUDED.clusters
    RETURNING id
  `;
  return rows.length > 0 ? (rows[0]!.id as number) : null;
}
