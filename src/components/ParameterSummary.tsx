interface Props {
  spySpot: string;
  spxLabel: string;
  spxValue: string;
  sigma: string;
  T: string;
  hoursLeft: string;
}

export default function ParameterSummary({
  spySpot,
  spxLabel,
  spxValue,
  sigma,
  T,
  hoursLeft,
}: Readonly<Props>) {
  const items = [
    { label: 'SPY Spot', value: spySpot },
    { label: spxLabel, value: spxValue },
    { label: '\u03C3 (IV)', value: sigma },
    { label: 'T', value: T },
    { label: 'Hours Left', value: hoursLeft },
  ];

  return (
    <fieldset
      className="bg-surface-alt m-0 mb-4.5 grid grid-cols-2 gap-2 rounded-[10px] border-none p-3.5 md:grid-cols-5"
      aria-label="Calculation parameters"
    >
      {items.map((item) => (
        <div key={item.label} className="text-center">
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
            {item.label}
          </div>
          <div className="text-accent mt-0.5 font-mono text-[15px] font-medium">
            {item.value}
          </div>
        </div>
      ))}
    </fieldset>
  );
}
