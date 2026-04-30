import { useEffect, useState } from 'react';
import { whaleBannerStore, type WhaleBannerEntry } from './banner-store.js';
import { WHALE_TYPE_LABELS } from './types.js';

export function WhaleBanner() {
  const [entries, setEntries] = useState<WhaleBannerEntry[]>([]);

  useEffect(() => whaleBannerStore.subscribe(setEntries), []);

  if (entries.length === 0) return null;

  return (
    <div
      className="fixed right-4 top-20 z-50 flex w-80 flex-col gap-2"
      role="alert"
      aria-live="polite"
    >
      {entries.map((e) => {
        const w = e.whale;
        const cp = w.option_type === 'call' ? 'C' : 'P';
        const dirIcon = w.direction === 'bullish' ? '▲' : '▼';
        const bgClasses =
          w.direction === 'bullish'
            ? 'border-green-500/60 bg-green-950/95 text-green-100'
            : 'border-red-500/60 bg-red-950/95 text-red-100';
        return (
          <div
            key={e.id}
            className={`rounded-lg border p-3 shadow-lg backdrop-blur ${bgClasses}`}
            data-testid={`whale-banner-${e.id}`}
          >
            <div className="flex items-start gap-2">
              <span className="text-lg">{dirIcon}</span>
              <div className="flex-1">
                <div className="text-sm font-bold">
                  {w.ticker} {w.strike.toFixed(0)}
                  {cp}{' '}
                  <span className="text-xs font-normal opacity-75">
                    Type {w.whale_type} — {WHALE_TYPE_LABELS[w.whale_type]}
                  </span>
                </div>
                <div className="text-xs opacity-85">
                  {w.side} ${(w.total_premium / 1_000_000).toFixed(1)}M ·{' '}
                  {w.trade_count} trades · {w.dte}d
                </div>
                {w.underlying_price != null && (
                  <div className="mt-0.5 text-[10px] opacity-65">
                    spot {w.underlying_price.toFixed(2)} · target{' '}
                    {w.strike.toFixed(0)}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => whaleBannerStore.dismiss(e.id)}
                className="text-xs opacity-50 hover:opacity-100"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
