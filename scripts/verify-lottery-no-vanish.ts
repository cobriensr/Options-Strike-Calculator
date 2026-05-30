/**
 * verify-lottery-no-vanish.ts — behavioral regression guard for the
 * "lottery alerts must never disappear intraday" invariant
 * (spec docs/superpowers/specs/lottery-no-vanish-2026-05-29.md).
 *
 * Replays the lottery feed's visible-chain set at successive intraday
 * cutoffs (09:00 → 15:00 CT, 30-min steps) using the SAME chain-max
 * gating the endpoint uses, and asserts the visible set is
 * MONOTONICALLY NON-SHRINKING: once a chain (ticker, strike, type,
 * expiry) is visible at cutoff T it must stay visible at every later
 * cutoff. Any chain that appears then disappears is a regression.
 *
 * Run:  npx tsx scripts/verify-lottery-no-vanish.ts [YYYY-MM-DD] [floor]
 *   date  default = most recent date present in lottery_finder_fires
 *   floor default = 0.70 (the UI's default TAKE-IT floor)
 *
 * Exit code 1 on any violation so it can gate CI / a nightly check.
 */
import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

const MIN_ALERT_ENTRY_PRICE = 0.1;
const CUTOFFS_CT = [
  '09:00',
  '09:30',
  '10:00',
  '10:30',
  '11:00',
  '11:30',
  '12:00',
  '12:30',
  '13:00',
  '13:30',
  '14:00',
  '14:30',
  '15:00',
];

/** Visible chains as of `cutoffCt` (CT HH:MM) under the chain-max gate. */
async function visibleChains(
  date: string,
  cutoffCt: string,
  floor: number,
): Promise<Set<string>> {
  const rows = (await sql`
    WITH filtered AS (
      SELECT
        underlying_symbol, strike, option_type, expiry,
        ROW_NUMBER() OVER (
          PARTITION BY underlying_symbol, strike, option_type, expiry
          ORDER BY trigger_time_ct DESC, id DESC
        ) AS rn,
        MAX(takeit_prob) OVER (
          PARTITION BY underlying_symbol, strike, option_type, expiry
        ) AS chain_max_takeit
      FROM lottery_finder_fires
      WHERE date = ${date}::date
        AND (trigger_time_ct AT TIME ZONE 'America/Chicago')
            < (${`${date} ${cutoffCt}`}::timestamp)
        AND entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
    )
    SELECT underlying_symbol, strike, option_type, expiry
    FROM filtered
    WHERE rn = 1
      AND (${floor}::numeric IS NULL OR chain_max_takeit >= ${floor}::numeric)
  `) as Record<string, unknown>[];
  return new Set(
    rows.map(
      (r) =>
        `${r.underlying_symbol} ${r.strike}${r.option_type} ${String(r.expiry)}`,
    ),
  );
}

(async () => {
  const date =
    process.argv[2] ??
    (
      (await sql`SELECT MAX(date)::text AS d FROM lottery_finder_fires`)[0] as {
        d: string;
      }
    ).d;
  const floor = process.argv[3] ? Number(process.argv[3]) : 0.7;

  console.log(
    `Verifying monotonic visibility for ${date} at floor ${floor}…\n`,
  );

  const seen = new Set<string>();
  const violations: { chain: string; vanishedAt: string }[] = [];
  let prevVisible = new Set<string>();

  for (const cutoff of CUTOFFS_CT) {
    const visible = await visibleChains(date, cutoff, floor);
    // A chain visible at any earlier cutoff that is NOT visible now =
    // a vanish (the bug). chain-max gating should make this impossible.
    for (const chain of prevVisible) {
      if (!visible.has(chain)) {
        violations.push({ chain, vanishedAt: cutoff });
      }
    }
    for (const c of visible) seen.add(c);
    console.log(
      `  ${cutoff} CT  visible=${String(visible.size).padStart(3)}  cumulative=${seen.size}`,
    );
    // Carry forward the union so a one-cutoff blip is still caught even
    // if the chain reappears later.
    prevVisible = new Set([...prevVisible, ...visible]);
  }

  console.log('');
  if (violations.length === 0) {
    console.log(
      `✅ PASS — no chain disappeared across ${CUTOFFS_CT.length} cutoffs (${seen.size} distinct chains).`,
    );
    process.exit(0);
  }
  console.log(`❌ FAIL — ${violations.length} vanish event(s):`);
  for (const v of violations.slice(0, 30)) {
    console.log(`   ${v.chain} — gone by ${v.vanishedAt} CT`);
  }
  process.exit(1);
})();
