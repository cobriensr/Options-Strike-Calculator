import { describe, it, expect } from 'vitest';
import { parseEntryTimeMinutes } from '../../utils/entry-time';

describe('parseEntryTimeMinutes', () => {
  // The app writes `${hour}:${minute} ${AM|PM} ${CT|ET}` (src/App.tsx), so
  // those are the labels prod rows carry. Minutes since midnight CT.
  it.each([
    ['9:30 AM CT', 570],
    ['10:00 AM CT', 600],
    ['11:59 AM CT', 719],
    ['2:55 PM CT', 895],
    ['3:00 PM CT', 900],
  ])('reads the CT label %s as %i', (label, minutes) => {
    expect(parseEntryTimeMinutes(label)).toBe(minutes);
  });

  // An ET label is one hour later on the clock than the same moment in CT.
  it.each([
    ['9:30 AM ET', 510],
    ['10:30 AM ET', 570],
    ['3:00 PM ET', 840],
    ['4:00 PM ET', 900],
  ])('shifts the ET label %s to CT: %i', (label, minutes) => {
    expect(parseEntryTimeMinutes(label)).toBe(minutes);
  });

  it('puts the same moment in either zone on the same minute', () => {
    expect(parseEntryTimeMinutes('9:30 AM CT')).toBe(
      parseEntryTimeMinutes('10:30 AM ET'),
    );
    expect(parseEntryTimeMinutes('2:00 PM CT')).toBe(
      parseEntryTimeMinutes('3:00 PM ET'),
    );
  });

  // Rows saved before the zone suffix existed carry a bare "H:MM AM".
  it.each([
    ['9:35 AM', 575],
    ['3:00 PM', 900],
  ])('reads the legacy label %s as CT: %i', (label, minutes) => {
    expect(parseEntryTimeMinutes(label)).toBe(minutes);
  });

  it.each([
    ['12:00 AM CT', 0],
    ['12:30 AM CT', 30],
    ['12:00 PM CT', 720],
    ['12:59 PM CT', 779],
    ['1:00 PM CT', 780],
    ['12:00 AM', 0],
    ['12:00 PM', 720],
  ])('reads %s on the 12-hour clock as %i', (label, minutes) => {
    expect(parseEntryTimeMinutes(label)).toBe(minutes);
  });

  it('reads the 9:30 open in every form the app can write', () => {
    expect(parseEntryTimeMinutes('9:30 AM CT')).toBe(570);
    expect(parseEntryTimeMinutes('9:30 AM')).toBe(570);
    expect(parseEntryTimeMinutes('09:30 AM CT')).toBe(570);
    expect(parseEntryTimeMinutes('9:30 AM ET')).toBe(510);
  });

  it('ignores case, surrounding whitespace and a missing space before AM/PM', () => {
    expect(parseEntryTimeMinutes('9:30 am ct')).toBe(570);
    expect(parseEntryTimeMinutes('  9:30 AM CT  ')).toBe(570);
    expect(parseEntryTimeMinutes('9:30AM CT')).toBe(570);
  });

  it('keeps an ET label after midnight ET ahead of every CT minute of that date', () => {
    // 12:30 AM ET is 11:30 PM CT the evening before, so it sorts first.
    expect(parseEntryTimeMinutes('12:30 AM ET')).toBe(-30);
  });

  it.each([
    ['pre-market'],
    [''],
    ['unknown'],
    ['lunch'],
    ['9:30'],
    ['14:30'],
    ['14:30 PM CT'],
    ['13:00 PM CT'],
    ['0:30 AM CT'],
    ['9:60 AM CT'],
    ['9:300 AM CT'],
    ['9:30 AM CST'],
    ['9:30 AM PT'],
    ['9:30 AM CT extra'],
    ['2026-03-10T15:30:00.000Z'],
  ])('gives NaN for the malformed or non-time label %j', (label) => {
    expect(parseEntryTimeMinutes(label)).toBeNaN();
  });
});
