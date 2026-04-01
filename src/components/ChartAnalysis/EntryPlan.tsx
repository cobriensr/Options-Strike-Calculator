import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import BulletList from './BulletList';
import Collapsible from './Collapsible';
import type { AnalysisResult } from './types';
import { structureColor } from './analysis-helpers';

interface Props {
  readonly entryPlan: NonNullable<AnalysisResult['entryPlan']>;
  readonly defaultCollapsed: boolean;
}

export default function EntryPlan({ entryPlan, defaultCollapsed }: Props) {
  return (
    <Collapsible
      title="Entry Plan"
      color={theme.accent}
      defaultOpen={!defaultCollapsed}
    >
      <div className="grid gap-2">
        {(
          [
            [1, entryPlan.entry1],
            [2, entryPlan.entry2],
            [3, entryPlan.entry3],
          ] as const
        ).map(([num, entry]) => {
          if (!entry) return null;
          return (
            <div
              key={`entry-${num}`}
              className="bg-surface-alt flex items-start gap-2.5 rounded-md p-2"
            >
              <div
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold"
                style={{
                  backgroundColor: tint(theme.accent, '18'),
                  color: theme.accent,
                }}
              >
                {num}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className="text-[11px] font-semibold"
                    style={{ color: structureColor(entry.structure) }}
                  >
                    {entry.structure}
                  </span>
                  <span
                    className="font-mono text-[10px] font-bold"
                    style={{ color: theme.accent }}
                  >
                    {entry.delta}
                    {'\u0394'}
                  </span>
                  <span className="text-muted text-[10px]">
                    {entry.sizePercent}% size
                  </span>
                </div>
                <div className="text-muted text-[10px]">
                  {entry.timing || entry.condition}
                </div>
                <div className="text-secondary mt-0.5 text-[10px] italic">
                  {entry.note}
                </div>
              </div>
            </div>
          );
        })}
        {entryPlan.maxTotalSize && (
          <div className="text-muted text-[10px]">
            Max size: {entryPlan.maxTotalSize}
          </div>
        )}
        {entryPlan.noEntryConditions &&
          entryPlan.noEntryConditions.length > 0 && (
            <div className="mt-1">
              <div
                className="mb-0.5 text-[10px] font-bold uppercase"
                style={{ color: theme.red }}
              >
                Do NOT add entries if:
              </div>
              <BulletList
                defaultColor={theme.textMuted}
                items={entryPlan.noEntryConditions}
                icon={'\u2718'}
                color={theme.red}
              />
            </div>
          )}
      </div>
    </Collapsible>
  );
}
