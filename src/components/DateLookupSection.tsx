import type { VIXDayData, OHLCField } from '../types';
import { SectionBox, Chip, ErrorMsg } from './ui';
import { inputCls } from '../utils/ui-utils';
import EventDayWarning from './EventDayWarning';
import type { EventItem } from '../types/api';

interface Props {
  selectedDate: string;
  onDateChange: (date: string) => void;
  vixOHLC: VIXDayData | null;
  vixOHLCField: OHLCField;
  onOHLCFieldChange: (field: OHLCField) => void;
  liveEvents?: readonly EventItem[];
}

export default function DateLookupSection({
  selectedDate,
  onDateChange,
  vixOHLC,
  vixOHLCField,
  onOHLCFieldChange,
  liveEvents,
}: Props) {
  return (
    <SectionBox label="Date Lookup">
      <label htmlFor="lookup-date-picker" className="sr-only">
        Select date
      </label>
      <input
        id="lookup-date-picker"
        type="date"
        value={selectedDate}
        onChange={(e) => onDateChange(e.target.value)}
        className={inputCls}
      />
      {vixOHLC && (
        <div className="mt-3.5">
          <fieldset className="m-0 grid grid-cols-2 gap-2 border-none p-0 md:grid-cols-4">
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
       
        selectedDate={selectedDate}
        liveEvents={liveEvents}
      />
      {selectedDate && !vixOHLC && (
        <ErrorMsg>No VIX data found for this date</ErrorMsg>
      )}
    </SectionBox>
  );
}
