import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
(async () => {
  for (const day of ['2026-03-16', '2026-05-28']) {
    const rows = (await sql`
      SELECT timestamp, price, gamma_oi, gamma_dir
      FROM spot_exposures WHERE ticker='SPX' AND date=${day}
      ORDER BY timestamp ASC`) as Record<string, unknown>[];
    console.log(`\n=== ${day}: ${rows.length} rows ===`);
    console.log(
      'first 4:',
      rows
        .slice(0, 4)
        .map(
          (r) =>
            `${new Date(r.timestamp).toISOString().slice(11, 16)} px=${r.price} goi=${r.gamma_oi} gdir=${r.gamma_dir}`,
        )
        .join(' | '),
    );
    const nzIdx = rows.findIndex((r) => Number(r.gamma_oi) !== 0);
    console.log(
      `first non-zero gamma_oi at idx ${nzIdx}:`,
      nzIdx >= 0
        ? `${new Date(rows[nzIdx].timestamp).toISOString().slice(11, 16)} goi=${rows[nzIdx].gamma_oi}`
        : 'NONE',
    );
    const nz = rows.filter((r) => Number(r.gamma_oi) !== 0).length;
    console.log(
      `nonzero gamma_oi rows: ${nz}/${rows.length}; price>0 rows: ${rows.filter((r) => Number(r.price) > 0).length}`,
    );
  }
})();
