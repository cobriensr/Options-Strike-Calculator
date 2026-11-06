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

describe('classifyEconomicEvent', () => {
  it.each(CASES)('%s: %s', (expected, name) => {
    expect(classifyEconomicEvent(name)).toBe(expected);
  });
});
