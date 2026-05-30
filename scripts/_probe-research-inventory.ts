import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

type Row = Record<string, unknown>;
const j = (x: unknown) => JSON.stringify(x);

async function safe(label: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    console.log(`\n=== ${label} ===`);
    console.log(j(r));
  } catch (e) {
    console.log(`\n=== ${label} === ERROR: ${(e as Error).message}`);
  }
}

(async () => {
  // ---------- PART A: dealer state ----------
  await safe('gexbot_snapshots coverage', async () => {
    const r = (await sql`
      SELECT count(*) n, min(captured_at) ts0, max(captured_at) ts1,
             count(DISTINCT (captured_at AT TIME ZONE 'America/New_York')::date) ndays,
             count(DISTINCT ticker) ntickers
      FROM gexbot_snapshots`) as Row[];
    const perday = (await sql`
      SELECT (captured_at AT TIME ZONE 'America/New_York')::date d, count(*) n
      FROM gexbot_snapshots GROUP BY 1 ORDER BY 1`) as Row[];
    const spx = (await sql`
      SELECT count(*) n_spx,
        count(*) FILTER (WHERE zero_gamma IS NOT NULL) nz,
        count(*) FILTER (WHERE net_put_dex IS NOT NULL) ndex,
        count(*) FILTER (WHERE one_cvroflow IS NOT NULL) ncvr
      FROM gexbot_snapshots WHERE ticker IN ('SPX','SPXW','_SPX')`) as Row[];
    const tickers =
      (await sql`SELECT DISTINCT ticker FROM gexbot_snapshots ORDER BY 1`) as Row[];
    return {
      summary: r[0],
      spx_subset: spx[0],
      tickers: tickers.map((t) => t.ticker),
      perday,
    };
  });

  await safe('gexbot_api_capture coverage', async () => {
    const r = (await sql`
      SELECT count(*) n, min(captured_at) ts0, max(captured_at) ts1,
             count(DISTINCT (captured_at AT TIME ZONE 'America/New_York')::date) ndays
      FROM gexbot_api_capture`) as Row[];
    const cats =
      (await sql`SELECT endpoint, category, count(*) n FROM gexbot_api_capture GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`) as Row[];
    return { summary: r[0], categories: cats };
  });

  await safe('spot_exposures coverage', async () => {
    const r = (await sql`
      SELECT count(*) n, min(date) d0, max(date) d1, count(DISTINCT date) ndays,
             count(DISTINCT ticker) ntickers
      FROM spot_exposures`) as Row[];
    const spx = (await sql`
      SELECT count(*) n, min(date) d0, max(date) d1, count(DISTINCT date) ndays
      FROM spot_exposures WHERE ticker='SPX'`) as Row[];
    const perday = (await sql`
      SELECT date d, count(*) n FROM spot_exposures WHERE ticker='SPX' GROUP BY 1 ORDER BY 1 DESC LIMIT 12`) as Row[];
    return { all: r[0], spx: spx[0], recent_perday_spx: perday };
  });

  await safe('ws_gex_strike_expiry coverage', async () => {
    const r = (await sql`
      SELECT count(*) n, min(ts_minute) ts0, max(ts_minute) ts1,
             count(DISTINCT (ts_minute AT TIME ZONE 'America/New_York')::date) ndays,
             count(DISTINCT ticker) ntickers
      FROM ws_gex_strike_expiry`) as Row[];
    const tickers =
      (await sql`SELECT ticker, count(*) n FROM ws_gex_strike_expiry GROUP BY 1 ORDER BY 2 DESC LIMIT 15`) as Row[];
    return { summary: r[0], top_tickers: tickers };
  });

  await safe('periscope_snapshots coverage', async () => {
    const r = (await sql`
      SELECT count(*) n, min(captured_at) ts0, max(captured_at) ts1,
             count(DISTINCT (captured_at AT TIME ZONE 'America/New_York')::date) ndays,
             count(DISTINCT expiry) nexpiry
      FROM periscope_snapshots`) as Row[];
    const panels =
      (await sql`SELECT panel, count(*) n FROM periscope_snapshots GROUP BY 1`) as Row[];
    const perday = (await sql`
      SELECT (captured_at AT TIME ZONE 'America/New_York')::date d, count(*) n,
             count(DISTINCT captured_at) nslices
      FROM periscope_snapshots GROUP BY 1 ORDER BY 1 DESC LIMIT 10`) as Row[];
    return { summary: r[0], panels, recent_perday: perday };
  });

  await safe('flow_data sources coverage', async () => {
    const r = (await sql`
      SELECT source, count(*) n, min(date) d0, max(date) d1,
             count(DISTINCT date) ndays
      FROM flow_data GROUP BY 1 ORDER BY 2 DESC`) as Row[];
    return r;
  });

  await safe('greek_exposure_strike coverage', async () => {
    const r = (await sql`
      SELECT count(*) n, min(date) d0, max(date) d1, count(DISTINCT date) ndays
      FROM greek_exposure_strike`) as Row[];
    return r[0];
  });

  // ---------- PART B: outcomes / range / regime ----------
  await safe('index_candles_1m coverage', async () => {
    const r = (await sql`
      SELECT symbol, count(*) n, min(date) d0, max(date) d1, count(DISTINCT date) ndays
      FROM index_candles_1m GROUP BY 1 ORDER BY 2 DESC`) as Row[];
    const perday = (await sql`
      SELECT date d, count(*) n FROM index_candles_1m WHERE symbol='SPX' GROUP BY 1 ORDER BY 1 DESC LIMIT 8`) as Row[];
    return { by_symbol: r, recent_spx_perday: perday };
  });

  await safe('vol_realized coverage', async () => {
    const r =
      (await sql`SELECT count(*) n, min(date) d0, max(date) d1 FROM vol_realized`) as Row[];
    const sample =
      (await sql`SELECT * FROM vol_realized ORDER BY date DESC LIMIT 1`) as Row[];
    return { summary: r[0], latest: sample[0] };
  });

  await safe('vol_term_structure coverage', async () => {
    const r =
      (await sql`SELECT count(*) n, min(date) d0, max(date) d1, count(DISTINCT date) ndays FROM vol_term_structure`) as Row[];
    return r[0];
  });

  await safe('futures_bars coverage', async () => {
    const r = (await sql`
      SELECT symbol, count(*) n, min(ts) ts0, max(ts) ts1,
             count(DISTINCT (ts AT TIME ZONE 'America/New_York')::date) ndays
      FROM futures_bars GROUP BY 1 ORDER BY 2 DESC`) as Row[];
    return r;
  });

  // VIX in DB? check overnight_gap_features or a vix table
  await safe('vix-bearing tables (training_features vix cols)', async () => {
    const r = (await sql`
      SELECT count(*) n, min(date) d0, max(date) d1,
        count(*) FILTER (WHERE vix IS NOT NULL) nvix,
        count(*) FILTER (WHERE vix9d IS NOT NULL) nvix9d,
        count(*) FILTER (WHERE vvix IS NOT NULL) nvvix
      FROM training_features`) as Row[];
    return r[0];
  });

  // ---------- list all tables for completeness ----------
  await safe('ALL tables w/ approx rows', async () => {
    const r = (await sql`
      SELECT relname tbl, n_live_tup rows
      FROM pg_stat_user_tables
      ORDER BY relname`) as Row[];
    return r;
  });
})();
