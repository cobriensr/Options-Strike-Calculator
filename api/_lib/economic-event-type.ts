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

/**
 * A rule matches when `pattern` does and no `unless` guard does. The guards
 * are separate regexes, not part of `pattern`, so each stays under
 * `sonarjs/regex-complexity`.
 */
type Rule = readonly [
  type: EconomicEventType,
  pattern: RegExp,
  unless?: readonly RegExp[],
];

// A foreign central bank's decision is not the Fed's. build-features ORs FOMC
// rows into is_fomc, so one typed FOMC would flip the ML feature on a day the
// Fed is silent. Guards every FOMC rule. UW names the U.S. decision "U.S.
// interest rate decision", so a foreign one is often named by its country
// alone ("Japan interest rate decision"): the last two patterns are country
// names, as whole words ("Indiana" is not India). Abbreviations, bank names
// and countries are separate regexes so each stays under
// `sonarjs/regex-complexity`.
const FOREIGN_CENTRAL_BANK: readonly RegExp[] = [
  /\b(?:ECB|BoE|BoJ|BoC|BoK|RBA|RBNZ|RBI|SNB|PBOC|CBRT|Banxico)\b/i,
  /\bBank of (?:England|Japan|Canada|Korea)\b/i,
  /\bReserve Bank of (?:Australia|New Zealand|India)\b/i,
  /\b(?:European Central Bank|Swiss National Bank|Riksbank|Norges Bank)\b/i,
  /\bPeople['’]s Bank of China\b/i,
  /\b(?:Japan(?:ese)?|Canad(?:a|ian)|China|Chinese|India|Korea|Mexico|Brazil|Turkey|Sweden|Norway)\b/i,
  /\b(?:U\.?K|United Kingdom|British|Euro ?zone|Euro area|Australia|New Zealand|Swiss|Switzerland|South Africa)\b/i,
];

// A person speaking is never a survey or a decision, even when the title
// mentions one ("Philadelphia Fed President Paulson speaks on survey", "Fed's
// Waller speaks on the rate decision"). "Vice Chair" is covered by "Chair".
// Guards the district-survey rule and two FOMC rules, but not the press
// conference rule: "Fed Chair Powell press conference" carries "Chair".
const SPEAKER_WORDS: readonly RegExp[] = [
  /\b(?:President|Governor|Chair(?:man|woman)?|speaks|speech|remarks|testifies|panel)\b/i,
];

// What vetoes the rate-decision and economic-projections rules.
const NOT_A_DECISION: readonly RegExp[] = [
  ...FOREIGN_CENTRAL_BANK,
  ...SPEAKER_WORDS,
];

// `Fed` matches as a whole word only, so "federal" never matches it.
const RULES: readonly Rule[] = [
  // 1. The decision day. UW renamed "FOMC interest-rate decision" to "U.S.
  //    interest rate decision" in September 2026, so match the phrase, not
  //    the prefix. "rate decision" alone also takes "Fed rate decision" and
  //    "FOMC rate decision". A foreign central bank's decision is excluded
  //    (FOREIGN_CENTRAL_BANK), so "ECB interest rate decision" and "Japan
  //    interest rate decision" are OTHER. So is a speaker who mentions the
  //    decision or the projections (SPEAKER_WORDS): that is FED.
  ['FOMC', /\brate decision\b/i, NOT_A_DECISION],
  ['FOMC', /\bFOMC statement\b/i, FOREIGN_CENTRAL_BANK],
  [
    'FOMC',
    /\b(?:Fed|FOMC|Federal Reserve)\b.*\bpress conference\b/i,
    FOREIGN_CENTRAL_BANK,
  ],
  ['FOMC', /\beconomic projections\b/i, NOT_A_DECISION],

  // 2. Regional surveys, before the broad Fed rule: "Philadelphia Fed
  //    manufacturing survey" is a PMI, "Philadelphia Fed President ..." is
  //    FED. Only a district name directly before "Fed" (or "Fed's"), then
  //    survey or index after at most four whole words, counts as a survey. A
  //    speech title that merely mentions a survey ("... speaks on Survey of
  //    Professional Forecasters") is kept FED by SPEAKER_WORDS, which the
  //    four-word gap alone would not do for a short title.
  //    ISM and the Empire State survey carry no "Fed" at all.
  [
    'PMI',
    /\b(?:Boston|New York|Philadelphia|Cleveland|Richmond|Atlanta|Chicago|St\.? Louis|Minneapolis|Kansas City|Dallas|San Francisco) Fed(?:['’]s)? (?:[\w-]+ ){0,4}(?:survey|index)\b/i,
    SPEAKER_WORDS,
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
  for (const [type, pattern, unless] of RULES) {
    if (pattern.test(name) && !unless?.some((guard) => guard.test(name))) {
      return type;
    }
  }
  return 'OTHER';
}
