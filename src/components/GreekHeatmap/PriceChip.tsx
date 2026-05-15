/**
 * Neutral price chip for the Greek Heatmap section header.
 *
 * Renders the selected ticker's current underlying price as a small
 * "TICKER $PRICE" pill. Neutral styling — does not convey direction;
 * that's the regime chip's job.
 */

interface PriceChipProps {
  ticker: string;
  price: number | null;
}

export function PriceChip({ ticker, price }: PriceChipProps) {
  const display = price === null ? '—' : `$${price.toFixed(2)}`;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-neutral-700 bg-neutral-900/60 px-2.5 py-1 text-xs font-medium text-neutral-200"
      aria-label={`${ticker} current price ${display}`}
    >
      <span className="text-neutral-400">{ticker}</span>
      <span className="tabular-nums">{display}</span>
    </span>
  );
}
