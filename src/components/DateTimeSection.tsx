import type { Theme } from '../themes';
import type { VIXDayData, OHLCField, AmPm, Timezone } from '../types';
import { SectionBox, Chip, ErrorMsg } from './ui';
import { tinyLbl } from '../utils/ui-utils';
import EventDayWarning from './EventDayWarning';
import type { EventItem } from '../types/api';

interface Props {
  th: Theme;
  inputCls: string;
  selectCls: string;
  chevronUrl: string;
  selectedDate: string;
  onDateChange: (date: string) => void;
  vixDataLoaded: boolean;
  vixOHLC: VIXDayData | null;
  vixOHLCField: OHLCField;
  onOHLCFieldChange: (field: OHLCField) => void;
  liveEvents?: readonly EventItem[];
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

export default function DateTimeSection({
  th,
  inputCls,
  selectCls,
  chevronUrl,
  selectedDate,
  onDateChange,
  vixDataLoaded,
  vixOHLC,
  vixOHLCField,
  onOHLCFieldChange,
  liveEvents,
  timeHour,
  onHourChange,
  timeMinute,
  onMinuteChange,
  timeAmPm,
  onAmPmChange,
  timezone,
  onTimezoneChange,
  errors,
}: Props) {
  return (
    <SectionBox label="Date & Time">
      {/* Date picker */}
      {vixDataLoaded && (
        <>
          <label htmlFor="date-picker" className={tinyLbl}>
            Date
          </label>
          <input
            id="date-picker"
            type="date"
            value={selectedDate}
            onChange={(e) => onDateChange(e.target.value)}
            className={inputCls}
          />
        </>
      )}

      {/* Entry time */}
      <div
        className={vixDataLoaded ? 'border-edge mt-auto border-t pt-3.5' : ''}
      >
        <div className="grid grid-cols-2 items-end gap-2.5">
          <div>
            <label htmlFor="sel-hour" className={tinyLbl}>
              Hour
            </label>
            <select
              id="sel-hour"
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
            <label htmlFor="sel-min" className={tinyLbl}>
              Minute
            </label>
            <select
              id="sel-min"
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
            <div className="flex gap-1" role="radiogroup">
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
            <div className="flex gap-1" role="radiogroup">
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
      </div>

      {/* VIX OHLC display */}
      {vixOHLC && (
        <div className="border-edge mt-3.5 border-t pt-3.5">
          <fieldset className="m-0 grid grid-cols-4 gap-2 border-none p-0">
            <legend className="sr-only">VIX OHLC values</legend>
            {(['open', 'high', 'low', 'close'] as const).map((field) => (
              <div
                key={field}
                className="bg-surface-alt rounded-lg p-[10px_6px] text-center"
              >
                <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                  {field}
                </div>
                <div className="text-primary mt-0.5 font-mono text-[17px] font-medium">
                  {vixOHLC[field]?.toFixed(2) ?? '\u2014'}
                </div>
              </div>
            ))}
          </fieldset>
          <fieldset className="m-0 mt-3 border-none p-0">
            <legend className="sr-only">VIX value to use</legend>
            <div className="flex flex-wrap gap-1.5" role="radiogroup">
              {(['smart', 'open', 'high', 'low', 'close'] as const).map((f) => (
                <Chip
                  key={f}
                  active={vixOHLCField === f}
                  onClick={() => onOHLCFieldChange(f)}
                  label={
                    f === 'smart'
                      ? 'Auto'
                      : f.charAt(0).toUpperCase() + f.slice(1)
                  }
                />
              ))}
            </div>
          </fieldset>
          <p className="text-tertiary mt-2 text-xs italic">
            {vixOHLCField === 'smart'
              ? 'Auto: uses Open for AM entries, Close for PM entries'
              : 'Using VIX ' + vixOHLCField + ' value'}
          </p>
        </div>
      )}

      <EventDayWarning
        th={th}
        selectedDate={selectedDate}
        liveEvents={liveEvents}
      />
      {vixDataLoaded && selectedDate && !vixOHLC && (
        <ErrorMsg>No VIX data found for this date</ErrorMsg>
      )}
    </SectionBox>
  );
}
