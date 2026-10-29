/**
 * Zod schemas for the spread-leg fields that /api/lottery-finder and
 * /api/silent-boom-feed return (spec docs/superpowers/specs/2026-10-28-
 * classifier-replacement-design.md, "Badge"). Shared by both feed hooks.
 */

import { z } from 'zod';
import type {
  AnchorLegKind,
  SpreadLeg,
  SpreadShape,
} from '../types/spread-legs.js';

// Mapped objects, so adding a kind or shape to the shared union fails to
// compile until it is listed here, instead of rejecting the feed at runtime.
const ANCHOR_LEG_KINDS: { [K in AnchorLegKind]: K } = {
  single: 'single',
  multi_leg: 'multi_leg',
  stock_tied: 'stock_tied',
};
const SPREAD_SHAPES: { [S in SpreadShape]: S } = {
  vertical: 'vertical',
  calendar: 'calendar',
  diagonal: 'diagonal',
  straddle: 'straddle',
  combo: 'combo',
  butterfly: 'butterfly',
  three_leg: 'three_leg',
  four_leg: 'four_leg',
  four_leg_multi_expiry: 'four_leg_multi_expiry',
  complex: 'complex',
  unpaired: 'unpaired',
  other: 'other',
};

/** Optional and nullable: rows from before migration #197 have none. */
export const anchorLegKindSchema = z.enum(ANCHOR_LEG_KINDS).nullish();

export const spreadShapeSchema = z.enum(SPREAD_SHAPES);

export const spreadLegSchema = z.object({
  optionType: z.enum(['C', 'P']),
  strike: z.number(),
  expiry: z.string(),
  size: z.number(),
  price: z.number(),
  tradeCode: z.string().nullable(),
}) satisfies z.ZodType<SpreadLeg>;
