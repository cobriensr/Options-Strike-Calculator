# Periscope Panel — time-travel navigation

**Date:** 2026-05-08
**Status:** in progress

## Goal

Let the user navigate the Periscope MM Exposure panel back through prior
slots and prior trading dates without leaving the panel — same data UI as
"Live" mode, just resolved against a picked timestamp.

## Why

The panel today is locked to "latest slot for today". Debriefs (looking
at a 13:30 slot to see what the chart said at HOD) and back-tests
("what did 09:00 look like on 2026-05-07?") require opening UW directly.
The data is already in `periscope_snapshots` going back to 2026-04-21+;
this exposes it.

## Phases

### Phase 1 — Backend params + slot list

Touch: `api/periscope-exposure.ts`, new tests in
`api/__tests__/periscope-exposure.test.ts`.

`/api/periscope-exposure` accepts:

- `?date=YYYY-MM-DD` — trading date (CT). Defaults to today's CT date.
- `?time=HH:MM` — CT wall clock. Defaults to "now" (= latest behavior).
- `?spot=...` — already exists.

Behavior:

- `date` + `time` → resolves to ISO `asOf`, passed through to
  `buildPeriscopeView({ date, expiry: date, spot, asOf })`.
- `date` only → `asOf` is end-of-day for that date (resolves to last slot
  of the day).
- Neither → unchanged (latest slot, today).

Spot resolution when `date+time` is set:

- Use `?spot=` if provided (frontend may pass slot-time spot from a
  separate lookup). Otherwise fall back to closest `index_candles_1m`
  close at-or-before the timestamp for the picked date.

Response also gains an `availableSlots` array — captured_at timestamps
(ISO) for every distinct slot in `periscope_snapshots` for the picked
`date` and panel='gamma' (gamma is the anchor; charm/vanna are
guaranteed to align by the per-row timeframe migration #141). This
backs the prev/next stepper.

```ts
{
  marketOpen: boolean,
  asOf: string,
  data: PeriscopeView | null,
  reason?: 'no_spot' | 'no_slot',
  availableSlots: string[],   // ISO timestamps, ascending
}
```

Cone & breaches: `fetchConeLevels(date)` + `fetchConeBreaches(date, asOf)`
both already exist and already do the right thing.

### Phase 2 — Frontend nav UI

Touch: `src/hooks/usePeriscopeExposure.ts`,
`src/components/Periscope/PeriscopePanel.tsx`,
new test cases in the existing test files.

Hook changes:

- New input: `selectedSlot: { date: string; time: string } | null`
  (null = follow Live).
- When selected: pause polling, fetch with `?date=&time=`, no auto-refresh.
- When null: existing live polling behavior.
- Return `availableSlots` from the response so the UI can step.

Panel header gains three controls:

- **Date picker** (`<input type="date">`). When changed, sets selected
  slot to `{ date, time: <last slot of new date or current time> }`.
- **Slot stepper**: prev/next buttons that walk `availableSlots` for the
  picked date. Disabled at the ends. Display the picked slot CT time
  next to the buttons (`08:30 → 08:40 → ...`).
- **Live button**: highlighted when `selectedSlot == null`. Click to
  drop back to live + resume polling.

Empty state: when picked date has zero slots, render the existing
`emptyReason: 'no_slot'` placeholder unchanged. The panel won't crash
or auto-skip.

## Files to create/modify

- `api/periscope-exposure.ts` — date/time params, availableSlots
- `api/__tests__/periscope-exposure.test.ts` — params test cases
- `src/hooks/usePeriscopeExposure.ts` — selectedSlot state + pause polling
- `src/__tests__/usePeriscopeExposure.test.tsx` — picked-slot fetch
- `src/components/Periscope/PeriscopePanel.tsx` — three new controls
- `src/__tests__/PeriscopePanel.test.tsx` — control-rendering tests

## Data dependencies

None new — all reads against existing tables.

- `periscope_snapshots` (slot data + slot list query)
- `cone_levels` (per-date)
- `cone_breach_events` (capped at asOf)
- `index_candles_1m` (spot fallback)

## Open questions

- **Polling cadence when not Live**: settled — paused entirely. User can
  click Live to resume.
- **Deep-linkable URLs**: out of scope this round. Add later if useful.
- **Cross-date stepping** (prev button on first slot of day → last slot
  of prior date): out of scope. User uses date picker for that.

## Thresholds / constants

- `availableSlots` panel filter: `panel = 'gamma'` (anchor panel).
