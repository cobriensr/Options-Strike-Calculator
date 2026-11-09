/**
 * Preloaded (`node --import`) by greek-nope-backfill.cli.test.mjs to run the
 * three backfill scripts (backfill-greek-flow-etf.mjs,
 * backfill-greek-flow-etf-0dte.mjs, backfill-nope.mjs) end to end with no
 * network: it replaces the global fetch.
 *
 *   - A request to Unusual Whales gets a canned answer in the shape of the
 *     endpoint the script asks for: three greek-flow ticks, an expiry-breakdown
 *     that lists the requested date, or four NOPE rows (three valid, one with
 *     stock_vol 0 that the script must skip).
 *   - Any other request is the Neon HTTP driver talking to the database. A
 *     statement that writes (WITH ... or INSERT ...) is written to stderr as
 *     `sql <parameter count> <last parameter>`: the last parameter is the
 *     writer name the logged statement binds after the row values. STUB_COLS
 *     is the number of columns a row binds. Other statements (the 0DTE
 *     script's "already populated?" check) get no rows. STUB_SQL picks the
 *     answer to a write:
 *       ok         one inserted row per row sent (the log insert returned is_first = true)
 *       updated    one changed row per row sent (is_first = false)
 *       unchanged  no rows (the guard skipped every row)
 *       error      a missing-table error, as when the revision log table does
 *                  not exist
 *
 * Test support only: it is never imported by a script.
 */

const flow = (minute) => String(100 + minute);
const greekTick = (minute) => ({
  timestamp: `2026-03-24T14:0${minute}:00Z`,
  dir_vega_flow: flow(minute),
  otm_dir_vega_flow: flow(minute),
  total_vega_flow: flow(minute),
  otm_total_vega_flow: flow(minute),
  dir_delta_flow: flow(minute),
  otm_dir_delta_flow: flow(minute),
  total_delta_flow: flow(minute),
  otm_total_delta_flow: flow(minute),
  transactions: 7,
  volume: 9,
});
const nopeRow = (minute, stockVol = 1000) => ({
  timestamp: `2026-03-24T14:0${minute}:00Z`,
  call_vol: 10,
  put_vol: 20,
  stock_vol: stockVol,
  call_delta: '1.5',
  put_delta: '-2.5',
  call_fill_delta: '3.5',
  put_fill_delta: '-4.5',
  nope: `-0.00064${minute}`,
  nope_fill: '-0.000434',
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const BOOLEAN_FIELD = {
  name: 'inserted',
  dataTypeID: 16,
  tableID: 0,
  columnID: 0,
  dataTypeSize: 1,
  dataTypeModifier: -1,
  format: 'text',
};

// The only two hosts a script run here may reach: Unusual Whales (canned), and
// the Neon HTTP driver for the test's DATABASE_URL (`...@db.invalid/db`), which
// swaps the first host label for `api` and so posts to https://api.invalid/sql.
// Anything else would be a real network call from a test: fail it loudly.
const ALLOWED_HOSTS = new Set(['api.unusualwhales.com', 'api.invalid']);

globalThis.fetch = async (url, init) => {
  const text = String(url);
  const { host } = new URL(text);
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`greek-nope-backfill-stub: unexpected host ${host}`);
  }
  if (text.includes('api.unusualwhales.com')) {
    if (text.includes('/nope')) {
      return json({
        data: [nopeRow(0), nopeRow(1), nopeRow(2), nopeRow(3, 0)],
      });
    }
    if (text.includes('/expiry-breakdown')) {
      const date = new URL(text).searchParams.get('date');
      return json({ data: [{ expires: date }] });
    }
    return json({ data: [0, 1, 2].map(greekTick) });
  }

  const { query = '', params = [] } = JSON.parse(String(init?.body ?? '{}'));
  if (!/^\s*(WITH|INSERT)/i.test(query)) {
    return json({ command: 'SELECT', rowCount: 0, rows: [], fields: [] });
  }
  process.stderr.write(`sql ${params.length} ${params.at(-1)}\n`);
  const mode = process.env.STUB_SQL;
  if (mode === 'error') {
    return json(
      {
        message: 'relation "revisions" does not exist',
        code: '42P01',
      },
      400,
    );
  }
  const sent = Math.floor(params.length / Number(process.env.STUB_COLS));
  const rows = mode === 'unchanged' ? 0 : sent;
  const flag = mode === 'updated' ? 'f' : 't';
  return json({
    command: 'INSERT',
    rowCount: rows,
    rows: Array.from({ length: rows }, () => [flag]),
    fields: [BOOLEAN_FIELD],
  });
};
