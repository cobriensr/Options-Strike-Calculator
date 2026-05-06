/**
 * PlaybookView — compact rendering of the structured Periscope
 * playbook fields (bias + confidence badges, recommended / avoided
 * trade-type chips, key-level grid, expected dealer behavior, futures
 * plan).
 *
 * Used in two places:
 * - PeriscopeChat (fresh read after Claude returns)
 * - PeriscopeChatDetail (expanded past read in history)
 *
 * Returns null when EVERY playbook field is empty / null — keeps
 * legacy rows clean instead of rendering an empty card.
 */

import type {
  PeriscopeBias,
  PeriscopeConfidence,
  PeriscopeKeyLevels,
} from './types.js';

/**
 * Subset of PeriscopeStructuredFields covering the playbook surface
 * only. Defined locally rather than re-using the full structured-
 * fields type so callers only have to wire through what the playbook
 * actually renders (omits spot, cone, triggers, regime — those have
 * their own grid).
 */
export interface PlaybookFields {
  bias: PeriscopeBias | null;
  trade_types_recommended: string[];
  trade_types_avoided: string[];
  key_levels: PeriscopeKeyLevels | null;
  expected_dealer_behavior: string | null;
  confidence: PeriscopeConfidence | null;
  confidence_basis: string | null;
  futures_plan: string | null;
}

interface PlaybookViewProps {
  fields: PlaybookFields;
}

const fmtNum = (n: number | null) =>
  n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function biasBadgeClass(bias: PeriscopeBias | null): string {
  switch (bias) {
    case 'long-only':
      return 'bg-green-700/30 text-green-200 border-green-700/60';
    case 'short-only':
      return 'bg-red-700/30 text-red-200 border-red-700/60';
    case 'fade-only':
      return 'bg-amber-700/30 text-amber-200 border-amber-700/60';
    case 'two-sided':
      return 'bg-blue-700/30 text-blue-200 border-blue-700/60';
    case 'no-trade':
      return 'bg-slate-700/30 text-slate-300 border-slate-700/60';
    default:
      return 'bg-surface/60 text-muted border-edge';
  }
}

function confidenceBadgeClass(conf: PeriscopeConfidence | null): string {
  switch (conf) {
    case 'high':
      return 'bg-emerald-700/30 text-emerald-200 border-emerald-700/60';
    case 'medium':
      return 'bg-yellow-700/30 text-yellow-200 border-yellow-700/60';
    case 'low':
      return 'bg-zinc-700/30 text-zinc-300 border-zinc-700/60';
    default:
      return 'bg-surface/60 text-muted border-edge';
  }
}

export default function PlaybookView({ fields }: PlaybookViewProps) {
  const {
    bias,
    confidence,
    confidence_basis: confidenceBasis,
    trade_types_recommended: recommended,
    trade_types_avoided: avoided,
    key_levels: keyLevels,
    expected_dealer_behavior: expectedDealerBehavior,
    futures_plan: futuresPlan,
  } = fields;

  const hasAnything =
    bias != null ||
    confidence != null ||
    recommended.length > 0 ||
    avoided.length > 0 ||
    keyLevels != null ||
    (expectedDealerBehavior != null && expectedDealerBehavior.length > 0) ||
    (futuresPlan != null && futuresPlan.length > 0);

  if (!hasAnything) return null;

  return (
    <div className="border-edge bg-surface/60 flex flex-col gap-3 rounded-md border p-3 text-sm">
      {(bias != null || confidence != null) && (
        <div className="flex flex-wrap items-center gap-2">
          {bias != null && (
            <span
              className={`rounded border px-2 py-0.5 text-xs font-semibold tracking-wide uppercase ${biasBadgeClass(bias)}`}
            >
              {bias}
            </span>
          )}
          {confidence != null && (
            <span
              className={`rounded border px-2 py-0.5 text-xs font-medium tracking-wide uppercase ${confidenceBadgeClass(confidence)}`}
            >
              {confidence} confidence
            </span>
          )}
        </div>
      )}
      {confidenceBasis && (
        <p className="text-muted text-xs italic">{confidenceBasis}</p>
      )}
      {(recommended.length > 0 || avoided.length > 0) && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {recommended.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-muted text-[10px] tracking-wide uppercase">
                Recommended structures
              </span>
              <div className="flex flex-wrap gap-1">
                {recommended.map((t) => (
                  <span
                    key={`rec-${t}`}
                    className="rounded border border-green-700/60 bg-green-700/20 px-2 py-0.5 font-mono text-[11px] text-green-200"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
          {avoided.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-muted text-[10px] tracking-wide uppercase">
                Avoid
              </span>
              <div className="flex flex-wrap gap-1">
                {avoided.map((t) => (
                  <span
                    key={`avoid-${t}`}
                    className="rounded border border-red-700/60 bg-red-700/20 px-2 py-0.5 font-mono text-[11px] text-red-200"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {futuresPlan != null && futuresPlan.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-muted text-[10px] tracking-wide uppercase">
            Futures plan
          </span>
          <p className="text-secondary text-xs whitespace-pre-line">
            {futuresPlan}
          </p>
        </div>
      )}
      {keyLevels != null && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          <div className="flex flex-col">
            <span className="text-muted text-[10px] tracking-wide uppercase">
              γ floor
            </span>
            <span className="text-primary font-mono">
              {fmtNum(keyLevels.gamma_floor)}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted text-[10px] tracking-wide uppercase">
              γ ceiling
            </span>
            <span className="text-primary font-mono">
              {fmtNum(keyLevels.gamma_ceiling)}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted text-[10px] tracking-wide uppercase">
              Magnet
            </span>
            <span className="text-primary font-mono">
              {fmtNum(keyLevels.magnet)}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted text-[10px] tracking-wide uppercase">
              Charm zero
            </span>
            <span className="text-primary font-mono">
              {fmtNum(keyLevels.charm_zero)}
            </span>
          </div>
        </div>
      )}
      {expectedDealerBehavior && (
        <p className="text-secondary text-xs italic">
          {expectedDealerBehavior}
        </p>
      )}
    </div>
  );
}
