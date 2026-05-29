/**
 * Live probe: where does zero_gamma (and the other scalars spec'd on
 * orderflow_response/basic_response/majors_response) ACTUALLY appear in the
 * live GexBot payloads? We've disproven orderflow + state/gamma_zero from the
 * DB. This hits the endpoints we do NOT capture — the non-maxchange `classic`
 * basic_response and the `/majors` endpoint — to find zero_gamma's real home.
 *
 * Read-only authenticated GETs (a service we already poll 240×/min).
 * Run: npx tsx scripts/_probe-gexbot-live-endpoints.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

const BASE = 'https://api.gex.bot/v2';
const KEY = process.env.GEXBOT_API_KEY!;
const TOKEN = KEY.startsWith('gexbot_custom_') ? KEY : `gexbot_custom_${KEY}`;

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      'User-Agent': 'strike-calculator/1.0 (spec-probe)',
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function summarize(label: string, status: number, body: unknown) {
  console.log(`\n── ${label}  [HTTP ${status}]`);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    console.log(`   keys: ${keys.join(', ')}`);
    for (const f of [
      'zero_gamma',
      'sum_gex_vol',
      'sum_gex_oi',
      'delta_risk_reversal',
    ]) {
      if (f in obj) console.log(`   ✓ ${f} = ${JSON.stringify(obj[f])}`);
    }
  } else {
    console.log(`   body: ${JSON.stringify(body).slice(0, 300)}`);
  }
}

(async () => {
  if (!KEY) {
    console.error('GEXBOT_API_KEY not set');
    process.exit(1);
  }
  const probes: Array<[string, string]> = [
    ['SPX orderflow/orderflow', '/SPX/orderflow/orderflow'],
    ['SPX classic/gex_zero (basic, non-maxchange)', '/SPX/classic/gex_zero'],
    ['SPX classic/gex_full (basic, non-maxchange)', '/SPX/classic/gex_full'],
    ['SPX classic/gex_zero/majors', '/SPX/classic/gex_zero/majors'],
    ['SPX state/gex_zero/majors', '/SPX/state/gex_zero/majors'],
  ];
  for (const [label, path] of probes) {
    try {
      const { status, body } = await get(path);
      summarize(label, status, body);
    } catch (e) {
      console.log(`\n── ${label}  ERR ${(e as Error).message}`);
    }
  }
  console.log('\ndone.');
})();
