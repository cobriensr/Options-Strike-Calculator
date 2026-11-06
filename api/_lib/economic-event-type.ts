/**
 * Name-based classifier for economic-calendar events.
 *
 * `FOMC` means the Fed's decision-day releases only: the rate decision, the
 * statement, the press conference and the economic projections. Every other
 * Fed mention is `FED` (speeches, testimony, minutes, the Beige Book), and a
 * regional Fed survey is `PMI`. UW's own `type` field is unreliable ("Fed
 * speech: ..." comes back as `report`), so the name is the only input.
 *
 * Rules run in order and the first match wins. Spec:
 * docs/superpowers/specs/2026-11-06-economic-events-fomc-classification.md.
 */

export type EconomicEventType =
  | 'FOMC'
  | 'FED'
  | 'CPI'
  | 'PCE'
  | 'JOBS'
  | 'GDP'
  | 'PMI'
  | 'RETAIL'
  | 'SENTIMENT'
  | 'OTHER';

type Rule = readonly [type: EconomicEventType, pattern: RegExp];

// `Fed` matches as a whole word only, so "federal" never matches it.
const RULES: readonly Rule[] = [
  // 1. The decision day. UW renamed "FOMC interest-rate decision" to "U.S.
  //    interest rate decision" in September 2026, so match the phrase, not
  //    the prefix.
  ['FOMC', /\binterest[- ]rate decision\b/i],
  ['FOMC', /\bFOMC statement\b/i],
  ['FOMC', /\b(?:Fed|FOMC|Federal Reserve)\b.*\bpress conference\b/i],
  ['FOMC', /\beconomic projections\b/i],

  // 2. Regional surveys, before the broad Fed rule: "Philadelphia Fed
  //    manufacturing survey" is a PMI, "Philadelphia Fed President ..." is
  //    FED. Only a district name directly before "Fed", then survey or index
  //    within 40 characters, counts as a survey. ISM and the Empire State
  //    survey carry no "Fed" at all.
  [
    'PMI',
    /\b(?:Boston|New York|Philadelphia|Cleveland|Richmond|Atlanta|Chicago|St\.? Louis|Minneapolis|Kansas City|Dallas|San Francisco) Fed\b.{0,40}?\b(?:survey|index)\b/i,
  ],
  ['PMI', /\bEmpire State\b.*\b(?:survey|index)\b/i],
  ['PMI', /\bISM\b/i],

  // 3. Any other Fed mention.
  [
    'FED',
    /\b(?:Fed|FRB|FOMC)\b|Federal Reserve|Federal Open Market|Beige Book/i,
  ],

  // 4-9. The old rules, unchanged.
  ['CPI', /CPI|Consumer Price/i],
  ['PCE', /PCE/i],
  ['JOBS', /Nonfarm|Employment|Jobs/i],
  ['GDP', /GDP/i],
  ['PMI', /PMI/i],
  ['RETAIL', /Retail/i],

  // 10. UW renamed "Consumer sentiment" to "U. Michigan ... Consumer Survey".
  ['SENTIMENT', /sentiment|Michigan.*Consumer/i],
];

export function classifyEconomicEvent(name: string): EconomicEventType {
  for (const [type, pattern] of RULES) {
    if (pattern.test(name)) return type;
  }
  return 'OTHER';
}
