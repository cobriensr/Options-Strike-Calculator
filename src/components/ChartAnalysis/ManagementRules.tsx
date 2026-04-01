import { theme } from '../../themes';
import BulletList from './BulletList';
import Collapsible from './Collapsible';
import type { AnalysisResult } from './types';

interface Props {
  readonly managementRules: NonNullable<AnalysisResult['managementRules']>;
}

export default function ManagementRules({ managementRules }: Props) {
  return (
    <Collapsible title="Position Management Rules" color={theme.caution}>
      <div className="grid gap-1.5">
        {managementRules.profitTarget && (
          <div className="text-[11px] leading-relaxed">
            <span className="font-semibold" style={{ color: theme.green }}>
              Profit target:{' '}
            </span>
            <span className="text-secondary">
              {managementRules.profitTarget}
            </span>
          </div>
        )}
        {managementRules.stopConditions &&
          managementRules.stopConditions.length > 0 && (
            <div>
              <span
                className="text-[10px] font-semibold"
                style={{ color: theme.red }}
              >
                Stop conditions:
              </span>
              <BulletList
                defaultColor={theme.textMuted}
                items={managementRules.stopConditions}
                icon={'\u26D4'}
                color={theme.red}
              />
            </div>
          )}
        {managementRules.timeRules && (
          <div className="text-[11px] leading-relaxed">
            <span className="font-semibold" style={{ color: theme.caution }}>
              Time rule:{' '}
            </span>
            <span className="text-secondary">{managementRules.timeRules}</span>
          </div>
        )}
        {managementRules.flowReversalSignal && (
          <div className="text-[11px] leading-relaxed">
            <span className="font-semibold" style={{ color: theme.caution }}>
              Flow reversal:{' '}
            </span>
            <span className="text-secondary">
              {managementRules.flowReversalSignal}
            </span>
          </div>
        )}
      </div>
    </Collapsible>
  );
}
