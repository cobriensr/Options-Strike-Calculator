/**
 * ES Overnight Input Component
 *
 * Pre-market data entry for ES futures overnight session data.
 * Submitted before cash open and fed into analyze.ts for gap analysis
 * context.
 *
 * Fields: Globex High, Low, Close, VWAP (optional).
 *
 * The 0DTE straddle cone is no longer entered manually — `compute-cone`
 * cron (9:32 ET) auto-derives it from the SPX 0DTE ATM call+put marks
 * and persists to `cone_levels`. The analyze pipeline reads it from
 * there.
 *
 * Saves to /api/pre-market endpoint and stores in AnalysisContext.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { SectionBox, ErrorMsg } from './ui';
import { tinyLbl, inputCls } from '../utils/ui-utils';
import type { PreMarketData } from '../types/api';

interface PreMarketInputProps {
  /** ISO date string e.g. '2026-03-28' */
  date: string;
  /** SPX price from calculator (for gap calculation preview) */
  spxPrice?: number;
  /** Previous SPX close if available */
  prevClose?: number;
  /** Callback when data is saved — parent can merge into analysis context */
  onSave?: (data: PreMarketData) => void;
  /** API base URL (defaults to '') */
  apiBase?: string;
}

export default function PreMarketInput({
  date,
  spxPrice,
  prevClose,
  onSave,
  apiBase = '',
}: Readonly<PreMarketInputProps>) {
  const [globexHigh, setGlobexHigh] = useState('');
  const [globexLow, setGlobexLow] = useState('');
  const [globexClose, setGlobexClose] = useState('');
  const [globexVwap, setGlobexVwap] = useState('');

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [autoFilled, setAutoFilled] = useState(false);
  const [error, setError] = useState('');

  // Load existing data for this date
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetch(`${apiBase}/api/pre-market?date=${date}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const json = await res.json();
        if (json.data) {
          const d = json.data as PreMarketData;
          if (d.globexHigh != null) setGlobexHigh(String(d.globexHigh));
          if (d.globexLow != null) setGlobexLow(String(d.globexLow));
          if (d.globexClose != null) setGlobexClose(String(d.globexClose));
          if (d.globexVwap != null) setGlobexVwap(String(d.globexVwap));
          if (d.savedAt) setSaved(true);
          if (d.autoFilled === true) {
            setAutoFilled(true);
          }
        }
      } catch {
        // Non-fatal — first use or aborted
      }
    }
    load();
    return () => controller.abort();
  }, [date, apiBase]);

  const handleSave = useCallback(async () => {
    setError('');
    setSaving(true);

    const data: PreMarketData = {
      globexHigh: globexHigh ? Number.parseFloat(globexHigh) : null,
      globexLow: globexLow ? Number.parseFloat(globexLow) : null,
      globexClose: globexClose ? Number.parseFloat(globexClose) : null,
      globexVwap: globexVwap ? Number.parseFloat(globexVwap) : null,
      savedAt: new Date().toISOString(),
    };

    // Validate: need at least the 3 ES fields
    if (
      data.globexHigh == null ||
      data.globexLow == null ||
      data.globexClose == null
    ) {
      setError('Globex High, Low, and Close are required');
      setSaving(false);
      return;
    }

    const gh = data.globexHigh;
    const gl = data.globexLow;
    const gc = data.globexClose;
    if (gh !== null && gl !== null && gc !== null) {
      if (gh < gl) {
        setError('Globex High must be \u2265 Globex Low');
        setSaving(false);
        return;
      }
      if (gc > gh || gc < gl) {
        setError(
          'Warning: Globex Close is outside the High/Low range \u2014 verify data',
        );
      }
    }

    try {
      const res = await fetch(`${apiBase}/api/pre-market`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, ...data }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${res.status})`);
      }

      setSaved(true);
      onSave?.(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [globexHigh, globexLow, globexClose, globexVwap, date, apiBase, onSave]);

  // Live gap preview: ES Globex Close vs previous SPX close
  const gapPreview = useMemo(() => {
    const gc = Number.parseFloat(globexClose);
    const pc = prevClose ?? spxPrice;
    if (Number.isNaN(gc) || !pc) return null;
    const diff = gc - pc;
    return {
      diff,
      direction: diff > 0 ? 'UP' : diff < 0 ? 'DOWN' : ('FLAT' as const),
    };
  }, [globexClose, prevClose, spxPrice]);

  // Input styling: accent tint on border when auto-filled by cron
  const esInputCls = autoFilled
    ? inputCls + ' border-[color:var(--color-accent)] border-opacity-40'
    : inputCls;

  const overnightRange = useMemo(() => {
    const h = Number.parseFloat(globexHigh);
    const l = Number.parseFloat(globexLow);
    if (Number.isNaN(h) || Number.isNaN(l) || h <= l) return null;
    return `${(h - l).toFixed(1)} pts`;
  }, [globexHigh, globexLow]);

  return (
    <SectionBox
      label="Pre-Market"
      badge={autoFilled ? 'Auto-filled \u2713' : saved ? '\u2713 Saved' : null}
      collapsible
      headerRight={
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className={
            'cursor-pointer rounded-md border-[1.5px] px-3.5 py-1.5 font-sans text-xs font-semibold transition-colors duration-100 ' +
            (saving
              ? 'border-edge-strong bg-chip-bg text-muted cursor-not-allowed opacity-60'
              : 'border-chip-active-border bg-chip-active-bg text-chip-active-text hover:brightness-110')
          }
        >
          {saving ? 'Saving\u2026' : saved ? 'Update' : 'Save'}
        </button>
      }
    >
      {/* ES Overnight Section */}
      <div className="mb-4">
        <div className="text-tertiary mb-2 flex items-baseline gap-1.5 font-sans text-[11px] font-bold tracking-[0.08em] uppercase">
          ES Futures Overnight{' '}
          <span className="text-muted text-[10px] font-normal tracking-normal normal-case">
            Globex 5 PM – 8:30 AM CT
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label htmlFor="pm-globex-high" className={tinyLbl}>
              Globex High <span className="text-danger ml-0.5">*</span>
            </label>
            <input
              id="pm-globex-high"
              type="text"
              inputMode="decimal"
              placeholder="6555.25"
              value={globexHigh}
              onChange={(e) => setGlobexHigh(e.target.value)}
              className={esInputCls}
            />
          </div>
          <div>
            <label htmlFor="pm-globex-low" className={tinyLbl}>
              Globex Low <span className="text-danger ml-0.5">*</span>
            </label>
            <input
              id="pm-globex-low"
              type="text"
              inputMode="decimal"
              placeholder="6520.50"
              value={globexLow}
              onChange={(e) => setGlobexLow(e.target.value)}
              className={esInputCls}
            />
          </div>
          <div>
            <label htmlFor="pm-globex-close" className={tinyLbl}>
              Globex Close <span className="text-danger ml-0.5">*</span>
            </label>
            <input
              id="pm-globex-close"
              type="text"
              inputMode="decimal"
              placeholder="6548.00"
              value={globexClose}
              onChange={(e) => setGlobexClose(e.target.value)}
              className={esInputCls}
            />
            <span className="text-muted mt-0.5 block text-[10px]">
              Last price at 8:30 AM CT
            </span>
          </div>
          <div>
            <label htmlFor="pm-globex-vwap" className={tinyLbl}>
              Globex VWAP{' '}
              <span className="text-muted ml-1 font-normal tracking-normal normal-case">
                optional
              </span>
            </label>
            <input
              id="pm-globex-vwap"
              type="text"
              inputMode="decimal"
              placeholder="6536.80"
              value={globexVwap}
              onChange={(e) => setGlobexVwap(e.target.value)}
              className={esInputCls}
            />
          </div>
        </div>
      </div>

      {/* Live preview cards */}
      {(overnightRange || gapPreview) && (
        <div className="bg-surface-alt mb-4 grid grid-cols-2 gap-2.5 rounded-lg p-[12px_14px]">
          {overnightRange && (
            <div>
              <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                O/N Range
              </div>
              <div className="text-accent mt-0.5 font-mono text-sm font-medium">
                {overnightRange}
              </div>
            </div>
          )}
          {gapPreview && (
            <div>
              <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                ES vs SPX
              </div>
              <div className="mt-0.5 font-mono text-sm font-medium">
                <span
                  className={
                    gapPreview.direction === 'UP'
                      ? 'text-success'
                      : gapPreview.direction === 'DOWN'
                        ? 'text-danger'
                        : 'text-secondary'
                  }
                >
                  {gapPreview.diff > 0 ? '+' : ''}
                  {gapPreview.diff.toFixed(1)}
                </span>
                <span className="text-muted ml-1.5 text-[10px] font-normal">
                  {gapPreview.direction}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <ErrorMsg>{error}</ErrorMsg>}
    </SectionBox>
  );
}
