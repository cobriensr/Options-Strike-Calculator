import { useState, useEffect } from 'react';
import type { IVMode, AmPm, Timezone } from './types';
import { DEFAULTS, IV_MODES } from './constants';
import { lightTheme, darkTheme } from './themes';
import { buildChevronUrl } from './utils/ui-utils';
import { useDebounced } from './hooks/useDebounced';
import { useVixData } from './hooks/useVixData';
import { useCalculation } from './hooks/useCalculation';
import { useMarketData } from './hooks/useMarketData';
import { useHistoryData } from './hooks/useHistoryData';
import { useVix1dData } from './hooks/useVix1dData';
import { to24Hour } from './utils/calculator';
import VixUploadSection from './components/VixUploadSection';
import DateLookupSection from './components/DateLookupSection';
import SpotPriceSection from './components/SpotPriceSection';
import EntryTimeSection from './components/EntryTimeSection';
import IVInputSection from './components/IVInputSection';
import AdvancedSection from './components/AdvancedSection';
import MarketRegimeSection from './components/MarketRegimeSection';
import ResultsSection from './components/ResultsSection';
import BacktestDiag from './components/BacktestDiag';
import { Analytics } from '@vercel/analytics/react';

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function StrikeCalculator() {
  // Theme
  const [darkMode, setDarkMode] = useState(false);
  const th = darkMode ? darkTheme : lightTheme;

  // Spot price state
  const [spotPrice, setSpotPrice] = useState('');
  const [spxDirect, setSpxDirect] = useState('');
  const [spxRatio, setSpxRatio] = useState(10);

  // IV state
  const [ivMode, setIvMode] = useState<IVMode>(IV_MODES.VIX);
  const [vixInput, setVixInput] = useState('');
  const [multiplier, setMultiplier] = useState(
    String(DEFAULTS.IV_PREMIUM_FACTOR),
  );
  const [directIVInput, setDirectIVInput] = useState('');

  // Time state
  const [timeHour, setTimeHour] = useState('10');
  const [timeMinute, setTimeMinute] = useState('00');
  const [timeAmPm, setTimeAmPm] = useState<AmPm>('AM');
  const [timezone, setTimezone] = useState<Timezone>('CT');

  // IC & skew state
  const [wingWidth, setWingWidth] = useState(20);
  const [showIC, setShowIC] = useState(true);
  const [contracts, setContracts] = useState(20);
  const [skewPct, setSkewPct] = useState(3);
  const [clusterMult, setClusterMult] = useState(1);

  // Debounced values
  const dSpot = useDebounced(spotPrice);
  const dSpx = useDebounced(spxDirect);
  const dVix = useDebounced(vixInput);
  const dIV = useDebounced(directIVInput);
  const dMult = useDebounced(multiplier);

  // Derived SPX ratio
  const spyVal = Number.parseFloat(dSpot);
  const spxVal = Number.parseFloat(dSpx);
  const spxDirectActive =
    !!dSpx &&
    !Number.isNaN(spxVal) &&
    spxVal > 0 &&
    !Number.isNaN(spyVal) &&
    spyVal > 0;
  const effectiveRatio = spxDirectActive ? spxVal / spyVal : spxRatio;

  // Hooks
  const market = useMarketData();
  const vix = useVixData(ivMode, timeHour, timeAmPm, timezone, setVixInput);
  const historyData = useHistoryData(vix.selectedDate);
  const vix1dStatic = useVix1dData();
  const { results, errors } = useCalculation(
    dSpot,
    dSpx,
    dVix,
    dIV,
    dMult,
    ivMode,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    spxRatio,
    skewPct,
  );

  // Auto-fill from live Schwab data (owner-only, silently skipped for public)
  useEffect(() => {
    if (!market.data.quotes) return;
    const q = market.data.quotes;

    // Only auto-fill empty fields — never overwrite user input
    if (!spotPrice && q.spy) setSpotPrice(q.spy.price.toFixed(2));
    if (!spxDirect && q.spx) setSpxDirect(q.spx.price.toFixed(0));
    if (!vixInput && q.vix && ivMode === IV_MODES.VIX)
      setVixInput(q.vix.price.toFixed(2));

    // Auto-set today's date if not already set
    if (!vix.selectedDate) {
      const today = new Date().toLocaleDateString('en-CA', {
        timeZone: 'America/New_York',
      });
      vix.setSelectedDate(today);
    }
    // Auto-set current time in CT
    if (timeHour === '10' && timeMinute === '00') {
      const now = new Date();
      const ctStr = now.toLocaleString('en-US', {
        timeZone: 'America/Chicago',
      });
      const ctDate = new Date(ctStr);
      let h = ctDate.getHours();
      const m = ctDate.getMinutes();
      const snappedMin = Math.floor(m / 5) * 5;
      const ampm: AmPm = h >= 12 ? 'PM' : 'AM';
      if (h > 12) h -= 12;
      if (h === 0) h = 12;
      setTimeHour(String(h));
      setTimeMinute(String(snappedMin).padStart(2, '0'));
      setTimeAmPm(ampm);
      setTimezone('CT');
    }
  }, [market.data.quotes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fill from historical data when a past date is selected,
  // or restore live data when switching back to today
  useEffect(() => {
    if (historyData.hasHistory) {
      // Past date: fill from historical candles
      const h24 = to24Hour(Number.parseInt(timeHour), timeAmPm);
      const etHour = timezone === 'CT' ? h24 + 1 : h24;
      const etMinute = Number.parseInt(timeMinute) || 0;

      const snapshot = historyData.getStateAtTime(etHour, etMinute);
      if (!snapshot) return;

      // SPX/SPY prices
      setSpotPrice(snapshot.spy.toFixed(2));
      setSpxDirect(snapshot.spot.toFixed(0));

      // VIX — override the static VIX data with actual intraday VIX
      if (snapshot.vix != null && ivMode === IV_MODES.VIX) {
        setVixInput(snapshot.vix.toFixed(2));
      }
    } else if (market.data.quotes) {
      // Today (or no history): restore live prices if available
      const q = market.data.quotes;
      if (q.spy) setSpotPrice(q.spy.price.toFixed(2));
      if (q.spx) setSpxDirect(q.spx.price.toFixed(0));
    }
  }, [
    historyData,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    ivMode,
    market.data.quotes,
  ]);

  // Compute current history snapshot for downstream components
  const historySnapshot = (() => {
    if (!historyData.hasHistory) return null;
    const h24 = to24Hour(Number.parseInt(timeHour), timeAmPm);
    const etHour = timezone === 'CT' ? h24 + 1 : h24;
    const etMinute = Number.parseInt(timeMinute) || 0;
    const snapshot = historyData.getStateAtTime(etHour, etMinute);
    if (!snapshot) return null;

    // Fall back to static VIX1D daily data if Schwab intraday unavailable
    if (snapshot.vix1d == null && vix1dStatic.loaded) {
      const staticVal = vix1dStatic.getVix1d(historyData.history!.date, etHour);
      if (staticVal != null) {
        return { ...snapshot, vix1d: staticVal };
      }
    }
    return snapshot;
  })();

  // Shared CSS classes
  const chevronUrl = buildChevronUrl(th.chevronColor);
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
              <div className="flex items-center gap-2">
                {historySnapshot && (
                  <span
                    className="rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold"
                    style={{
                      backgroundColor: '#7C3AED18',
                      color: '#7C3AED',
                    }}
                  >
                    ● BACKTEST
                  </span>
                )}
                {historyData.loading && (
                  <span
                    className="rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold"
                    style={{
                      backgroundColor: th.surfaceAlt,
                      color: th.textMuted,
                    }}
                  >
                    Loading…
                  </span>
                )}
                {historyData.error && !historyData.loading && (
                  <span
                    className="rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold"
                    style={{
                      backgroundColor: th.red + '18',
                      color: th.red,
                    }}
                    title={historyData.error}
                  >
                    ● NO INTRADAY
                  </span>
                )}
                {!historySnapshot && !historyData.error && market.hasData && (
                  <span
                    className="rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold"
                    style={{
                      backgroundColor: market.data.quotes?.marketOpen
                        ? th.green + '18'
                        : th.surfaceAlt,
                      color: market.data.quotes?.marketOpen
                        ? th.green
                        : th.textMuted,
                    }}
                  >
                    {market.data.quotes?.marketOpen ? '● LIVE' : '● CLOSED'}
                  </span>
                )}
                {market.needsAuth && (
                  <a
                    href="/api/auth/init"
                    className="rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold no-underline"
                    style={{ backgroundColor: th.red + '18', color: th.red }}
                  >
                    Re-authenticate
                  </a>
                )}
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
            </div>
          </header>

          <main>
            <VixUploadSection
              th={th}
              vixDataLoaded={vix.vixDataLoaded}
              vixDataSource={vix.vixDataSource}
              fileInputRef={vix.fileInputRef}
              onFileUpload={vix.handleFileUpload}
            />

            {vix.vixDataLoaded && (
              <DateLookupSection
                th={th}
                inputCls={inputCls}
                selectedDate={vix.selectedDate}
                onDateChange={vix.setSelectedDate}
                vixOHLC={vix.vixOHLC}
                vixOHLCField={vix.vixOHLCField}
                onOHLCFieldChange={vix.setVixOHLCField}
                liveEvents={market.data.events?.events}
              />
            )}

            <SpotPriceSection
              th={th}
              inputCls={inputCls}
              spotPrice={spotPrice}
              onSpotChange={setSpotPrice}
              spxDirect={spxDirect}
              onSpxDirectChange={setSpxDirect}
              spxRatio={spxRatio}
              onSpxRatioChange={setSpxRatio}
              dSpot={dSpot}
              effectiveRatio={effectiveRatio}
              spxDirectActive={spxDirectActive}
              derivedRatio={spxDirectActive ? spxVal / spyVal : spxRatio}
              errors={errors}
            />

            <EntryTimeSection
              th={th}
              selectCls={selectCls}
              chevronUrl={chevronUrl}
              timeHour={timeHour}
              onHourChange={setTimeHour}
              timeMinute={timeMinute}
              onMinuteChange={setTimeMinute}
              timeAmPm={timeAmPm}
              onAmPmChange={setTimeAmPm}
              timezone={timezone}
              onTimezoneChange={setTimezone}
              errors={errors}
            />

            <IVInputSection
              th={th}
              inputCls={inputCls}
              ivMode={ivMode}
              onIvModeChange={setIvMode}
              vixInput={vixInput}
              onVixChange={setVixInput}
              multiplier={multiplier}
              onMultiplierChange={setMultiplier}
              directIVInput={directIVInput}
              onDirectIVChange={setDirectIVInput}
              dVix={dVix}
              results={results}
              errors={errors}
              market={market}
              historySnapshot={historySnapshot}
              onUseVix1dAsSigma={(sigma) => {
                setIvMode(IV_MODES.DIRECT);
                setDirectIVInput(sigma.toFixed(4));
              }}
            />

            <AdvancedSection
              th={th}
              skewPct={skewPct}
              onSkewChange={setSkewPct}
              showIC={showIC}
              onToggleIC={() => setShowIC(!showIC)}
              wingWidth={wingWidth}
              onWingWidthChange={setWingWidth}
              contracts={contracts}
              onContractsChange={setContracts}
            />

            <MarketRegimeSection
              th={th}
              dVix={dVix}
              results={results}
              errors={errors}
              skewPct={skewPct}
              selectedDate={vix.selectedDate}
              market={market}
              onClusterMultChange={setClusterMult}
              clusterMult={clusterMult}
              historySnapshot={historySnapshot}
              historyCandles={historyData.history?.spx.candles}
              entryTimeLabel={
                historySnapshot
                  ? `${timeHour}:${timeMinute} ${timeAmPm} ${timezone}`
                  : undefined
              }
            />

            <ResultsSection
              th={th}
              results={results}
              effectiveRatio={effectiveRatio}
              spxDirectActive={spxDirectActive}
              showIC={showIC}
              wingWidth={wingWidth}
              contracts={contracts}
              skewPct={skewPct}
            />
          </main>
        </div>
      </div>
      <BacktestDiag
        snapshot={historySnapshot}
        history={historyData}
        timeHour={timeHour}
        timeMinute={timeMinute}
        timeAmPm={timeAmPm}
        timezone={timezone}
      />
      <Analytics />
    </div>
  );
}
