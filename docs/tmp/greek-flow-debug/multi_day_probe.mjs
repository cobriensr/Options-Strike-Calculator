/**
 * Multi-day probe of UW Greek Flow API to support a bug report.
 *
 * For each target date, queries /stock/SPY/greek-flow?date=YYYY-MM-DD
 * twice with a 30s gap and prints summary stats. If the values change
 * between the two reads, UW is still restating that date. If they don't,
 * the date is "stable" (final reconciliation).
 *
 * Run: node docs/tmp/greek-flow-debug/multi_day_probe.mjs
 *
 * Requires: UW_API_KEY in .env.local
 */
import 'dotenv/config';

const apiKey = process.env.UW_API_KEY;
if (!apiKey) {
  console.error('UW_API_KEY missing');
  process.exit(1);
}

const DATES = [
  '2026-04-28',
  '2026-04-29',
  '2026-04-30',
  '2026-05-01',
  '2026-05-02',
];

async function fetchUw(date) {
  const url = `https://api.unusualwhales.com/api/stock/SPY/greek-flow?date=${date}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  const body = await res.json();
  return { ok: true, ticks: body.data ?? [] };
}

function summarize(ticks) {
  const sorted = [...ticks].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  let cum = 0;
  let cumMax = -Infinity;
  let cumMin = Infinity;
  for (const t of sorted) {
    const v = Number.parseFloat(t.otm_dir_delta_flow);
    if (!Number.isFinite(v)) continue;
    cum += v;
    if (cum > cumMax) cumMax = cum;
    if (cum < cumMin) cumMin = cum;
  }
  return {
    ticks: sorted.length,
    cum_eod: cum,
    cum_max: Number.isFinite(cumMax) ? cumMax : 0,
    cum_min: Number.isFinite(cumMin) ? cumMin : 0,
  };
}

const fmt = (n) => {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    maximumFractionDigits: 0,
    signDisplay: 'auto',
  });
};

const rows = [];
for (const date of DATES) {
  const a = await fetchUw(date);
  if (!a.ok) {
    rows.push({ date, status: `HTTP ${a.status}` });
    continue;
  }
  await new Promise((r) => setTimeout(r, 30_000));
  const b = await fetchUw(date);
  if (!b.ok) {
    rows.push({ date, status: `HTTP ${b.status}` });
    continue;
  }
  const sa = summarize(a.ticks);
  const sb = summarize(b.ticks);
  const stable = sa.cum_eod === sb.cum_eod && sa.cum_min === sb.cum_min;
  rows.push({
    date,
    ticks: sa.ticks,
    cum_eod: fmt(sa.cum_eod),
    cum_max: fmt(sa.cum_max),
    cum_min: fmt(sa.cum_min),
    stable_30s: stable ? 'yes' : 'no',
  });
}

console.log(
  'SPY OTM Dir Delta cumulative (live UW API), two reads 30s apart:\n',
);
console.table(rows);
