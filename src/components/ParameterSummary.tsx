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

export default function ParameterSummary({ spySpot, spxLabel, spxValue, sigma, T, hoursLeft }: Props) {
  const items = [
    { label: 'SPY Spot', value: spySpot },
    { label: spxLabel, value: spxValue },
    { label: '\u03C3 (IV)', value: sigma },
    { label: 'T', value: T },
    { label: 'Hours Left', value: hoursLeft },
  ];

  return (
    <fieldset className="bg-surface-alt rounded-[10px] p-3.5 mb-4.5 grid grid-cols-2 gap-2 md:grid-cols-5 border-none m-0" aria-label="Calculation parameters">
      {items.map((item) => (
        <div key={item.label} className="text-center">
          <div className="text-[10px] uppercase text-tertiary tracking-[0.06em] font-sans font-bold">{item.label}</div>
          <div className="text-[15px] font-medium font-mono text-accent mt-0.5">{item.value}</div>
        </div>
      ))}
    </fieldset>
  );
}
