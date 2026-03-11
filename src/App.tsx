import { useState, useEffect, useCallback, useRef, type CSSProperties } from 'react';
import type { IVMode, VIXDayData, VIXDataMap, CalculationResults } from './types';
import { DEFAULTS, IV_MODES } from './constants';
import { validateMarketTime, calcTimeToExpiry, resolveIV, calcAllDeltas, to24Hour } from './utils/calculator';
import { parseVixCSV } from './utils/csvParser';
import { cacheVixData, loadCachedVixData, loadStaticVixData } from './utils/vixStorage';
import { lightTheme, darkTheme } from './themes';
import { SectionBox, Chip, ErrorMsg, buildChevronUrl, srOnly, tinyLblStyle } from './components/ui';
import DeltaStrikesTable from './components/DeltaStrikesTable';
import IronCondorSection from './components/IronCondorSection';
import ParameterSummary from './components/ParameterSummary';
import VIXRegimeCard from './components/VIXRegimeCard';
import VIXRangeAnalysis from './components/VIXRangeAnalysis';
import DeltaRegimeGuide from './components/DeltaRegimeGuide';

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
  const [multiplier, setMultiplier] = useState(String(DEFAULTS.IV_PREMIUM_FACTOR));
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
    const onMouse = (e: MouseEvent) => { if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node)) setTooltipOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTooltipOpen(false); };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onMouse); document.removeEventListener('keydown', onKey); };
  }, [tooltipOpen]);

  // Debounce text inputs (250ms)
  useEffect(() => { const t = setTimeout(() => setDSpot(spotPrice), 250); return () => clearTimeout(t); }, [spotPrice]);
  useEffect(() => { const t = setTimeout(() => setDSpx(spxDirect), 250); return () => clearTimeout(t); }, [spxDirect]);

  // Auto-compute ratio when both SPY and SPX are entered
  const spxDirectActive = (() => {
    const spyVal = Number.parseFloat(dSpot);
    const spxVal = Number.parseFloat(dSpx);
    if (dSpx && !Number.isNaN(spxVal) && spxVal > 0 && !Number.isNaN(spyVal) && spyVal > 0) {
      return { active: true, ratio: spxVal / spyVal, spxVal };
    }
    return { active: false, ratio: spxRatio, spxVal: 0 };
  })();
  const effectiveRatio = spxDirectActive.active ? spxDirectActive.ratio : spxRatio;
  useEffect(() => { const t = setTimeout(() => setDVix(vixInput), 250); return () => clearTimeout(t); }, [vixInput]);
  useEffect(() => { const t = setTimeout(() => setDIV(directIVInput), 250); return () => clearTimeout(t); }, [directIVInput]);
  useEffect(() => { const t = setTimeout(() => setDMult(multiplier), 250); return () => clearTimeout(t); }, [multiplier]);

  // VIX data lookup on date change
  useEffect(() => {
    if (!selectedDate || Object.keys(vixData).length === 0) { setVixOHLC(null); return; }
    const entry = vixData[selectedDate];
    if (entry) {
      setVixOHLC(entry);
      if (vixOHLCField === 'smart' && ivMode === IV_MODES.VIX) {
        const etH = timezone === 'CT' ? to24Hour(Number.parseInt(timeHour), timeAmPm) + 1 : to24Hour(Number.parseInt(timeHour), timeAmPm);
        const v = etH < 13 ? entry.open : entry.close;
        if (v != null) setVixInput(v.toFixed(2));
      }
    } else { setVixOHLC(null); }
  }, [selectedDate, vixData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-apply OHLC selection when field or time changes
  useEffect(() => {
    if (!vixOHLC || ivMode !== IV_MODES.VIX) return;
    if (vixOHLCField === 'smart') {
      const etH = timezone === 'CT' ? to24Hour(Number.parseInt(timeHour), timeAmPm) + 1 : to24Hour(Number.parseInt(timeHour), timeAmPm);
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
    if (dSpot && (Number.isNaN(spyInput) || spyInput <= 0)) newErrors['spot'] = 'Enter a positive number';
    const spot = spyInput * effectiveRatio; // Convert SPY to SPX using ratio

    const h = Number.parseInt(timeHour);
    const m = Number.parseInt(timeMinute);
    if (Number.isNaN(h) || Number.isNaN(m)) {
      newErrors['time'] = 'Invalid time';
    } else {
      let h24 = to24Hour(h, timeAmPm);
      if (timezone === 'CT') h24 += 1;
      const timeResult = validateMarketTime(h24, m);
      if (!timeResult.valid && timeResult.error) newErrors['time'] = timeResult.error;
    }

    let sigma: number | null = null;
    if (ivMode === IV_MODES.VIX) {
      const v = Number.parseFloat(dVix);
      const mult = Number.parseFloat(dMult);
      if (dVix && Number.isNaN(v)) newErrors['vix'] = 'Enter a valid number';
      else if (dMult && Number.isNaN(mult)) newErrors['multiplier'] = 'Enter a valid number';
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
        const allDeltas = calcAllDeltas(spot, sigma, T, skewPct / 100, effectiveRatio);
        setResults({ allDeltas, sigma, T, hoursRemaining, spot });
      }
    } else {
      setResults(null);
    }
  }, [dSpot, dVix, dIV, dMult, ivMode, timeHour, timeMinute, timeAmPm, timezone, effectiveRatio, skewPct]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
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
  }, []);

  // Dynamic styles
  const chevronUrl = buildChevronUrl(th.chevronColor);
  const inputStyle: CSSProperties = {
    backgroundColor: th.inputBg, border: '1.5px solid ' + th.borderStrong, borderRadius: 8,
    color: th.text, padding: '11px 14px', fontSize: 16, fontFamily: "'DM Mono', monospace",
    outline: 'none', width: '100%', boxSizing: 'border-box', transition: 'border-color 0.15s',
  };
  const selectStyle: CSSProperties = {
    ...inputStyle, cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none',
    backgroundImage: 'url("' + chevronUrl + '")', backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 12px center', backgroundSize: '14px 14px', paddingRight: 34,
  };
  const tinyLbl = tinyLblStyle(th);

  return (
    <div style={{ minHeight: '100vh', backgroundColor: th.bg, color: th.text, fontFamily: "'Source Serif 4', 'Charter', Georgia, serif", transition: 'background-color 0.25s, color 0.25s' }}>
      <style>{
        "@import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&family=DM+Mono:wght@400;500&family=Outfit:wght@400;500;600;700&display=swap');" +
        "*, *::before, *::after { box-sizing: border-box; }" +
        "input:focus, select:focus, button:focus-visible { outline: 3px solid " + th.focusRing + "; outline-offset: 2px; }" +
        "button:focus:not(:focus-visible) { outline: none; }" +
        "input[type='number']::-webkit-inner-spin-button, input[type='number']::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }" +
        "input[type='number'] { -moz-appearance: textfield; }" +
        "::selection { background: " + (darkMode ? '#2A3E66' : '#BFDBFE') + "; color: " + (darkMode ? '#BFDBFE' : '#1E3A5F') + "; }" +
        "input::placeholder { color: " + th.textPlaceholder + "; }" +
        "@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }"
      }</style>

      <a href="#results" style={{ position: 'absolute', left: -9999, top: 0, backgroundColor: th.accent, color: '#fff', padding: '8px 16px', zIndex: 100, fontSize: 14, fontFamily: "'Outfit', sans-serif" }}
        onFocus={(e) => { (e.target as HTMLElement).style.left = '0'; }} onBlur={(e) => { (e.target as HTMLElement).style.left = '-9999px'; }}>
        Skip to results
      </a>

      <div style={{ maxWidth: 660, margin: '0 auto', padding: '36px 20px 48px' }}>

        {/* Header */}
        <header style={{ marginBottom: 32, borderBottom: '2.5px solid ' + th.borderHeavy, paddingBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.2em', color: th.accent, marginBottom: 6 }}>0DTE Options</div>
              <h1 style={{ fontSize: 30, fontWeight: 700, margin: 0, color: th.text, lineHeight: 1.15 }}>Strike Calculator</h1>
              <p style={{ fontSize: 15, color: th.textSecondary, margin: '8px 0 0', lineHeight: 1.5 }}>Black-Scholes approximation for delta-based strike placement</p>
            </div>
            <button onClick={() => setDarkMode(!darkMode)} aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              style={{ marginTop: 4, padding: '8px 12px', borderRadius: 8, border: '1.5px solid ' + th.borderStrong, backgroundColor: th.surface, color: th.text, cursor: 'pointer', fontSize: 18, fontFamily: "'Outfit', sans-serif", display: 'flex', alignItems: 'center', gap: 6, transition: 'all 0.2s' }}>
              {darkMode ? '\u2600\uFE0F' : '\uD83C\uDF19'}
              <span style={{ fontSize: 12, fontWeight: 600 }}>{darkMode ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </header>

        <main>
          {/* VIX Upload */}
          <SectionBox th={th} label="Historical VIX Data" badge={vixDataLoaded ? vixDataSource : null}>
            <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileUpload} style={{ display: 'none' }} aria-label="Upload VIX OHLC CSV file" />
            <button onClick={() => fileInputRef.current?.click()}
              style={{ width: '100%', padding: '12px 16px', backgroundColor: vixDataLoaded ? th.surfaceAlt : th.accentBg, border: '2px dashed ' + (vixDataLoaded ? th.borderStrong : th.accent), borderRadius: 8, color: vixDataLoaded ? th.textSecondary : th.accent, cursor: 'pointer', fontSize: 14, fontWeight: 600, fontFamily: "'Outfit', sans-serif" }}>
              {vixDataLoaded ? 'Replace CSV' : 'Upload VIX OHLC CSV'}
            </button>
            <p style={{ fontSize: 12, color: th.textMuted, margin: '6px 0 0' }}>CSV with Date, Open, High, Low, Close columns</p>
          </SectionBox>

          {/* Date Lookup */}
          {vixDataLoaded && (
            <SectionBox th={th} label="Date Lookup">
              <label htmlFor="date-picker" style={srOnly}>Select date</label>
              <input id="date-picker" type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} style={{ ...inputStyle, colorScheme: th.dateScheme }} />
              {vixOHLC && (
                <div style={{ marginTop: 14 }}>
                  <fieldset style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, border: 'none', margin: 0, padding: 0 }}>
                    <legend style={srOnly}>VIX OHLC values</legend>
                    {(['open', 'high', 'low', 'close'] as const).map((field) => (
                      <div key={field} style={{ padding: '10px 6px', backgroundColor: th.surfaceAlt, borderRadius: 8, textAlign: 'center' }}>
                        <div style={{ fontSize: 10, textTransform: 'uppercase', color: th.textTertiary, letterSpacing: '0.08em', fontFamily: "'Outfit', sans-serif", fontWeight: 700 }}>{field}</div>
                        <div style={{ fontSize: 17, fontWeight: 500, fontFamily: "'DM Mono', monospace", color: th.text, marginTop: 3 }}>{vixOHLC[field]?.toFixed(2) ?? '\u2014'}</div>
                      </div>
                    ))}
                  </fieldset>
                  <fieldset style={{ border: 'none', margin: 0, padding: 0, marginTop: 12 }}>
                    <legend style={srOnly}>VIX value to use</legend>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup">
                      {(['smart', 'open', 'high', 'low', 'close'] as const).map((f) => (
                        <Chip key={f} th={th} active={vixOHLCField === f} onClick={() => setVixOHLCField(f)} label={f === 'smart' ? 'Auto' : f.charAt(0).toUpperCase() + f.slice(1)} />
                      ))}
                    </div>
                  </fieldset>
                  <p style={{ fontSize: 12, color: th.textTertiary, marginTop: 8, fontStyle: 'italic' }}>
                    {vixOHLCField === 'smart' ? 'Auto: uses Open for AM entries, Close for PM entries' : 'Using VIX ' + vixOHLCField + ' value'}
                  </p>
                </div>
              )}
              {selectedDate && !vixOHLC && <ErrorMsg th={th}>No VIX data found for this date</ErrorMsg>}
            </SectionBox>
          )}

          {/* Spot Price */}
          <SectionBox th={th} label="Spot Price">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label htmlFor="spot-price" style={tinyLbl}>SPY Price</label>
                <input id="spot-price" type="text" inputMode="decimal" placeholder="e.g. 672" value={spotPrice} onChange={(e) => setSpotPrice(e.target.value)} aria-invalid={!!errors['spot']} aria-describedby={errors['spot'] ? 'spot-err' : undefined} style={inputStyle} />
              </div>
              <div>
                <label htmlFor="spx-direct" style={tinyLbl}>SPX Price <span style={{ fontWeight: 400, textTransform: 'none' as const, letterSpacing: 0, opacity: 0.7 }}>(optional)</span></label>
                <input id="spx-direct" type="text" inputMode="decimal" placeholder="e.g. 6731" value={spxDirect} onChange={(e) => setSpxDirect(e.target.value)} style={inputStyle} />
              </div>
            </div>
            {errors['spot'] && <ErrorMsg th={th} id="spot-err">{errors['spot']}</ErrorMsg>}
            {dSpot && !errors['spot'] && Number.parseFloat(dSpot) > 0 && (
              <div style={{ marginTop: 12, padding: '12px 14px', backgroundColor: th.surfaceAlt, borderRadius: 8 }}>
                {spxDirectActive.active ? (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: th.textTertiary, fontFamily: "'Outfit', sans-serif" }}>
                        Derived ratio
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 500, fontFamily: "'DM Mono', monospace", color: th.accent }}>
                        {spxDirectActive.ratio.toFixed(4)}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: th.textMuted, marginTop: 6, fontStyle: 'italic' }}>
                      Using actual SPX value. Clear SPX field to use slider.
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <label htmlFor="spx-ratio" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: th.textTertiary, fontFamily: "'Outfit', sans-serif", margin: 0 }}>
                        SPX/SPY Ratio
                      </label>
                      <span style={{ fontSize: 14, fontWeight: 500, fontFamily: "'DM Mono', monospace", color: th.accent }}>
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
                      onChange={(e) => setSpxRatio(Number.parseFloat(e.target.value))}
                      aria-label={'SPX to SPY ratio, currently ' + spxRatio.toFixed(2)}
                      aria-valuemin={9.95}
                      aria-valuemax={10.05}
                      aria-valuenow={spxRatio}
                      style={{ width: '100%', cursor: 'pointer', accentColor: th.accent, margin: 0 }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: th.textMuted, fontFamily: "'DM Mono', monospace", marginTop: 4 }}>
                      <span>9.95</span>
                      <span>10.00</span>
                      <span>10.05</span>
                    </div>
                  </>
                )}
                <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingTop: 8, borderTop: '1px solid ' + th.border }}>
                  <span style={{ fontSize: 12, color: th.textTertiary, fontFamily: "'Outfit', sans-serif", fontWeight: 600 }}>SPX for calculations</span>
                  <span style={{ fontSize: 18, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: th.text }}>
                    {(Number.parseFloat(dSpot) * effectiveRatio).toFixed(0)}
                  </span>
                </div>
              </div>
            )}
          </SectionBox>

          {/* Entry Time */}
          <SectionBox th={th} label="Entry Time">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 10, alignItems: 'end' }}>
              <div>
                <label htmlFor="sel-hour" style={tinyLbl}>Hour</label>
                <select id="sel-hour" value={timeHour} onChange={(e) => setTimeHour(e.target.value)} style={selectStyle}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="sel-min" style={tinyLbl}>Minute</label>
                <select id="sel-min" value={timeMinute} onChange={(e) => setTimeMinute(e.target.value)} style={selectStyle}>
                  {Array.from({ length: 60 }, (_, i) => i).map((m) => <option key={m} value={String(m).padStart(2, '0')}>{String(m).padStart(2, '0')}</option>)}
                </select>
              </div>
              <fieldset style={{ border: 'none', margin: 0, padding: 0 }}><legend style={srOnly}>AM or PM</legend>
                <div style={{ display: 'flex', gap: 4 }} role="radiogroup">
                  {(['AM', 'PM'] as const).map((ap) => <Chip key={ap} th={th} active={timeAmPm === ap} onClick={() => setTimeAmPm(ap)} label={ap} />)}
                </div>
              </fieldset>
              <fieldset style={{ border: 'none', margin: 0, padding: 0 }}><legend style={srOnly}>Timezone</legend>
                <div style={{ display: 'flex', gap: 4 }} role="radiogroup">
                  {(['ET', 'CT'] as const).map((tz) => <Chip key={tz} th={th} active={timezone === tz} onClick={() => setTimezone(tz)} label={tz} />)}
                </div>
              </fieldset>
            </div>
            {errors['time'] && <ErrorMsg th={th}>{errors['time']}</ErrorMsg>}
          </SectionBox>

          {/* IV Input */}
          <SectionBox th={th} label="Implied Volatility" headerRight={
            <fieldset style={{ border: 'none', margin: 0, padding: 0 }}><legend style={srOnly}>IV input mode</legend>
              <div style={{ display: 'flex', gap: 4 }} role="radiogroup">
                {([{ key: IV_MODES.VIX, label: 'VIX' }, { key: IV_MODES.DIRECT, label: 'Direct IV' }] as const).map(({ key, label }) => (
                  <Chip key={key} th={th} active={ivMode === key} onClick={() => setIvMode(key)} label={label} />
                ))}
              </div>
            </fieldset>
          }>
            {ivMode === IV_MODES.VIX ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 10, alignItems: 'end' }}>
                <div>
                  <label htmlFor="vix-val" style={tinyLbl}>VIX Value</label>
                  <input id="vix-val" type="text" inputMode="decimal" placeholder="e.g. 19" value={vixInput} onChange={(e) => setVixInput(e.target.value)} aria-invalid={!!errors['vix']} style={inputStyle} />
                </div>
                <div style={{ position: 'relative' }} ref={tooltipRef}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
                    <label htmlFor="mult-val" style={{ ...tinyLbl, marginBottom: 0 }}>0DTE Adj.</label>
                    <button onClick={() => setTooltipOpen(!tooltipOpen)} aria-expanded={tooltipOpen} aria-label="What is the 0DTE adjustment?"
                      style={{ width: 18, height: 18, borderRadius: '50%', border: '1.5px solid ' + th.borderStrong, backgroundColor: th.surfaceAlt, color: th.textTertiary, cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: "'Outfit', sans-serif", display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, lineHeight: 1 }}>?</button>
                  </div>
                  <input id="mult-val" type="text" inputMode="decimal" placeholder="1.15" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} aria-invalid={!!errors['multiplier']} aria-describedby="adj-tooltip-content" style={inputStyle} />
                  {tooltipOpen && (
                    <div id="adj-tooltip-content" role="tooltip" style={{ position: 'absolute', bottom: 'calc(100% + 10px)', right: -20, width: 340, backgroundColor: th.tooltipBg, color: th.tooltipText, borderRadius: 12, padding: '18px 20px', fontSize: 13, lineHeight: 1.7, zIndex: 50, boxShadow: '0 4px 24px rgba(0,0,0,0.25)', fontFamily: "'Outfit', sans-serif", fontWeight: 400 }}>
                      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>0DTE IV Adjustment</div>
                      <p style={{ margin: '0 0 12px' }}>VIX measures <strong>30-day</strong> implied volatility, but same-day (0DTE) options typically trade at <strong>10{'\u2013'}20% higher IV</strong> than what VIX indicates.</p>
                      <p style={{ margin: '0 0 12px' }}>This multiplier scales VIX upward to approximate actual 0DTE IV. For example, with VIX at 20:</p>
                      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, backgroundColor: th.tooltipCodeBg, color: th.tooltipCodeText, borderRadius: 8, padding: '10px 12px', marginBottom: 12, lineHeight: 1.8 }}>
                        <div>{'\u00D7'} 1.00 {'\u2192'} {'\u03C3'} = 0.200 (raw VIX, no adj.)</div>
                        <div>{'\u00D7'} 1.15 {'\u2192'} {'\u03C3'} = 0.230 (default)</div>
                        <div>{'\u00D7'} 1.20 {'\u2192'} {'\u03C3'} = 0.240 (high-vol)</div>
                      </div>
                      <p style={{ margin: 0, fontSize: 12, opacity: 0.85 }}>Range: {DEFAULTS.IV_PREMIUM_MIN}{'\u2013'}{DEFAULTS.IV_PREMIUM_MAX}. This is the largest source of estimation error. Tune based on observed 0DTE straddle pricing.</p>
                      <div style={{ position: 'absolute', bottom: -6, right: 32, width: 12, height: 12, backgroundColor: th.tooltipBg, transform: 'rotate(45deg)' }} />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div>
                <label htmlFor="direct-iv" style={tinyLbl}>{'\u03C3'} as decimal (e.g. 0.22 for 22%)</label>
                <input id="direct-iv" type="text" inputMode="decimal" placeholder="e.g. 0.22" value={directIVInput} onChange={(e) => setDirectIVInput(e.target.value)} aria-invalid={!!errors['iv']} style={inputStyle} />
              </div>
            )}
            {errors['vix'] && <ErrorMsg th={th}>{errors['vix']}</ErrorMsg>}
            {errors['multiplier'] && <ErrorMsg th={th}>{errors['multiplier']}</ErrorMsg>}
            {errors['iv'] && <ErrorMsg th={th}>{errors['iv']}</ErrorMsg>}

            {/* VIX Regime Context Card — appears when VIX is entered */}
            {ivMode === IV_MODES.VIX && dVix && !errors['vix'] && Number.parseFloat(dVix) > 0 && results && (
              <VIXRegimeCard
                th={th}
                vix={Number.parseFloat(dVix)}
                spot={results.spot}
              />
            )}
          </SectionBox>

          {/* Skew & Iron Condor Controls */}
          <SectionBox th={th} label="Advanced" headerRight={
            <button onClick={() => setShowIC(!showIC)} style={{
              padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: '1.5px solid ' + (showIC ? th.chipActiveBorder : th.chipBorder),
              backgroundColor: showIC ? th.chipActiveBg : th.chipBg,
              color: showIC ? th.chipActiveText : th.chipText,
              fontFamily: "'Outfit', sans-serif",
            }}>
              {showIC ? 'Hide' : 'Show'} Iron Condor
            </button>
          }>
            {/* Put Skew Slider */}
            <div style={{ marginBottom: showIC ? 16 : 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label htmlFor="skew-slider" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: th.textTertiary, fontFamily: "'Outfit', sans-serif" }}>
                  Put Skew
                </label>
                <span style={{ fontSize: 14, fontWeight: 500, fontFamily: "'DM Mono', monospace", color: th.accent }}>
                  {skewPct === 0 ? 'Off' : ('+' + skewPct + '% put / \u2212' + skewPct + '% call')}
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
                aria-label={'Put skew adjustment, currently ' + skewPct + ' percent'}
                style={{ width: '100%', cursor: 'pointer', accentColor: th.accent, margin: 0 }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: th.textMuted, fontFamily: "'DM Mono', monospace", marginTop: 4 }}>
                <span>0%</span>
                <span>3%</span>
                <span>5%</span>
                <span>8%</span>
              </div>
              <p style={{ fontSize: 11, color: th.textMuted, margin: '6px 0 0', fontStyle: 'italic' }}>
                OTM puts trade at higher IV than calls. Typical 0DTE skew: 2{'\u2013'}5%.
              </p>
            </div>

            {/* Iron Condor Wing Width */}
            {showIC && (
              <div style={{ paddingTop: 14, borderTop: '1px solid ' + th.border }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label htmlFor="wing-width" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: th.textTertiary, fontFamily: "'Outfit', sans-serif" }}>
                    Wing Width (SPX pts)
                  </label>
                  <span style={{ fontSize: 14, fontWeight: 500, fontFamily: "'DM Mono', monospace", color: th.accent }}>
                    {wingWidth}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label="Iron condor wing width">
                  {[5, 10, 15, 20, 25, 30, 50].map((w) => (
                    <Chip key={w} th={th} active={wingWidth === w} onClick={() => setWingWidth(w)} label={String(w)} />
                  ))}
                </div>
                <p style={{ fontSize: 11, color: th.textMuted, margin: '6px 0 0', fontStyle: 'italic' }}>
                  Distance from short strike to long (protective) strike on each side.
                </p>

                {/* Contracts Counter */}
                <div style={{ paddingTop: 14, marginTop: 14, borderTop: '1px solid ' + th.border }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label htmlFor="contracts-count" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: th.textTertiary, fontFamily: "'Outfit', sans-serif" }}>
                      Contracts
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                      <button
                        onClick={() => setContracts(Math.max(1, contracts - 1))}
                        aria-label="Decrease contracts"
                        style={{
                          width: 32, height: 32, borderRadius: '6px 0 0 6px',
                          border: '1.5px solid ' + th.borderStrong, borderRight: 'none',
                          backgroundColor: th.chipBg, color: th.text, cursor: 'pointer',
                          fontSize: 16, fontWeight: 700, fontFamily: "'DM Mono', monospace",
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >{'\u2212'}</button>
                      <input
                        id="contracts-count"
                        type="text"
                        inputMode="numeric"
                        value={contracts}
                        onChange={(e) => {
                          const v = Number.parseInt(e.target.value);
                          if (!Number.isNaN(v) && v >= 1 && v <= 999) setContracts(v);
                          else if (e.target.value === '') setContracts(1);
                        }}
                        style={{
                          width: 52, height: 32, textAlign: 'center' as const,
                          border: '1.5px solid ' + th.borderStrong,
                          backgroundColor: th.inputBg, color: th.text,
                          fontSize: 15, fontWeight: 600, fontFamily: "'DM Mono', monospace",
                          outline: 'none',
                        }}
                        aria-label="Number of contracts"
                      />
                      <button
                        onClick={() => setContracts(Math.min(999, contracts + 1))}
                        aria-label="Increase contracts"
                        style={{
                          width: 32, height: 32, borderRadius: '0 6px 6px 0',
                          border: '1.5px solid ' + th.borderStrong, borderLeft: 'none',
                          backgroundColor: th.chipBg, color: th.text, cursor: 'pointer',
                          fontSize: 16, fontWeight: 700, fontFamily: "'DM Mono', monospace",
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >+</button>
                    </div>
                  </div>
                  <p style={{ fontSize: 11, color: th.textMuted, margin: '6px 0 0', fontStyle: 'italic' }}>
                    SPX multiplier: $100/pt. P&L table shows per-contract and total dollar values.
                  </p>
                </div>
              </div>
            )}
          </SectionBox>

          {/* Market Regime Analysis */}
          <SectionBox th={th} label="Market Regime" badge={results ? ('VIX ' + (Number.parseFloat(dVix) || '—')) : null} headerRight={
            <button onClick={() => setShowRegime(!showRegime)} style={{
              padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: '1.5px solid ' + (showRegime ? th.chipActiveBorder : th.chipBorder),
              backgroundColor: showRegime ? th.chipActiveBg : th.chipBg,
              color: showRegime ? th.chipActiveText : th.chipText,
              fontFamily: "'Outfit', sans-serif",
            }}>
              {showRegime ? 'Hide' : 'Show'} Analysis
            </button>
          }>
            <p style={{ fontSize: 13, color: th.textSecondary, margin: 0, lineHeight: 1.6 }}>
            Historical VIX-to-SPX range correlation from 9,102 trading days (1990–2026).
            {' '}Expected daily ranges and IC survival rates at each VIX level.
            </p>
            {showRegime && (
              <div style={{ marginTop: 16 }}>
                <VIXRangeAnalysis
                  th={th}
                  vix={dVix ? Number.parseFloat(dVix) : null}
                  spot={results?.spot ?? null}
                />
                {results && dVix && !errors['vix'] && Number.parseFloat(dVix) > 0 && (
                  <DeltaRegimeGuide
                    th={th}
                    vix={Number.parseFloat(dVix)}
                    spot={results.spot}
                    sigma={results.sigma}
                    T={results.T}
                    skew={skewPct / 100}
                    allDeltas={results.allDeltas}
                  />
                )}
              </div>
            )}
          </SectionBox>

          {/* Results Table */}
          <div id="results" tabIndex={-1} style={{ marginTop: 4 }}>
            {results ? (
              <section aria-label="Strike results for all deltas" style={{ backgroundColor: th.surface, border: '2px solid ' + th.borderHeavy, borderRadius: 14, padding: '24px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.05), 0 8px 24px rgba(0,0,0,0.04)' }}>
                <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.16em', color: th.accent, marginBottom: 18 }}>All Delta Strikes</div>

                <ParameterSummary
                  th={th}
                  spySpot={(results.spot / effectiveRatio).toFixed(2)}
                  spxLabel={'SPX (\u00D7' + effectiveRatio.toFixed(spxDirectActive.active ? 4 : 2) + ')'}
                  spxValue={results.spot.toFixed(0)}
                  sigma={(results.sigma * 100).toFixed(2) + '%'}
                  T={results.T.toFixed(6)}
                  hoursLeft={results.hoursRemaining.toFixed(2) + 'h'}
                />

                <DeltaStrikesTable th={th} allDeltas={results.allDeltas} spot={results.spot} />

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

                <p style={{ fontSize: 12, color: th.textTertiary, marginTop: 14, lineHeight: 1.7 }}>
                  {skewPct > 0 ? ('Put skew: +' + skewPct + '% IV on puts, \u2212' + skewPct + '% on calls. ') : ''}Accuracy {'\u00B1'}5{'\u2013'}15 SPX points. Snapped: SPX nearest {DEFAULTS.STRIKE_INCREMENT}-pt, SPY nearest $1. Ratio: {effectiveRatio.toFixed(spxDirectActive.active ? 4 : 2)}{spxDirectActive.active ? ' (derived)' : ''}.
                </p>
              </section>
            ) : (
              <div style={{ textAlign: 'center', padding: 40, border: '2px dashed ' + th.borderStrong, borderRadius: 14, backgroundColor: darkMode ? th.surface : '#FAF9F6' }}>
                <p style={{ fontSize: 15, color: th.textMuted, margin: 0 }}>Enter SPY spot price, time, and IV to see all delta strikes</p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
