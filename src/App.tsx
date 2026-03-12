import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  IVMode,
  VIXDayData,
  VIXDataMap,
  CalculationResults,
} from './types';
import { DEFAULTS, IV_MODES } from './constants';
import {
  validateMarketTime,
  calcTimeToExpiry,
  resolveIV,
  calcAllDeltas,
  to24Hour,
} from './utils/calculator';
import { parseVixCSV } from './utils/csvParser';
import {
  cacheVixData,
  loadCachedVixData,
  loadStaticVixData,
} from './utils/vixStorage';
import { lightTheme, darkTheme } from './themes';
import { SectionBox, Chip, ErrorMsg } from './components/ui';
import { buildChevronUrl, tinyLbl } from './components/ui-utils';
import DeltaStrikesTable from './components/DeltaStrikesTable';
import IronCondorSection from './components/IronCondorSection';
import ParameterSummary from './components/ParameterSummary';
import VIXRegimeCard from './components/VIXRegimeCard';
import VIXRangeAnalysis from './components/VIXRangeAnalysis';
import DeltaRegimeGuide from './components/DeltaRegimeGuide';
import VIXTermStructure from './components/VIXTermStructure';
import OpeningRangeCheck from './components/OpeningRangeCheck';
import VolatilityCluster from './components/VolatilityCluster';
import EventDayWarning from './components/EventDayWarning';
import { Analytics } from '@vercel/analytics/react';

type AmPm = 'AM' | 'PM';
type Timezone = 'ET' | 'CT';
type OHLCField = 'smart' | 'open' | 'high' | 'low' | 'close';

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function StrikeCalculator() {
  const [darkMode, setDarkMode] = useState(false);
  const [spotPrice, setSpotPrice] = useState('');
  const [spxDirect, setSpxDirect] = useState('');
  const [spxRatio, setSpxRatio] = useState(10);
  const [ivMode, setIvMode] = useState<IVMode>(IV_MODES.VIX);
  const [vixInput, setVixInput] = useState('');
  const [multiplier, setMultiplier] = useState(
    String(DEFAULTS.IV_PREMIUM_FACTOR),
  );
  const [directIVInput, setDirectIVInput] = useState('');
  const [timeHour, setTimeHour] = useState('10');
  const [timeMinute, setTimeMinute] = useState('00');
  const [timeAmPm, setTimeAmPm] = useState<AmPm>('AM');
  const [timezone, setTimezone] = useState<Timezone>('ET');
  const [selectedDate, setSelectedDate] = useState('');
  const [vixData, setVixData] = useState<VIXDataMap>({});
  const [vixDataLoaded, setVixDataLoaded] = useState(false);
  const [vixDataSource, setVixDataSource] = useState('');
  const [vixOHLC, setVixOHLC] = useState<VIXDayData | null>(null);
  const [vixOHLCField, setVixOHLCField] = useState<OHLCField>('smart');
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [wingWidth, setWingWidth] = useState(25);
  const [showIC, setShowIC] = useState(false);
  const [contracts, setContracts] = useState(1);
  const [skewPct, setSkewPct] = useState(3); // percent, e.g. 3 = 3%
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dSpot, setDSpot] = useState('');
  const [dSpx, setDSpx] = useState('');
  const [dVix, setDVix] = useState('');
  const [dIV, setDIV] = useState('');
  const [dMult, setDMult] = useState(String(DEFAULTS.IV_PREMIUM_FACTOR));
  const [results, setResults] = useState<CalculationResults | null>(null);
  const [showRegime, setShowRegime] = useState(false);
  const [clusterMult, setClusterMult] = useState(1);
  const th = darkMode ? darkTheme : lightTheme;

  // Load VIX data on mount: try localStorage cache first, then static JSON
  useEffect(() => {
    const cached = loadCachedVixData();
    if (cached) {
      setVixData(cached.data);
      setVixDataLoaded(true);
      setVixDataSource(cached.source);
      return;
    }
    // No cache — try static JSON
    loadStaticVixData().then((result) => {
      if (result) {
        setVixData(result.data);
        setVixDataLoaded(true);
        setVixDataSource(result.source);
        // Cache the static data so future loads are instant
        cacheVixData(result.data, result.source);
      }
    });
  }, []);

  // Tooltip close on outside click + Escape
  useEffect(() => {
    if (!tooltipOpen) return;
    const onMouse = (e: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node))
        setTooltipOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTooltipOpen(false);
    };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [tooltipOpen]);

  // Debounce text inputs (250ms)
  useEffect(() => {
    const t = setTimeout(() => setDSpot(spotPrice), 250);
    return () => clearTimeout(t);
  }, [spotPrice]);
  useEffect(() => {
    const t = setTimeout(() => setDSpx(spxDirect), 250);
    return () => clearTimeout(t);
  }, [spxDirect]);

  // Auto-compute ratio when both SPY and SPX are entered
  const spxDirectActive = (() => {
    const spyVal = Number.parseFloat(dSpot);
    const spxVal = Number.parseFloat(dSpx);
    if (
      dSpx &&
      !Number.isNaN(spxVal) &&
      spxVal > 0 &&
      !Number.isNaN(spyVal) &&
      spyVal > 0
    ) {
      return { active: true, ratio: spxVal / spyVal, spxVal };
    }
    return { active: false, ratio: spxRatio, spxVal: 0 };
  })();
  const effectiveRatio = spxDirectActive.active
    ? spxDirectActive.ratio
    : spxRatio;
  useEffect(() => {
    const t = setTimeout(() => setDVix(vixInput), 250);
    return () => clearTimeout(t);
  }, [vixInput]);
  useEffect(() => {
    const t = setTimeout(() => setDIV(directIVInput), 250);
    return () => clearTimeout(t);
  }, [directIVInput]);
  useEffect(() => {
    const t = setTimeout(() => setDMult(multiplier), 250);
    return () => clearTimeout(t);
  }, [multiplier]);

  // VIX data lookup on date change
  useEffect(() => {
    if (!selectedDate || Object.keys(vixData).length === 0) {
      setVixOHLC(null);
      return;
    }
    const entry = vixData[selectedDate];
    if (entry) {
      setVixOHLC(entry);
      if (vixOHLCField === 'smart' && ivMode === IV_MODES.VIX) {
        const etH =
          timezone === 'CT'
            ? to24Hour(Number.parseInt(timeHour), timeAmPm) + 1
            : to24Hour(Number.parseInt(timeHour), timeAmPm);
        const v = etH < 13 ? entry.open : entry.close;
        if (v != null) setVixInput(v.toFixed(2));
      }
    } else {
      setVixOHLC(null);
    }
  }, [selectedDate, vixData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-apply OHLC selection when field or time changes
  useEffect(() => {
    if (!vixOHLC || ivMode !== IV_MODES.VIX) return;
    if (vixOHLCField === 'smart') {
      const etH =
        timezone === 'CT'
          ? to24Hour(Number.parseInt(timeHour), timeAmPm) + 1
          : to24Hour(Number.parseInt(timeHour), timeAmPm);
      const v = etH < 13 ? vixOHLC.open : vixOHLC.close;
      if (v != null) setVixInput(v.toFixed(2));
    } else {
      const v = vixOHLC[vixOHLCField];
      if (v != null) setVixInput(v.toFixed(2));
    }
  }, [vixOHLCField, vixOHLC, timeHour, timeAmPm, timezone, ivMode]);

  // Main calculation
  useEffect(() => {
    const newErrors: Record<string, string> = {};
    const spyInput = Number.parseFloat(dSpot);
    if (dSpot && (Number.isNaN(spyInput) || spyInput <= 0))
      newErrors['spot'] = 'Enter a positive number';
    const spot = spyInput * effectiveRatio; // Convert SPY to SPX using ratio

    const h = Number.parseInt(timeHour);
    const m = Number.parseInt(timeMinute);
    if (Number.isNaN(h) || Number.isNaN(m)) {
      newErrors['time'] = 'Invalid time';
    } else {
      let h24 = to24Hour(h, timeAmPm);
      if (timezone === 'CT') h24 += 1;
      const timeResult = validateMarketTime(h24, m);
      if (!timeResult.valid && timeResult.error)
        newErrors['time'] = timeResult.error;
    }

    let sigma: number | null = null;
    if (ivMode === IV_MODES.VIX) {
      const v = Number.parseFloat(dVix);
      const mult = Number.parseFloat(dMult);
      if (dVix && Number.isNaN(v)) newErrors['vix'] = 'Enter a valid number';
      else if (dMult && Number.isNaN(mult))
        newErrors['multiplier'] = 'Enter a valid number';
      else if (dVix) {
        const ivResult = resolveIV(IV_MODES.VIX, { vix: v, multiplier: mult });
        if (ivResult.error) newErrors['iv'] = ivResult.error;
        else sigma = ivResult.sigma;
      }
    } else {
      const iv = Number.parseFloat(dIV);
      if (dIV && Number.isNaN(iv)) newErrors['iv'] = 'Enter a valid number';
      else if (dIV) {
        const ivResult = resolveIV(IV_MODES.DIRECT, { directIV: iv });
        if (ivResult.error) newErrors['iv'] = ivResult.error;
        else sigma = ivResult.sigma;
      }
    }

    setErrors(newErrors);

    if (Object.keys(newErrors).length === 0 && spyInput > 0 && sigma != null) {
      let h24 = to24Hour(h, timeAmPm);
      if (timezone === 'CT') h24 += 1;
      const { hoursRemaining } = validateMarketTime(h24, m);
      if (hoursRemaining != null) {
        const T = calcTimeToExpiry(hoursRemaining);
        const allDeltas = calcAllDeltas(
          spot,
          sigma,
          T,
          skewPct / 100,
          effectiveRatio,
        );
        setResults({ allDeltas, sigma, T, hoursRemaining, spot });
      }
    } else {
      setResults(null);
    }
  }, [
    dSpot,
    dVix,
    dIV,
    dMult,
    ivMode,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    effectiveRatio,
    skewPct,
  ]);

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const parsed = parseVixCSV(text);
      const count = Object.keys(parsed).length;
      if (count > 0) {
        const sourceName = file.name + ' (' + count.toLocaleString() + ' days)';
        setVixData((prev) => {
          const merged = { ...prev, ...parsed };
          // Cache the merged data for next page load
          cacheVixData(merged, sourceName);
          return merged;
        });
        setVixDataLoaded(true);
        setVixDataSource(sourceName);
      }
    },
    [],
  );

  // Dynamic styles that must remain inline
  const chevronUrl = buildChevronUrl(th.chevronColor);

  // Base input classes
  const inputCls =
    'bg-input border-[1.5px] border-edge-strong rounded-lg text-primary p-[11px_14px] text-base font-mono outline-none w-full box-border transition-[border-color] duration-150';
  const selectCls =
    inputCls +
    ' cursor-pointer appearance-none bg-no-repeat bg-[length:14px_14px] bg-[position:right_12px_center] pr-[34px]';

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className="bg-page text-primary min-h-screen font-serif transition-[background-color,color] duration-[250ms]">
        <a
          href="#results"
          className="bg-accent absolute top-0 -left-[9999px] z-[100] p-[8px_16px] font-sans text-sm text-white"
          onFocus={(e) => {
            (e.target as HTMLElement).style.left = '0';
          }}
          onBlur={(e) => {
            (e.target as HTMLElement).style.left = '-9999px';
          }}
        >
          Skip to results
        </a>

        <div className="mx-auto max-w-[660px] px-5 pt-9 pb-12">
          {/* Header */}
          <header className="border-edge-heavy mb-8 border-b-[2.5px] pb-[18px]">
            <div className="flex flex-col items-start justify-between md:flex-row">
              <div>
                <div className="text-accent mb-1.5 font-sans text-[11px] font-bold tracking-[0.2em] uppercase">
                  0DTE Options
                </div>
                <h1 className="text-primary m-0 text-[30px] leading-[1.15] font-bold">
                  Strike Calculator
                </h1>
                <p className="text-secondary mt-2 mb-0 text-[15px] leading-normal">
                  Black-Scholes approximation for delta-based strike placement
                </p>
              </div>
              <button
                onClick={() => setDarkMode(!darkMode)}
                aria-label={
                  darkMode ? 'Switch to light mode' : 'Switch to dark mode'
                }
                className="border-edge-strong bg-surface text-primary mt-1 flex cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[8px_12px] font-sans text-lg transition-all duration-200"
              >
                {darkMode ? '\u2600\uFE0F' : '\uD83C\uDF19'}
                <span className="text-xs font-semibold">
                  {darkMode ? 'Light' : 'Dark'}
                </span>
              </button>
            </div>
          </header>

          <main>
            {/* VIX Upload */}
            <SectionBox
              th={th}
              label="Historical VIX Data"
              badge={vixDataLoaded ? vixDataSource : null}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="hidden"
                aria-label="Upload VIX OHLC CSV file"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className={
                  'w-full cursor-pointer rounded-lg border-2 border-dashed p-3 font-sans text-sm font-semibold ' +
                  (vixDataLoaded
                    ? 'bg-surface-alt border-edge-strong text-secondary'
                    : 'bg-accent-bg border-accent text-accent')
                }
              >
                {vixDataLoaded ? 'Replace CSV' : 'Upload VIX OHLC CSV'}
              </button>
              <p className="text-muted mt-1.5 mb-0 text-xs">
                CSV with Date, Open, High, Low, Close columns
              </p>
            </SectionBox>

            {/* Date Lookup */}
            {vixDataLoaded && (
              <SectionBox th={th} label="Date Lookup">
                <label htmlFor="date-picker" className="sr-only">
                  Select date
                </label>
                <input
                  id="date-picker"
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className={inputCls}
                  style={{ colorScheme: th.dateScheme }}
                />
                {vixOHLC && (
                  <div className="mt-3.5">
                    <fieldset className="m-0 grid grid-cols-2 gap-2 border-none p-0 md:grid-cols-4">
                      <legend className="sr-only">VIX OHLC values</legend>
                      {(['open', 'high', 'low', 'close'] as const).map(
                        (field) => (
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
                        ),
                      )}
                    </fieldset>
                    <fieldset className="m-0 mt-3 border-none p-0">
                      <legend className="sr-only">VIX value to use</legend>
                      <div className="flex flex-wrap gap-1.5" role="radiogroup">
                        {(
                          ['smart', 'open', 'high', 'low', 'close'] as const
                        ).map((f) => (
                          <Chip
                            key={f}
                            th={th}
                            active={vixOHLCField === f}
                            onClick={() => setVixOHLCField(f)}
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
                {/* NEW: Event Day Warning */}
                <EventDayWarning th={th} selectedDate={selectedDate} />
                {selectedDate && !vixOHLC && (
                  <ErrorMsg th={th}>No VIX data found for this date</ErrorMsg>
                )}
              </SectionBox>
            )}

            {/* Spot Price */}
            <SectionBox th={th} label="Spot Price">
              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                <div>
                  <label htmlFor="spot-price" className={tinyLbl}>
                    SPY Price
                  </label>
                  <input
                    id="spot-price"
                    type="text"
                    inputMode="decimal"
                    placeholder="e.g. 672"
                    value={spotPrice}
                    onChange={(e) => setSpotPrice(e.target.value)}
                    aria-invalid={!!errors['spot']}
                    aria-describedby={errors['spot'] ? 'spot-err' : undefined}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label htmlFor="spx-direct" className={tinyLbl}>
                    SPX Price{' '}
                    <span className="font-normal tracking-normal normal-case opacity-70">
                      (optional)
                    </span>
                  </label>
                  <input
                    id="spx-direct"
                    type="text"
                    inputMode="decimal"
                    placeholder="e.g. 6731"
                    value={spxDirect}
                    onChange={(e) => setSpxDirect(e.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>
              {errors['spot'] && (
                <ErrorMsg th={th} id="spot-err">
                  {errors['spot']}
                </ErrorMsg>
              )}
              {dSpot && !errors['spot'] && Number.parseFloat(dSpot) > 0 && (
                <div className="bg-surface-alt mt-3 rounded-lg p-[12px_14px]">
                  {spxDirectActive.active ? (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase">
                          Derived ratio
                        </span>
                        <span className="text-accent font-mono text-sm font-medium">
                          {spxDirectActive.ratio.toFixed(4)}
                        </span>
                      </div>
                      <div className="text-muted mt-1.5 text-xs italic">
                        Using actual SPX value. Clear SPX field to use slider.
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="mb-2 flex items-center justify-between">
                        <label
                          htmlFor="spx-ratio"
                          className="text-tertiary m-0 font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
                        >
                          SPX/SPY Ratio
                        </label>
                        <span className="text-accent font-mono text-sm font-medium">
                          {spxRatio.toFixed(2)}
                        </span>
                      </div>
                      <input
                        id="spx-ratio"
                        type="range"
                        min="9.95"
                        max="10.05"
                        step="0.01"
                        value={spxRatio}
                        onChange={(e) =>
                          setSpxRatio(Number.parseFloat(e.target.value))
                        }
                        aria-label={
                          'SPX to SPY ratio, currently ' + spxRatio.toFixed(2)
                        }
                        aria-valuemin={9.95}
                        aria-valuemax={10.05}
                        aria-valuenow={spxRatio}
                        className="m-0 w-full cursor-pointer"
                        style={{ accentColor: th.accent }}
                      />
                      <div className="text-muted mt-1 flex justify-between font-mono text-[10px]">
                        <span>9.95</span>
                        <span>10.00</span>
                        <span>10.05</span>
                      </div>
                    </>
                  )}
                  <div className="border-edge mt-2.5 flex items-baseline justify-between border-t pt-2">
                    <span className="text-tertiary font-sans text-xs font-semibold">
                      SPX for calculations
                    </span>
                    <span className="text-primary font-mono text-lg font-semibold">
                      {(Number.parseFloat(dSpot) * effectiveRatio).toFixed(0)}
                    </span>
                  </div>
                </div>
              )}
            </SectionBox>

            {/* Entry Time */}
            <SectionBox th={th} label="Entry Time">
              <div className="grid grid-cols-2 items-end gap-2.5 md:grid-cols-[1fr_1fr_auto_auto]">
                <div>
                  <label htmlFor="sel-hour" className={tinyLbl}>
                    Hour
                  </label>
                  <select
                    id="sel-hour"
                    value={timeHour}
                    onChange={(e) => setTimeHour(e.target.value)}
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
                    onChange={(e) => setTimeMinute(e.target.value)}
                    className={selectCls}
                    style={{ backgroundImage: chevronUrl }}
                  >
                    {Array.from({ length: 60 }, (_, i) => i).map((m) => (
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
                        th={th}
                        active={timeAmPm === ap}
                        onClick={() => setTimeAmPm(ap)}
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
                        th={th}
                        active={timezone === tz}
                        onClick={() => setTimezone(tz)}
                        label={tz}
                      />
                    ))}
                  </div>
                </fieldset>
              </div>
              {errors['time'] && <ErrorMsg th={th}>{errors['time']}</ErrorMsg>}
            </SectionBox>

            {/* IV Input */}
            <SectionBox
              th={th}
              label="Implied Volatility"
              headerRight={
                <fieldset className="m-0 border-none p-0">
                  <legend className="sr-only">IV input mode</legend>
                  <div className="flex gap-1" role="radiogroup">
                    {(
                      [
                        { key: IV_MODES.VIX, label: 'VIX' },
                        { key: IV_MODES.DIRECT, label: 'Direct IV' },
                      ] as const
                    ).map(({ key, label }) => (
                      <Chip
                        key={key}
                        th={th}
                        active={ivMode === key}
                        onClick={() => setIvMode(key)}
                        label={label}
                      />
                    ))}
                  </div>
                </fieldset>
              }
            >
              {ivMode === IV_MODES.VIX ? (
                <div className="grid grid-cols-[1fr_140px] items-end gap-2.5">
                  <div>
                    <label htmlFor="vix-val" className={tinyLbl}>
                      VIX Value
                    </label>
                    <input
                      id="vix-val"
                      type="text"
                      inputMode="decimal"
                      placeholder="e.g. 19"
                      value={vixInput}
                      onChange={(e) => setVixInput(e.target.value)}
                      aria-invalid={!!errors['vix']}
                      className={inputCls}
                    />
                  </div>
                  <div className="relative" ref={tooltipRef}>
                    <div className="mb-1 flex items-center gap-1.5">
                      <label htmlFor="mult-val" className={tinyLbl + ' !mb-0'}>
                        0DTE Adj.
                      </label>
                      <button
                        onClick={() => setTooltipOpen(!tooltipOpen)}
                        aria-expanded={tooltipOpen}
                        aria-label="What is the 0DTE adjustment?"
                        className="border-edge-strong bg-surface-alt text-tertiary inline-flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-full border-[1.5px] p-0 font-sans text-[11px] leading-none font-bold"
                      >
                        ?
                      </button>
                    </div>
                    <input
                      id="mult-val"
                      type="text"
                      inputMode="decimal"
                      placeholder="1.15"
                      value={multiplier}
                      onChange={(e) => setMultiplier(e.target.value)}
                      aria-invalid={!!errors['multiplier']}
                      aria-describedby="adj-tooltip-content"
                      className={inputCls}
                    />
                    {tooltipOpen && (
                      <div
                        id="adj-tooltip-content"
                        role="tooltip"
                        className="bg-tooltip-bg text-tooltip-text absolute -right-5 bottom-[calc(100%+10px)] z-50 w-[340px] rounded-xl p-[18px_20px] font-sans text-[13px] leading-[1.7] font-normal shadow-[0_4px_24px_rgba(0,0,0,0.25)]"
                      >
                        <div className="mb-2.5 text-[15px] font-bold">
                          0DTE IV Adjustment
                        </div>
                        <p className="m-0 mb-3">
                          VIX measures <strong>30-day</strong> implied
                          volatility, but same-day (0DTE) options typically
                          trade at <strong>10{'\u2013'}20% higher IV</strong>{' '}
                          than what VIX indicates.
                        </p>
                        <p className="m-0 mb-3">
                          This multiplier scales VIX upward to approximate
                          actual 0DTE IV. For example, with VIX at 20:
                        </p>
                        <div className="bg-tooltip-code-bg text-tooltip-code-text mb-3 rounded-lg p-[10px_12px] font-mono text-xs leading-[1.8]">
                          <div>
                            {'\u00D7'} 1.00 {'\u2192'} {'\u03C3'} = 0.200 (raw
                            VIX, no adj.)
                          </div>
                          <div>
                            {'\u00D7'} 1.15 {'\u2192'} {'\u03C3'} = 0.230
                            (default)
                          </div>
                          <div>
                            {'\u00D7'} 1.20 {'\u2192'} {'\u03C3'} = 0.240
                            (high-vol)
                          </div>
                        </div>
                        <p className="m-0 text-xs opacity-85">
                          Range: {DEFAULTS.IV_PREMIUM_MIN}
                          {'\u2013'}
                          {DEFAULTS.IV_PREMIUM_MAX}. This is the largest source
                          of estimation error. Tune based on observed 0DTE
                          straddle pricing.
                        </p>
                        <div className="bg-tooltip-bg absolute right-8 -bottom-1.5 h-3 w-3 rotate-45" />
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div>
                  <label htmlFor="direct-iv" className={tinyLbl}>
                    {'\u03C3'} as decimal (e.g. 0.22 for 22%)
                  </label>
                  <input
                    id="direct-iv"
                    type="text"
                    inputMode="decimal"
                    placeholder="e.g. 0.22"
                    value={directIVInput}
                    onChange={(e) => setDirectIVInput(e.target.value)}
                    aria-invalid={!!errors['iv']}
                    className={inputCls}
                  />
                </div>
              )}
              {errors['vix'] && <ErrorMsg th={th}>{errors['vix']}</ErrorMsg>}
              {errors['multiplier'] && (
                <ErrorMsg th={th}>{errors['multiplier']}</ErrorMsg>
              )}
              {errors['iv'] && <ErrorMsg th={th}>{errors['iv']}</ErrorMsg>}

              {/* VIX Regime Context Card — appears when VIX is entered */}
              {ivMode === IV_MODES.VIX &&
                dVix &&
                !errors['vix'] &&
                Number.parseFloat(dVix) > 0 &&
                results && (
                  <VIXRegimeCard
                    th={th}
                    vix={Number.parseFloat(dVix)}
                    spot={results.spot}
                  />
                )}

              {/* NEW: Term Structure Panel */}
              {ivMode === IV_MODES.VIX && dVix && !errors['vix'] && (
                <div className="mt-3.5">
                  <div className="text-tertiary mb-2 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
                    Term Structure
                  </div>
                  <VIXTermStructure
                    th={th}
                    vix={Number.parseFloat(dVix)}
                    onUseVix1dAsSigma={(sigma) => {
                      setIvMode(IV_MODES.DIRECT);
                      setDirectIVInput(sigma.toFixed(4));
                    }}
                  />
                </div>
              )}
            </SectionBox>

            {/* Skew & Iron Condor Controls */}
            <SectionBox
              th={th}
              label="Advanced"
              headerRight={
                <button
                  onClick={() => setShowIC(!showIC)}
                  className={
                    'cursor-pointer rounded-md border-[1.5px] p-[5px_12px] font-sans text-xs font-semibold ' +
                    (showIC
                      ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                      : 'border-chip-border bg-chip-bg text-chip-text')
                  }
                >
                  {showIC ? 'Hide' : 'Show'} Iron Condor
                </button>
              }
            >
              {/* Put Skew Slider */}
              <div className={showIC ? 'mb-4' : ''}>
                <div className="mb-1.5 flex items-center justify-between">
                  <label
                    htmlFor="skew-slider"
                    className="text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
                  >
                    Put Skew
                  </label>
                  <span className="text-accent font-mono text-sm font-medium">
                    {skewPct === 0
                      ? 'Off'
                      : '+' + skewPct + '% put / \u2212' + skewPct + '% call'}
                  </span>
                </div>
                <input
                  id="skew-slider"
                  type="range"
                  min="0"
                  max="8"
                  step="1"
                  value={skewPct}
                  onChange={(e) => setSkewPct(Number.parseInt(e.target.value))}
                  aria-label={
                    'Put skew adjustment, currently ' + skewPct + ' percent'
                  }
                  className="m-0 w-full cursor-pointer"
                  style={{ accentColor: th.accent }}
                />
                <div className="text-muted mt-1 flex justify-between font-mono text-[10px]">
                  <span>0%</span>
                  <span>3%</span>
                  <span>5%</span>
                  <span>8%</span>
                </div>
                <p className="text-muted mt-1.5 mb-0 text-[11px] italic">
                  OTM puts trade at higher IV than calls. Typical 0DTE skew: 2
                  {'\u2013'}5%.
                </p>
              </div>

              {/* Iron Condor Wing Width */}
              {showIC && (
                <div className="border-edge border-t pt-3.5">
                  <div className="mb-1.5 flex items-center justify-between">
                    <label
                      htmlFor="wing-width"
                      className="text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
                    >
                      Wing Width (SPX pts)
                    </label>
                    <span className="text-accent font-mono text-sm font-medium">
                      {wingWidth}
                    </span>
                  </div>
                  <div
                    className="flex flex-wrap gap-1.5"
                    role="radiogroup"
                    aria-label="Iron condor wing width"
                  >
                    {[5, 10, 15, 20, 25, 30, 50].map((w) => (
                      <Chip
                        key={w}
                        th={th}
                        active={wingWidth === w}
                        onClick={() => setWingWidth(w)}
                        label={String(w)}
                      />
                    ))}
                  </div>
                  <p className="text-muted mt-1.5 mb-0 text-[11px] italic">
                    Distance from short strike to long (protective) strike on
                    each side.
                  </p>

                  {/* Contracts Counter */}
                  <div className="border-edge mt-3.5 border-t pt-3.5">
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="contracts-count"
                        className="text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
                      >
                        Contracts
                      </label>
                      <div className="flex items-center">
                        <button
                          onClick={() =>
                            setContracts(Math.max(1, contracts - 1))
                          }
                          aria-label="Decrease contracts"
                          className="border-edge-strong bg-chip-bg text-primary flex h-8 w-8 cursor-pointer items-center justify-center rounded-l-md border-[1.5px] border-r-0 font-mono text-base font-bold"
                        >
                          {'\u2212'}
                        </button>
                        <input
                          id="contracts-count"
                          type="text"
                          inputMode="numeric"
                          value={contracts}
                          onChange={(e) => {
                            const v = Number.parseInt(e.target.value);
                            if (!Number.isNaN(v) && v >= 1 && v <= 999)
                              setContracts(v);
                            else if (e.target.value === '') setContracts(1);
                          }}
                          className="border-edge-strong bg-input text-primary h-8 w-[52px] border-[1.5px] text-center font-mono text-[15px] font-semibold outline-none"
                          aria-label="Number of contracts"
                        />
                        <button
                          onClick={() =>
                            setContracts(Math.min(999, contracts + 1))
                          }
                          aria-label="Increase contracts"
                          className="border-edge-strong bg-chip-bg text-primary flex h-8 w-8 cursor-pointer items-center justify-center rounded-r-md border-[1.5px] border-l-0 font-mono text-base font-bold"
                        >
                          +
                        </button>
                      </div>
                    </div>
                    <p className="text-muted mt-1.5 mb-0 text-[11px] italic">
                      SPX multiplier: $100/pt. P&L table shows per-contract and
                      total dollar values.
                    </p>
                  </div>
                </div>
              )}
            </SectionBox>

            {/* Market Regime Analysis */}
            <SectionBox
              th={th}
              label="Market Regime"
              badge={
                results ? 'VIX ' + (Number.parseFloat(dVix) || '\u2014') : null
              }
              headerRight={
                <button
                  onClick={() => setShowRegime(!showRegime)}
                  className={
                    'cursor-pointer rounded-md border-[1.5px] p-[5px_12px] font-sans text-xs font-semibold ' +
                    (showRegime
                      ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                      : 'border-chip-border bg-chip-bg text-chip-text')
                  }
                >
                  {showRegime ? 'Hide' : 'Show'} Analysis
                </button>
              }
            >
              <p className="text-secondary m-0 text-[13px] leading-relaxed">
                Historical VIX-to-SPX range correlation from 9,102 trading days
                (1990–2026). Expected daily ranges and IC survival rates at each
                VIX level.
              </p>
              {showRegime && (
                <div className="mt-4">
                  <VIXRangeAnalysis
                    th={th}
                    vix={dVix ? Number.parseFloat(dVix) : null}
                    spot={results?.spot ?? null}
                  />
                  {results &&
                    dVix &&
                    !errors['vix'] &&
                    Number.parseFloat(dVix) > 0 && (
                      <>
                        <div className="mt-5">
                          <VolatilityCluster
                            th={th}
                            vix={Number.parseFloat(dVix)}
                            spot={results.spot}
                            onMultiplierChange={setClusterMult}
                          />
                        </div>
                        <DeltaRegimeGuide
                          th={th}
                          vix={Number.parseFloat(dVix)}
                          spot={results.spot}
                          T={results.T}
                          skew={skewPct / 100}
                          allDeltas={results.allDeltas}
                          selectedDate={selectedDate}
                          clusterMult={clusterMult}
                        />
                        <div className="mt-5">
                          <OpeningRangeCheck
                            th={th}
                            vix={Number.parseFloat(dVix)}
                            spot={results.spot}
                            selectedDate={selectedDate}
                          />
                        </div>
                      </>
                    )}
                </div>
              )}
            </SectionBox>

            {/* Results Table */}
            <div id="results" tabIndex={-1} className="mt-1">
              {results ? (
                <section
                  aria-label="Strike results for all deltas"
                  className="bg-surface border-edge-heavy rounded-[14px] border-2 p-[24px_20px] shadow-[0_2px_8px_rgba(0,0,0,0.05),0_8px_24px_rgba(0,0,0,0.04)]"
                >
                  <div className="text-accent mb-[18px] font-sans text-xs font-bold tracking-[0.16em] uppercase">
                    All Delta Strikes
                  </div>

                  <ParameterSummary
                    th={th}
                    spySpot={(results.spot / effectiveRatio).toFixed(2)}
                    spxLabel={
                      'SPX (\u00D7' +
                      effectiveRatio.toFixed(spxDirectActive.active ? 4 : 2) +
                      ')'
                    }
                    spxValue={results.spot.toFixed(0)}
                    sigma={(results.sigma * 100).toFixed(2) + '%'}
                    T={results.T.toFixed(6)}
                    hoursLeft={results.hoursRemaining.toFixed(2) + 'h'}
                  />

                  <DeltaStrikesTable
                    th={th}
                    allDeltas={results.allDeltas}
                    spot={results.spot}
                  />

                  {showIC && (
                    <IronCondorSection
                      th={th}
                      results={results}
                      wingWidth={wingWidth}
                      contracts={contracts}
                      effectiveRatio={effectiveRatio}
                      skewPct={skewPct}
                    />
                  )}

                  <p className="text-tertiary mt-3.5 text-xs leading-[1.7]">
                    {skewPct > 0
                      ? 'Put skew: +' +
                        skewPct +
                        '% IV on puts, \u2212' +
                        skewPct +
                        '% on calls. '
                      : ''}
                    Accuracy {'\u00B1'}5{'\u2013'}15 SPX points. Snapped: SPX
                    nearest {DEFAULTS.STRIKE_INCREMENT}-pt, SPY nearest $1.
                    Ratio:{' '}
                    {effectiveRatio.toFixed(spxDirectActive.active ? 4 : 2)}
                    {spxDirectActive.active ? ' (derived)' : ''}.
                  </p>
                </section>
              ) : (
                <div className="border-edge-strong bg-surface rounded-[14px] border-2 border-dashed p-10 text-center">
                  <p className="text-muted m-0 text-[15px]">
                    Enter SPY spot price, time, and IV to see all delta strikes
                  </p>
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
      <Analytics />
    </div>
  );
}
