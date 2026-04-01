import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import BulletList from './BulletList';
import type { AnalysisResult } from './types';

interface Props {
  readonly review: NonNullable<AnalysisResult['review']>;
}

export default function EndOfDayReview({ review }: Props) {
  return (
    <div
      className="rounded-[10px] p-3.5"
      style={{
        backgroundColor: review.wasCorrect
          ? tint(theme.green, '08')
          : tint(theme.red, '08'),
        border: `1.5px solid ${tint(review.wasCorrect ? theme.green : theme.red, '20')}`,
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className="font-sans text-[11px] font-bold"
          style={{
            color: review.wasCorrect ? theme.green : theme.red,
          }}
        >
          {review.wasCorrect
            ? '\u2713 Recommendation was correct'
            : '\u2717 Recommendation was incorrect'}
        </span>
      </div>
      <div className="grid gap-2">
        <div className="text-[11px] leading-relaxed">
          <span className="font-semibold" style={{ color: theme.green }}>
            What worked:{' '}
          </span>
          <span className="text-secondary">{review.whatWorked}</span>
        </div>
        <div className="text-[11px] leading-relaxed">
          <span className="font-semibold" style={{ color: theme.caution }}>
            What was missed:{' '}
          </span>
          <span className="text-secondary">{review.whatMissed}</span>
        </div>
        <div className="text-[11px] leading-relaxed">
          <span className="font-semibold" style={{ color: theme.accent }}>
            Optimal trade:{' '}
          </span>
          <span className="text-secondary">{review.optimalTrade}</span>
        </div>
        {review.lessonsLearned.length > 0 && (
          <div>
            <div
              className="mb-0.5 text-[10px] font-bold tracking-wider uppercase"
              style={{ color: theme.accent }}
            >
              Lessons for next time
            </div>
            <BulletList
              defaultColor={theme.textMuted}
              items={review.lessonsLearned}
              icon={'\u{1F4A1}'}
              color={theme.accent}
            />
          </div>
        )}
      </div>
    </div>
  );
}
