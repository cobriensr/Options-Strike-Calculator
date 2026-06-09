export type MoneynessOptionType = 'C' | 'P';

/** A usable spot is finite and strictly positive; otherwise null. */
export function usableSpot(spot: number | null | undefined): number | null {
  return spot != null && Number.isFinite(spot) && spot > 0 ? spot : null;
}

/**
 * Inclusive ATM boundary: an exactly-ATM fire (strike === spot) counts as OTM,
 * matching the row badges' `otmPct >= 0` convention. Caller MUST pass an
 * already-usable (finite, > 0) spot — get one from usableSpot() first.
 */
export function isOtm(
  optionType: MoneynessOptionType,
  strike: number,
  spot: number,
): boolean {
  return optionType === 'C' ? strike >= spot : strike <= spot;
}

/**
 * Signed %OTM against a (possibly unusable) spot: > 0 = OTM, < 0 = ITM,
 * 0 = exactly ATM (counts as OTM). Returns null when the spot is unusable.
 * INVARIANT: for any usable spot, (signedOtmPct(...) as number) >= 0 === isOtm(...).
 */
export function signedOtmPct(
  optionType: MoneynessOptionType,
  strike: number,
  spot: number | null | undefined,
): number | null {
  const s = usableSpot(spot);
  if (s == null) return null;
  const raw = (strike - s) / s;
  return optionType === 'C' ? raw : -raw;
}
