import type { CSSProperties, ReactNode } from 'react';
import type { Theme } from '../themes';

/** Build a data URI for a dropdown chevron */
export function buildChevronUrl(color: string): string {
  return (
    'url("data:image/svg+xml,' +
    encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><path d="M3 5l3 3 3-3" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`) +
    '")'
  );
}

/** Reusable section wrapper with label and optional badge */
export function SectionBox({ th, label, badge, headerRight, children }: {
  th: Theme; label: string; badge?: string | null; headerRight?: ReactNode; children: ReactNode;
}) {
  return (
    <section aria-label={label} style={{
      backgroundColor: th.surface, border: '1.5px solid ' + th.border, borderRadius: 14, padding: '18px 18px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.03)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.14em', color: th.textTertiary }}>{label}</div>
          {badge && <span style={{ fontSize: 10, fontWeight: 600, color: th.accent, backgroundColor: th.accentBg, padding: '2px 8px', borderRadius: 99, fontFamily: "'DM Mono', monospace" }}>{badge}</span>}
        </div>
        {headerRight}
      </div>
      {children}
    </section>
  );
}

/** Chip toggle button */
export function Chip({ th, active, onClick, label }: {
  th: Theme; active: boolean; onClick: () => void; label: string;
}) {
  return (
    <button onClick={onClick} role="radio" aria-checked={active} style={{
      padding: '6px 14px', borderRadius: 99, fontSize: 13, fontWeight: 500, cursor: 'pointer',
      border: '1.5px solid ' + (active ? th.chipActiveBorder : th.chipBorder),
      backgroundColor: active ? th.chipActiveBg : th.chipBg,
      color: active ? th.chipActiveText : th.chipText,
      fontFamily: "'DM Mono', monospace", transition: 'all 0.1s',
    }}>
      {label}
    </button>
  );
}

/** Error message display */
export function ErrorMsg({ th, children, id }: { th: Theme; children: ReactNode; id?: string }) {
  return (
    <div id={id} role="alert" style={{
      fontSize: 13, color: th.red, marginTop: 6,
      fontFamily: "'DM Mono', monospace", fontWeight: 500,
    }}>
      {children}
    </div>
  );
}

/** Table header cell style */
export function mkTh(th: Theme, align: string, color?: string): CSSProperties {
  return {
    padding: '10px 12px', textAlign: align as CSSProperties['textAlign'], fontSize: 11, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.06em', color: color ?? th.textTertiary,
    borderBottom: '2px solid ' + th.border, fontFamily: "'Outfit', sans-serif", whiteSpace: 'nowrap',
  };
}

/** Table data cell style */
export function mkTd(th: Theme): CSSProperties {
  return { padding: '10px 12px', borderBottom: '1px solid ' + th.border, whiteSpace: 'nowrap' as const, fontSize: 14 };
}

/** Format a dollar amount with commas, no cents for values >= $100 */
export function fmtDollar(value: number): string {
  if (Math.abs(value) >= 100) {
    return Math.round(value).toLocaleString('en-US');
  }
  return value.toFixed(2);
}

/** Screen reader-only style */
export const srOnly: CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', borderWidth: 0,
};

/** Tiny label style */
export function tinyLblStyle(th: Theme): CSSProperties {
  return {
    display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.08em', color: th.textTertiary, fontFamily: "'Outfit', sans-serif",
    marginBottom: 5,
  };
}
