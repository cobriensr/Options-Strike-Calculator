import type { AmPm, Timezone } from '../types';
import { SectionBox, Chip, ErrorMsg } from './ui';
import { tinyLbl } from '../utils/ui-utils';

interface Props {
  selectCls: string;
  chevronUrl: string;
  timeHour: string;
  onHourChange: (v: string) => void;
  timeMinute: string;
  onMinuteChange: (v: string) => void;
  timeAmPm: AmPm;
  onAmPmChange: (v: AmPm) => void;
  timezone: Timezone;
  onTimezoneChange: (v: Timezone) => void;
  errors: Record<string, string>;
}

export default function EntryTimeSection({
  selectCls,
  chevronUrl,
  timeHour,
  onHourChange,
  timeMinute,
  onMinuteChange,
  timeAmPm,
  onAmPmChange,
  timezone,
  onTimezoneChange,
  errors,
}: Readonly<Props>) {
  return (
    <SectionBox label="Entry Time">
      <div className="grid grid-cols-2 items-end gap-2.5">
        <div>
          <label htmlFor="entry-hour" className={tinyLbl}>
            Hour
          </label>
          <select
            id="entry-hour"
            value={timeHour}
            onChange={(e) => onHourChange(e.target.value)}
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
          <label htmlFor="entry-min" className={tinyLbl}>
            Minute
          </label>
          <select
            id="entry-min"
            value={timeMinute}
            onChange={(e) => onMinuteChange(e.target.value)}
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
      {errors['time'] && <ErrorMsg>{errors['time']}</ErrorMsg>}
    </SectionBox>
  );
}
