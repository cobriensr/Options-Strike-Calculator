/**
 * Verify all 4 Greek Flow panels for SPY and QQQ on 2026-05-01.
 *
 * Pulls live UW data and reports cumulative end / max / min for:
 *   - SPY OTM Dir Delta
 *   - QQQ OTM Dir Delta
 *   - SPY OTM Dir Vega
 *   - QQQ OTM Dir Vega
 *
 * Used after the UPSERT + backfill fix to confirm the other 3 panels
 * also now match UW's web display.
 */
import 'dotenv/config';

const apiKey = process.env.UW_API_KEY;
if (!apiKey) {
  console.error('UW_API_KEY missing');
  process.exit(1);
}

const DATE = '2026-05-01';

async function fetchUw(ticker) {
  const url = `https://api.unusualwhales.com/api/stock/${ticker}/greek-flow?date=${DATE}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`UW ${ticker}: HTTP ${res.status}`);
  const body = await res.json();
  return body.data ?? [];
}

function summarize(ticks, field) {
  const sorted = [...ticks].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  let cum = 0;
  let cumMax = -Infinity;
  let cumMin = Infinity;
  for (const t of sorted) {
    const v = Number.parseFloat(t[field]);
    if (!Number.isFinite(v)) continue;
    cum += v;
    if (cum > cumMax) cumMax = cum;
    if (cum < cumMin) cumMin = cum;
  }
  return { cum_eod: cum, cum_max: cumMax, cum_min: cumMin };
}

const fmt = (n) =>
  Number.isFinite(n)
    ? n.toLocaleString('en-US', {
        maximumFractionDigits: 0,
        signDisplay: 'auto',
      })
    : '—';

const rows = [];
for (const ticker of ['SPY', 'QQQ']) {
  const ticks = await fetchUw(ticker);
  for (const field of ['otm_dir_delta_flow', 'otm_dir_vega_flow']) {
    const s = summarize(ticks, field);
    rows.push({
      panel: `${ticker} ${field === 'otm_dir_delta_flow' ? 'OTM Dir Delta' : 'OTM Dir Vega'}`,
      ticks: ticks.length,
      cum_end: fmt(s.cum_eod),
      cum_max: fmt(s.cum_max),
      cum_min: fmt(s.cum_min),
    });
  }
}

console.log(
  `Cumulative trajectory on ${DATE} (live UW API, post-reconciliation):\n`,
);
console.table(rows);
