// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  classifyEconomicEvent,
  type EconomicEventType,
} from '../_lib/economic-event-type.js';

// Real names from the production economic_events inventory (2026-11-06).
// Two traps are in here on purpose:
//  - "Illinois Manufacturers' Association" is a speech venue, so it is FED,
//    not PMI.
//  - A Philadelphia Fed *president's* speech is FED; only the Philadelphia Fed
//    *survey* is PMI.
const NAMES_BY_TYPE: Record<EconomicEventType, readonly string[]> = {
  FOMC: [
    'U.S. interest rate decision',
    'FOMC interest-rate decision',
    'Fed Chair Powell press conference',
    'Fed Chairman Warsh press conference',
    'Federal Reserve economic projections',
  ],
  PMI: [
    'Philadelphia Fed manufacturing survey',
    'Philadelphia Fed Business Outlook Survey',
    'Kansas City Fed Survey',
    "Atlanta Fed's Business Inflation Expectations survey",
    'Dallas Fed Texas Service Sector Outlook Survey',
    'Empire State Manufacturing Survey',
    'Empire State manufacturing survey',
    'ISM manufacturing',
    'ISM services',
    'ISM Report On Business Manufacturing PMI',
    'Chicago Business Barometer - ISM-Chicago Business Survey - Chicago PMI',
    'US Flash Services PMI',
    'S&P final U.S. manufacturing PMI',
  ],
  FED: [
    'Fed speech: Fed governor Michelle Bowman',
    'Federal Reserve Bank of St. Louis President Alberto Musalem speaks at Greater St. Louis, Inc event',
    "FRB Chicago President Austan Goolsbee speaks at 'Why Consumers and Economists See Different Economies' discussion",
    'FRB Cleveland President Beth Hammack moderated conversation with students from Ohio State University',
    "Federal Reserve Bank of Chicago President Austan Goolsbee speaks at Illinois Manufacturers' Association event",
    "Minutes of Fed's June FOMC meeting",
    'Federal Open Market Committee meeting minutes',
    'FOMC Meeting Minutes',
    'Fed Beige Book',
    'Federal Reserve Beige Book',
    'Federal Reserve Chairman Kevin Warsh testifies to Congress',
    'Atlantic Council event with Federal Reserve Vice Chair Michelle Bowman',
    'Economic Club of Washington, DC event with Federal Reserve Bank of Richmond President Thomas Barkin',
    'Philadelphia Fed President Anna Paulson speech',
    'Philadelphia Fed President Paulson speaks on survey',
    'Boston Fed President Susan Collins, Richmond Fed President Tom Barkin and Philadelphia Fed President Anna Paulson on a panel about rural economy',
    'New York Fed President John Williams speaks',
  ],
  CPI: ['CPI', 'Core CPI, M/M%', 'Consumer price index'],
  PCE: ['PCE Price Idx, M/M%', 'Core PCE index'],
  JOBS: [
    'Employment Report',
    'U.S. unemployment rate',
    'ADP National Employment Report',
    'Nonfarm Payrolls',
  ],
  GDP: ['GDP Growth Rate'],
  RETAIL: ['Retail Sales', 'Advanced retail inventories'],
  SENTIMENT: [
    'U. Michigan Prelim Consumer Survey',
    'U. Michigan Final Consumer Survey',
    'Consumer sentiment (prelim)',
    'Consumer sentiment (final)',
  ],
  OTHER: [
    'Monthly U.S. federal budget',
    'Initial jobless claims',
    'Weekly Jobless Claims',
    'PPI',
    'Core PPI',
    'Job Openings & Labor Turnover Survey',
    'Conference Bd - Consumer Confidence',
    'Avg Hourly Earnings, M/M%',
    'Housing starts',
  ],
};

const CASES: ReadonlyArray<readonly [EconomicEventType, string]> =
  Object.entries(NAMES_BY_TYPE).flatMap(([type, names]) =>
    names.map((name) => [type as EconomicEventType, name] as const),
  );

const DISTRICTS = [
  'Boston',
  'New York',
  'Philadelphia',
  'Cleveland',
  'Richmond',
  'Atlanta',
  'Chicago',
  'St. Louis',
  'Minneapolis',
  'Kansas City',
  'Dallas',
  'San Francisco',
] as const;

describe('classifyEconomicEvent', () => {
  it.each(CASES)('%s: %s', (expected, name) => {
    expect(classifyEconomicEvent(name)).toBe(expected);
  });

  // A district's survey is a PMI, but its president speaking is FED. Both
  // have to hold for every one of the 12 districts.
  it.each(DISTRICTS)('%s Fed manufacturing survey is PMI', (district) => {
    expect(classifyEconomicEvent(`${district} Fed manufacturing survey`)).toBe(
      'PMI',
    );
  });

  it.each(DISTRICTS)('%s Fed President speaking is FED', (district) => {
    expect(
      classifyEconomicEvent(`${district} Fed President Jane Doe speaks`),
    ).toBe('FED');
  });

  // The survey rule allows a few words between "Fed" and "survey|index", not
  // an arbitrary stretch of text: a speech title that merely mentions a survey
  // or an index is still a speech.
  it.each([
    'Philadelphia Fed President Anna Paulson speaks on Survey of Professional Forecasters',
    'Philadelphia Fed President Anna Paulson speaks at index funds conference',
  ])('speech that mentions a survey or index stays FED: %s', (name) => {
    expect(classifyEconomicEvent(name)).toBe('FED');
  });

  it('a district survey with a longer title is still PMI', () => {
    expect(
      classifyEconomicEvent('Dallas Fed Texas Manufacturing Outlook Survey'),
    ).toBe('PMI');
  });

  // The possessive ("Atlanta Fed's ...") is the same survey, curly apostrophe
  // included.
  it.each([
    "Atlanta Fed's Business Inflation Expectations survey",
    'Atlanta Fed’s Business Inflation Expectations survey',
  ])('possessive district survey is PMI: %s', (name) => {
    expect(classifyEconomicEvent(name)).toBe('PMI');
  });

  // Four words may sit between "Fed" and "survey", so a short speech title
  // would pass the gap. A speaker word keeps it FED.
  it.each([
    'President',
    'Governor',
    'Chair',
    'Chairman',
    'Chairwoman',
    'Vice Chair',
    'speaks',
    'speech',
    'remarks',
    'testifies',
    'panel',
  ])('a title with the speaker word "%s" is never a survey', (word) => {
    expect(classifyEconomicEvent(`Richmond Fed ${word} survey`)).toBe('FED');
  });

  // UW calls the decision "U.S. interest rate decision", but the phrase is
  // not fixed, so any "rate decision" is the decision day.
  it.each(['Fed rate decision', 'FOMC rate decision'])(
    'rate decision without "interest": %s',
    (name) => {
      expect(classifyEconomicEvent(name)).toBe('FOMC');
    },
  );

  // build-features ORs FOMC rows into is_fomc, so a foreign central bank's
  // decision typed FOMC would flip the ML feature on a day the Fed is silent.
  it.each([
    'ECB interest rate decision',
    'Bank of Canada rate decision',
    'BoE interest rate decision',
    'BoJ interest rate decision',
    'Bank of England interest rate decision',
    'Bank of Japan rate decision',
    'RBA interest rate decision',
    'RBNZ interest rate decision',
    'SNB interest rate decision',
    'PBOC loan prime rate decision',
    'Riksbank interest rate decision',
    'Norges Bank interest rate decision',
  ])('foreign central bank decision is OTHER: %s', (name) => {
    expect(classifyEconomicEvent(name)).toBe('OTHER');
  });

  // The exclusion covers every FOMC rule, not only the rate-decision one.
  it.each([
    'ECB economic projections',
    'BoE economic projections',
    'ECB President Lagarde press conference',
  ])('foreign central bank release is not FOMC: %s', (name) => {
    expect(classifyEconomicEvent(name)).not.toBe('FOMC');
  });

  it('keeps the U.S. decision FOMC beside the foreign ones', () => {
    expect(classifyEconomicEvent('U.S. interest rate decision')).toBe('FOMC');
  });
});
