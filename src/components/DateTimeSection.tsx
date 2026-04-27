import { memo, useEffect, useRef } from 'react';
import type { AmPm, Timezone } from '../types';
import { SectionBox, Chip, ErrorMsg } from './ui';
import { tinyLbl, inputCls, selectCls } from '../utils/ui-utils';

/**
 * Isolated memo'd wrapper around the native date input.
 * iOS Safari dismisses the native date picker whenever React reconciles a
 * controlled <input type="date"> — even if the value hasn't changed. By
 * memoizing this component, React skips reconciliation (and DOM writes)
 * entirely whenever selectedDate and onDateChange are stable.
 */
const DateInput = memo(function DateInput({
  value,
  className,
  onDateChange,
}: {
  value: string;
  className: string;
  onDateChange: (v: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  // Sync programmatic value changes (e.g. auto-fill) via ref so React never
  // writes to input.value during reconciliation. Both iOS Safari and Android
  // Firefox close the native date picker the moment React touches the DOM node,
  // even when the value is unchanged. Uncontrolled + ref sidesteps that entirely.
  useEffect(() => {
    if (ref.current && ref.current.value !== value) {
      ref.current.value = value;
    }
  }, [value]);

  return (
    <input
      ref={ref}
      id="dt-date-picker"
      type="date"
      defaultValue={value}
      onChange={(e) => onDateChange(e.target.value)}
      className={className}
    />
  );
});

interface Props {
  chevronUrl: string;
  selectedDate: string;
  onDateChange: (date: string) => void;
  vixDataLoaded: boolean;
  timeHour: string;
  onHourChange: (v: string) => void;
  timeMinute: string;
  onMinuteChange: (v: string) => void;
  timeAmPm: AmPm;
  onAmPmChange: (v: AmPm) => void;
  timezone: Timezone;
  onTimezoneChange: (v: Timezone) => void;
  /** True while a manual time pick is suppressing live-poll sync. */
  timeEdited: boolean;
  /** Clears the manual-pick lock and snaps time back to current CT. */
  onResumeLive: () => void;
  errors: Record<string, string>;
}

export default function DateTimeSection({
  chevronUrl,
  selectedDate,
  onDateChange,
  vixDataLoaded,
  timeHour,
  onHourChange,
  timeMinute,
  onMinuteChange,
  timeAmPm,
  onAmPmChange,
  timezone,
  onTimezoneChange,
  timeEdited,
  onResumeLive,
  errors,
}: Readonly<Props>) {
  return (
    <SectionBox label="Date & Time" collapsible>
      {/* Date picker */}
      {vixDataLoaded && (
        <>
          <label htmlFor="dt-date-picker" className={tinyLbl}>
            Date
          </label>
          <DateInput
            value={selectedDate}
            className={inputCls}
            onDateChange={onDateChange}
          />
        </>
      )}

      {/* Entry time */}
      <div
        className={vixDataLoaded ? 'border-edge mt-auto border-t pt-3.5' : ''}
      >
        <div className="grid grid-cols-2 items-end gap-2.5">
          <div>
            <label htmlFor="dt-hour" className={tinyLbl}>
              Hour
            </label>
            <select
              id="dt-hour"
              value={timeHour}
              onChange={(e) => onHourChange(e.target.value)}
              aria-invalid={!!errors['time']}
              aria-describedby={errors['time'] ? 'err-time' : undefined}
              className={selectCls}
              style={{ backgroundImage: chevronUrl }}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="dt-min" className={tinyLbl}>
              Minute
            </label>
            <select
              id="dt-min"
              value={timeMinute}
              onChange={(e) => onMinuteChange(e.target.value)}
              aria-invalid={!!errors['time']}
              aria-describedby={errors['time'] ? 'err-time' : undefined}
              className={selectCls}
              style={{ backgroundImage: chevronUrl }}
            >
              {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                <option key={m} value={String(m).padStart(2, '0')}>
                  {String(m).padStart(2, '0')}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="m-0 border-none p-0">
            <legend className="sr-only">AM or PM</legend>
            <div className="flex gap-1">
              {(['AM', 'PM'] as const).map((ap) => (
                <Chip
                  key={ap}
                  active={timeAmPm === ap}
                  onClick={() => onAmPmChange(ap)}
                  label={ap}
                />
              ))}
            </div>
          </fieldset>
          <fieldset className="m-0 border-none p-0">
            <legend className="sr-only">Timezone</legend>
            <div className="flex gap-1">
              {(['ET', 'CT'] as const).map((tz) => (
                <Chip
                  key={tz}
                  active={timezone === tz}
                  onClick={() => onTimezoneChange(tz)}
                  label={tz}
                />
              ))}
            </div>
          </fieldset>
        </div>
        {timeEdited && (
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={onResumeLive}
              className="text-accent hover:bg-accent-bg border-edge inline-flex min-h-[44px] cursor-pointer items-center rounded-full border px-3 py-2 font-mono text-[11px] font-medium transition-colors lg:min-h-0 lg:px-2.5 lg:py-1"
            >
              ↻ Now
            </button>
            <span className="text-tertiary font-mono text-[11px]">
              Manual time — live sync paused
            </span>
          </div>
        )}
        {errors['time'] && <ErrorMsg id="err-time">{errors['time']}</ErrorMsg>}
      </div>
    </SectionBox>
  );
}
