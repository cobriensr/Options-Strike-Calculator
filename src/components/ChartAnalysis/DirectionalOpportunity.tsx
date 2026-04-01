import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import BulletList from './BulletList';
import Collapsible from './Collapsible';
import type { AnalysisResult } from './types';
import { confidenceColor } from './analysis-helpers';

interface Props {
  readonly directionalOpportunity: NonNullable<
    AnalysisResult['directionalOpportunity']
  >;
}

export default function DirectionalOpportunity({
  directionalOpportunity,
}: Props) {
  const dirColor =
    directionalOpportunity.direction === 'LONG CALL' ? theme.green : theme.red;

  return (
    <Collapsible title="Directional Opportunity" color={dirColor} defaultOpen>
      <div className="grid gap-2">
        {/* Header: direction + confidence + 14 DTE ATM */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded px-2 py-0.5 text-[11px] font-bold"
            style={{
              backgroundColor: tint(dirColor, '30'),
              color: dirColor,
            }}
          >
            {directionalOpportunity.direction}
          </span>
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-bold"
            style={{
              backgroundColor: tint(
                confidenceColor(directionalOpportunity.confidence),
                '18',
              ),
              color: confidenceColor(directionalOpportunity.confidence),
            }}
          >
            {directionalOpportunity.confidence}
          </span>
          <span
            className="text-[10px] font-semibold"
            style={{ color: theme.textMuted }}
          >
            14 DTE ATM
          </span>
        </div>

        {/* Reasoning */}
        <div className="text-secondary text-[11px] leading-relaxed">
          {directionalOpportunity.reasoning}
        </div>

        {/* Entry timing + Stop + Target */}
        <div className="grid gap-1.5">
          <div className="text-[11px] leading-relaxed">
            <span className="font-semibold" style={{ color: theme.accent }}>
              Entry:{' '}
            </span>
            <span className="text-secondary">
              {directionalOpportunity.entryTiming}
            </span>
          </div>
          <div className="text-[11px] leading-relaxed">
            <span className="font-semibold" style={{ color: theme.red }}>
              Stop:{' '}
            </span>
            <span className="text-secondary">
              {directionalOpportunity.stopLoss}
            </span>
          </div>
          <div className="text-[11px] leading-relaxed">
            <span className="font-semibold" style={{ color: theme.green }}>
              Target:{' '}
            </span>
            <span className="text-secondary">
              {directionalOpportunity.profitTarget}
            </span>
          </div>
        </div>

        {/* Key Levels */}
        {(directionalOpportunity.keyLevels.support ||
          directionalOpportunity.keyLevels.resistance ||
          directionalOpportunity.keyLevels.vwap) && (
          <div
            className="rounded-md p-2"
            style={{
              backgroundColor: tint(theme.accent, '0C'),
              border: `1px solid ${tint(theme.accent, '20')}`,
            }}
          >
            <div
              className="mb-1 text-[10px] font-bold tracking-wider uppercase"
              style={{ color: theme.accent }}
            >
              Key Levels
            </div>
            <div className="grid gap-1">
              {directionalOpportunity.keyLevels.support && (
                <div className="text-[10px]">
                  <span
                    className="font-semibold"
                    style={{ color: theme.green }}
                  >
                    Support:{' '}
                  </span>
                  <span className="text-secondary">
                    {directionalOpportunity.keyLevels.support}
                  </span>
                </div>
              )}
              {directionalOpportunity.keyLevels.resistance && (
                <div className="text-[10px]">
                  <span className="font-semibold" style={{ color: theme.red }}>
                    Resistance:{' '}
                  </span>
                  <span className="text-secondary">
                    {directionalOpportunity.keyLevels.resistance}
                  </span>
                </div>
              )}
              {directionalOpportunity.keyLevels.vwap && (
                <div className="text-[10px]">
                  <span
                    className="font-semibold"
                    style={{ color: theme.caution }}
                  >
                    VWAP:{' '}
                  </span>
                  <span className="text-secondary">
                    {directionalOpportunity.keyLevels.vwap}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Confirming Signals */}
        {directionalOpportunity.signals.length > 0 && (
          <div>
            <div
              className="mb-0.5 text-[10px] font-bold uppercase"
              style={{ color: theme.textMuted }}
            >
              Confirming Signals
            </div>
            <BulletList
              defaultColor={theme.textMuted}
              items={directionalOpportunity.signals}
              icon={'\u2713'}
              color={dirColor}
            />
          </div>
        )}
      </div>
    </Collapsible>
  );
}
