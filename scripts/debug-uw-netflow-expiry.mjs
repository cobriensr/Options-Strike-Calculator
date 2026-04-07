// scripts/debug-uw-netflow-expiry.mjs
// One-shot: dump today's raw /net-flow/expiry zero_dte index_only series
// so we can see whether net_put/call_premium are signed, cumulative,
// per-minute bars, or something else.

const UW_BASE = 'https://api.unusualwhales.com/api';
const apiKey = 'bba1c63b-7dd2-48bb-9dc6-1ebc734dbe5f';
if (!apiKey) {
  console.error('UW_API_KEY required');
  process.exit(1);
}

const res = await fetch(
  `${UW_BASE}/net-flow/expiry?expiration=zero_dte&tide_type=index_only`,
  { headers: { Authorization: `Bearer ${apiKey}` } },
);
const body = await res.json();
const ticks = body.data?.[0]?.data ?? [];

// Narrow to the opening-drop window (first ~60 minutes of session)
const firstHour = ticks.slice(0, 60);

console.log('ts                     npp(raw)   ncp(raw)    spx   vol');
for (const t of firstHour) {
  const ts = t.timestamp ?? '';
  const npp = Number.parseFloat(t.net_put_premium);
  const ncp = Number.parseFloat(t.net_call_premium);
  const spx = Number.parseFloat(t.underlying_price);
  console.log(
    `${ts}  ${(npp / 1e6).toFixed(2).padStart(8)}M  ${(ncp / 1e6).toFixed(2).padStart(8)}M  ${spx.toFixed(2).padStart(7)}  ${t.net_volume ?? ''}`,
  );
}

// Also print min/max/sign-flip diagnostics
const npps = ticks
  .map((t) => Number.parseFloat(t.net_put_premium))
  .filter(Number.isFinite);
const ncps = ticks
  .map((t) => Number.parseFloat(t.net_call_premium))
  .filter(Number.isFinite);
console.log(
  '\nnpp range:',
  Math.min(...npps).toExponential(2),
  '→',
  Math.max(...npps).toExponential(2),
);
console.log(
  'ncp range:',
  Math.min(...ncps).toExponential(2),
  '→',
  Math.max(...ncps).toExponential(2),
);
console.log(
  'npp went negative:',
  npps.some((v) => v < 0),
);
console.log(
  'ncp went negative:',
  ncps.some((v) => v < 0),
);
