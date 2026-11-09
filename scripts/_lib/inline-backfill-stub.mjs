/**
 * Preloaded (`node --import`) by flow-data-backfill.test.mjs to run the two
 * inline backfill scripts (backfill-zero-dte-flow.mjs, backfill-greek-flow.mjs)
 * end to end with no network: it replaces the global fetch.
 *
 *   - A request to Unusual Whales gets a canned answer: ten one-minute ticks in
 *     two 5-minute windows, in the shape of the endpoint the script asks for.
 *   - Any other request is the Neon HTTP driver talking to the database.
 *     STUB_SQL=ok answers like Postgres (one row per inserted row);
 *     STUB_SQL=error answers a missing-table error, as when the revision log
 *     table does not exist. Each such request is written to stderr as
 *     `sql <parameter count> <last parameter>`: the last parameter is the
 *     writer name the logged statement binds after the row values.
 *
 * Test support only: it is never imported by a script.
 */

const tick = (minute) => ({
  timestamp: `2026-03-24T14:0${minute}:00Z`,
  net_call_premium: String(1000 + minute),
  net_put_premium: String(-500 - minute),
  net_volume: String(10 + minute),
  total_delta_flow: String(2000 + minute),
  dir_delta_flow: String(-700 - minute),
  total_vega_flow: '1',
  volume: 50 + minute,
});
const TICKS = Array.from({ length: 10 }, (_, minute) => tick(minute));

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// The only two hosts a script run here may reach: Unusual Whales (canned), and
// the Neon HTTP driver for the test's DATABASE_URL (`...@db.invalid/db`), which
// swaps the first host label for `api` and so posts to https://api.invalid/sql.
// Anything else would be a real network call from a test: fail it loudly.
const ALLOWED_HOSTS = new Set(['api.unusualwhales.com', 'api.invalid']);

globalThis.fetch = async (url, init) => {
  const text = String(url);
  const { host } = new URL(text);
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`inline-backfill-stub: unexpected host ${host}`);
  }
  if (text.includes('api.unusualwhales.com')) {
    return text.includes('/net-flow/expiry')
      ? json({ data: [{ data: TICKS }] })
      : json({ data: TICKS });
  }
  const { params = [] } = JSON.parse(String(init?.body ?? '{}'));
  process.stderr.write(`sql ${params.length} ${params.at(-1)}\n`);
  if (process.env.STUB_SQL === 'error') {
    return json(
      {
        message: 'relation "flow_data_revisions" does not exist',
        code: '42P01',
      },
      400,
    );
  }
  // One row per inserted row (six values a row, then the writer).
  const rows = Math.floor(params.length / 6);
  return json({
    command: 'SELECT',
    rowCount: rows,
    rows: Array.from({ length: rows }, (_, i) => [String(i + 1)]),
    fields: [
      {
        name: 'id',
        dataTypeID: 23,
        tableID: 0,
        columnID: 0,
        dataTypeSize: 4,
        dataTypeModifier: -1,
        format: 'text',
      },
    ],
  });
};
