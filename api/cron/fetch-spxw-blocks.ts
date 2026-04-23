/**
 * GET /api/cron/fetch-spxw-blocks
 *
 * Captures SPXW institutional floor-brokered block trades for the
 * regime tracker + opening-positioning tracker. Two-pass enumeration
 * covers both signal classes in a single cron:
 *
 *   Pass 1 (ceiling track) — 180-300 DTE, 5-25% OTM, call/put
 *   Pass 2 (opening_atm)   — 0-7 DTE, ≤3% OTM, call/put
 *
 * For each target contract we pull the last 50 trades via
 * /api/option-contract/{id}/flow with min_premium=25000, filter to
 * mfsl/cbmo/slft condition codes and size ≥ 50, classify program_track
 * at insert time, and upsert into institutional_blocks (trade_id PK
 * dedupes across runs).
 *
 * Schedule: 4x per trading day (08:45, 10:45, 13:45, 15:45 CT). The
 * early 08:45 CT poll is critical — it catches opening-window blocks
 * before the 50-trade window rolls over on heavily-traded contracts.
 *
 * Source spec: docs/institutional-program-tracker.md (v2).
 * Research base: docs/0dte-findings.md (mfsl implications).
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronGuard, uwFetch, withRetry } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// ── Constants ───────────────────────────────────────────────

const TARGET_CONDITIONS = new Set(['mfsl', 'cbmo', 'slft']);
const MIN_BLOCK_SIZE = 50;
const MIN_BLOCK_PREMIUM = 25_000;

// Two enumeration passes — each has its own DTE + moneyness filter.
// Thresholds + rationale are in docs/institutional-program-tracker.md.
const ENUMERATION_PASSES = [
  {
    name: 'ceiling' as const,
    minDte: 180,
    maxDte: 300,
    mnyMin: 0.05,
    mnyMax: 0.25,
    maxContracts: 40,
  },
  {
    name: 'opening_atm' as const,
    minDte: 0,
    maxDte: 7,
    mnyMin: 0,
    mnyMax: 0.03,
    maxContracts: 20,
  },
];

// Window for opening_atm classification: 13:30-14:30 UTC = 08:30-09:30 CT.
const OPEN_START_UTC_MIN = 13 * 60 + 30;
const OPEN_END_UTC_MIN = 14 * 60 + 30;

// ── Types ───────────────────────────────────────────────────

interface UwOptionContract {
  option_symbol: string;
  strike: string;
  option_type: 'call' | 'put';
  expiry: string;
  volume?: number;
  open_interest?: number;
}

interface UwOptionTrade {
  id: string;
  executed_at: string;
  option_chain_id: string;
  strike: string;
  option_type: 'call' | 'put';
  expiry: string;
  size: number;
  price: string;
  premium: string;
  underlying_price: string;
  upstream_condition_detail?: string;
  tags?: string[];
  exchange?: string;
  open_interest?: number;
  delta?: string;
  gamma?: string;
  implied_volatility?: string;
  canceled?: boolean;
}

// ── Classification ──────────────────────────────────────────

export function classifyTrack(
  dte: number,
  moneynessPct: number,
  executedAtUtc: string,
): 'ceiling' | 'opening_atm' | 'other' {
  const absMny = Math.abs(moneynessPct);
  if (dte >= 180 && dte <= 300 && absMny >= 0.05 && absMny <= 0.25) {
    return 'ceiling';
  }
  const executedAt = new Date(executedAtUtc);
  const utcMinutes = executedAt.getUTCHours() * 60 + executedAt.getUTCMinutes();
  if (
    dte >= 0 &&
    dte <= 7 &&
    absMny <= 0.03 &&
    utcMinutes >= OPEN_START_UTC_MIN &&
    utcMinutes <= OPEN_END_UTC_MIN
  ) {
    return 'opening_atm';
  }
  return 'other';
}

function inferSide(tags?: string[]): 'ask' | 'bid' | null {
  if (!tags) return null;
  if (tags.includes('ask_side')) return 'ask';
  if (tags.includes('bid_side')) return 'bid';
  return null;
}

// ── UW fetchers ─────────────────────────────────────────────

async function fetchContracts(apiKey: string): Promise<UwOptionContract[]> {
  return withRetry(() =>
    uwFetch<UwOptionContract>(apiKey, `/stock/SPXW/option-contracts?limit=500`),
  );
}

async function fetchContractFlow(
  apiKey: string,
  optionSymbol: string,
): Promise<UwOptionTrade[]> {
  // Per-contract failures shouldn't abort the whole run.
  try {
    return await uwFetch<UwOptionTrade>(
      apiKey,
      `/option-contract/${optionSymbol}/flow` +
        `?min_premium=${MIN_BLOCK_PREMIUM}&limit=50`,
    );
  } catch (err) {
    Sentry.captureException(err, {
      tags: { cron: 'fetch-spxw-blocks', contract: optionSymbol },
    });
    return [];
  }
}

// ── Main handler ────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey } = guard;

  try {
    const allContracts = await fetchContracts(apiKey);
    if (!allContracts.length) {
      logger.warn('fetch-spxw-blocks: no contracts returned from UW');
      return res.status(200).json({ ok: true, contracts: 0, blocks: 0 });
    }

    // Derive dte + moneyness using first trade's underlying_price, which
    // we only discover after fetching flow. For enumeration filtering we
    // use the spot from an arbitrary contract with a known underlying_
    // price — easier: filter just by DTE + option_symbol, then compute
    // moneyness inside the flow loop when we get a real underlying.
    //
    // In practice UW's option-contracts response doesn't carry a fresh
    // spot reference, so we approximate moneyness from the most-recent
    // SPXW contract that HAS priced — i.e., we defer the moneyness
    // filter to the post-fetch classification step. This is cheaper
    // than a separate spot-fetch call and keeps the cron stateless.
    const todayMs = Date.now();
    const withDte = allContracts
      .map((c) => {
        const expiryMs = Date.parse(`${c.expiry}T00:00:00Z`);
        const dte = Math.floor((expiryMs - todayMs) / 86_400_000);
        return { ...c, dte };
      })
      .filter((c) => Number.isFinite(c.dte));

    let totalBlocks = 0;
    let totalInserted = 0;
    let contractsPolled = 0;

    const sql = getDb();

    for (const pass of ENUMERATION_PASSES) {
      // Pre-filter by DTE window only (moneyness requires spot; applied post-fetch).
      const candidates = withDte
        .filter((c) => c.dte >= pass.minDte && c.dte <= pass.maxDte)
        .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
        .slice(0, pass.maxContracts);

      for (const contract of candidates) {
        contractsPolled++;
        const trades = await fetchContractFlow(apiKey, contract.option_symbol);
        if (!trades.length) continue;

        // Per-contract: take the fresh spot off the newest trade for
        // moneyness classification.
        const freshSpot = Number.parseFloat(trades[0]!.underlying_price);
        const strikeNum = Number.parseFloat(contract.strike);
        const mny = (strikeNum - freshSpot) / freshSpot;

        // Enforce the pass's moneyness window now that we have spot.
        // Tolerate a bit of slack because the contract list is slightly
        // stale.
        if (
          Math.abs(mny) < pass.mnyMin ||
          Math.abs(mny) > pass.mnyMax + 0.02
        ) {
          continue;
        }

        const blocks = trades.filter(
          (t) =>
            !t.canceled &&
            t.upstream_condition_detail &&
            TARGET_CONDITIONS.has(t.upstream_condition_detail.toLowerCase()) &&
            t.size >= MIN_BLOCK_SIZE,
        );
        totalBlocks += blocks.length;

        for (const b of blocks) {
          const strike = Number.parseFloat(b.strike);
          const spot = Number.parseFloat(b.underlying_price);
          const moneynessPct = (strike - spot) / spot;
          const expiryMs = Date.parse(`${b.expiry}T00:00:00Z`);
          const executedMs = Date.parse(b.executed_at);
          const dte = Math.floor((expiryMs - executedMs) / 86_400_000);
          const track = classifyTrack(dte, moneynessPct, b.executed_at);
          const side = inferSide(b.tags);

          await sql`
            INSERT INTO institutional_blocks (
              trade_id, executed_at, option_chain_id, strike, option_type,
              expiry, dte, size, price, premium, side, condition, exchange,
              underlying_price, moneyness_pct, open_interest, delta, gamma,
              iv, program_track
            ) VALUES (
              ${b.id}, ${b.executed_at}, ${b.option_chain_id}, ${strike},
              ${b.option_type}, ${b.expiry}, ${dte}, ${b.size},
              ${Number.parseFloat(b.price)}, ${Number.parseFloat(b.premium)},
              ${side},
              ${b.upstream_condition_detail!.toLowerCase()},
              ${b.exchange ?? null}, ${spot}, ${moneynessPct},
              ${b.open_interest ?? null},
              ${b.delta ? Number.parseFloat(b.delta) : null},
              ${b.gamma ? Number.parseFloat(b.gamma) : null},
              ${
                b.implied_volatility
                  ? Number.parseFloat(b.implied_volatility)
                  : null
              },
              ${track}
            )
            ON CONFLICT (trade_id) DO NOTHING
          `;
          totalInserted++;
        }
      }
    }

    logger.info(
      {
        contracts_polled: contractsPolled,
        blocks_captured: totalBlocks,
        db_upserts: totalInserted,
      },
      'fetch-spxw-blocks complete',
    );

    res.status(200).json({
      ok: true,
      contracts: contractsPolled,
      blocks: totalBlocks,
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { cron: 'fetch-spxw-blocks' } });
    res.status(500).json({ error: String(err) });
  }
}
