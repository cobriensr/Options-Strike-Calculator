import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseEventsResponse } from '../lib/events-schema';
import { INVALID_SHAPE_ERROR } from '../lib/response-guard';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import type { EventItem } from '../types/api';

vi.mock('../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));
const mockCaptureUnlessAuth = vi.mocked(captureUnlessAuth);

const SOURCES: ReadonlyArray<EventItem['source']> = [
  'fred',
  'static',
  'finnhub',
];
const SEVERITIES: ReadonlyArray<EventItem['severity']> = ['high', 'medium'];

const COMBINATIONS = SOURCES.flatMap((source) =>
  SEVERITIES.map((severity) => [source, severity] as const),
);

function ev(
  source: EventItem['source'],
  severity: EventItem['severity'],
): EventItem {
  return {
    date: '2026-11-12',
    event: 'CPI',
    description: 'Consumer Price Index',
    time: '8:30',
    severity,
    source,
  };
}

function body(events: readonly EventItem[]) {
  return {
    events,
    startDate: '2026-11-12',
    endDate: '2026-12-12',
    cached: true,
    asOf: '2026-11-12T17:00:00.000Z',
  };
}

beforeEach(() => {
  mockCaptureUnlessAuth.mockReset();
});

describe('parseEventsResponse: what the schema accepts', () => {
  // `satisfies z.ZodType<EventItem>` accepts a schema narrower than the type,
  // so a dropped value would compile. Dropping 'finnhub' would reject the whole
  // forward list, and the banner, the snapshot flag and the analyze context
  // would all read "no events" for the session.
  it('covers every source and severity the type allows', () => {
    expect(COMBINATIONS).toHaveLength(6);
  });

  it.each(COMBINATIONS)(
    'accepts an event with source %s and severity %s',
    (source, severity) => {
      const events = [ev(source, severity)];

      const parsed = parseEventsResponse(body(events), { request: 'forward' });

      expect(parsed.events).toEqual(events);
      expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
    },
  );

  it('accepts a list holding all six combinations at once', () => {
    const events = COMBINATIONS.map(([source, severity]) =>
      ev(source, severity),
    );

    const parsed = parseEventsResponse(body(events), { request: 'forward' });

    expect(parsed.events).toEqual(events);
  });

  it('accepts an empty list and keeps the range it reports', () => {
    const parsed = parseEventsResponse(body([]), { request: 'forward' });

    expect(parsed.events).toEqual([]);
    expect(parsed.startDate).toBe('2026-11-12');
    expect(parsed.endDate).toBe('2026-12-12');
  });

  it('returns neither cached nor asOf: nothing reads them', () => {
    const parsed = parseEventsResponse(body([ev('fred', 'high')]), {
      request: 'forward',
    });

    expect(Object.keys(parsed).sort((a, b) => a.localeCompare(b))).toEqual([
      'endDate',
      'events',
      'startDate',
    ]);
  });
});

describe('parseEventsResponse: what the schema rejects', () => {
  it('throws INVALID_SHAPE_ERROR and reports once, with the request and issue count', () => {
    const malformed = {
      events: [{ ...ev('fred', 'high'), severity: 'extreme' }],
      startDate: '2026-11-12',
      endDate: '2026-12-12',
    };

    expect(() =>
      parseEventsResponse(malformed, { request: '2026-11-10' }),
    ).toThrow(INVALID_SHAPE_ERROR);

    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
    const [error, options] = mockCaptureUnlessAuth.mock.calls[0]!;
    expect((error as Error).message).toBe(
      'events response failed schema validation',
    );
    expect(options).toMatchObject({
      contexts: {
        events: {
          request: '2026-11-10',
          issueCount: 1,
          issues: [expect.stringMatching(/^events\.0\.severity: /)],
        },
      },
    });
  });

  it.each([
    [
      'a source the type does not list',
      { ...ev('fred', 'high'), source: 'uw' },
    ],
    [
      'a missing description',
      { ...ev('fred', 'high'), description: undefined },
    ],
  ])('rejects an event with %s', (_name, event) => {
    expect(() =>
      parseEventsResponse(
        { events: [event], startDate: '2026-11-12', endDate: '2026-11-12' },
        { request: 'forward' },
      ),
    ).toThrow(INVALID_SHAPE_ERROR);
    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not an object', 'CPI'],
    ['null', null],
    ['missing its range', { events: [] }],
  ])('rejects a body that is %s', (_name, malformed) => {
    expect(() =>
      parseEventsResponse(malformed, { request: 'forward' }),
    ).toThrow(INVALID_SHAPE_ERROR);
    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(mockCaptureUnlessAuth.mock.calls[0]![1]).toMatchObject({
      contexts: { events: { request: 'forward' } },
    });
  });
});
