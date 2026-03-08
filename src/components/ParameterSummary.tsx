import type { Theme } from '../themes';

interface Props {
  th: Theme;
  spySpot: string;
  spxLabel: string;
  spxValue: string;
  sigma: string;
  T: string;
  hoursLeft: string;
}

export default function ParameterSummary({ th, spySpot, spxLabel, spxValue, sigma, T, hoursLeft }: Props) {
  const items = [
    { label: 'SPY Spot', value: spySpot },
    { label: spxLabel, value: spxValue },
    { label: '\u03C3 (IV)', value: sigma },
    { label: 'T', value: T },
    { label: 'Hours Left', value: hoursLeft },
  ];

  return (
    <fieldset style={{ backgroundColor: th.surfaceAlt, borderRadius: 10, padding: 14, marginBottom: 18, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, border: 'none', margin: 0 }} aria-label="Calculation parameters">
      {items.map((item) => (
        <div key={item.label} style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', color: th.textTertiary, letterSpacing: '0.06em', fontFamily: "'Outfit', sans-serif", fontWeight: 700 }}>{item.label}</div>
          <div style={{ fontSize: 15, fontWeight: 500, fontFamily: "'DM Mono', monospace", color: th.accent, marginTop: 3 }}>{item.value}</div>
        </div>
      ))}
    </fieldset>
  );
}
