// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { parseTrailingJsonBlock } from '../_lib/json-fence.js';

// ============================================================
// parseTrailingJsonBlock — shared parser used by periscope-prompts
// and periscope-extract. Walks backward from the LAST closing fence
// to find a matching ```json open. O(n) via lastIndexOf, no regex.
// ============================================================

describe('parseTrailingJsonBlock', () => {
  it('extracts a well-formed trailing JSON block', () => {
    const text = [
      'Some prose.',
      '',
      '```json',
      '{"spot": 5800, "cone_lower": 5780}',
      '```',
    ].join('\n');

    const result = parseTrailingJsonBlock(text);
    expect(result).not.toBeNull();
    expect(result?.body).toBe('{"spot": 5800, "cone_lower": 5780}');
    // before keeps the prose with the trailing newline that preceded
    // the open fence.
    expect(result?.before).toContain('Some prose.');
    expect(result?.before).not.toContain('```json');
    expect(result?.after).toBe('');
  });

  it('returns null when no fences are present', () => {
    expect(parseTrailingJsonBlock('Just prose. No fences.')).toBeNull();
  });

  it('returns null when only a ```json open fence is present', () => {
    // A lone open fence with no matching close — degenerate input.
    const text = 'Prefix\n```json\n{"spot": 1}\n';
    expect(parseTrailingJsonBlock(text)).toBeNull();
  });

  it('returns the LAST block when two are present, leaving the first intact in `before`', () => {
    const text = [
      'Example shape:',
      '```json',
      '{"spot": 1}',
      '```',
      '',
      'Real output:',
      '```json',
      '{"spot": 5825}',
      '```',
    ].join('\n');

    const result = parseTrailingJsonBlock(text);
    expect(result).not.toBeNull();
    expect(result?.body).toBe('{"spot": 5825}');
    // The earlier block must still appear verbatim in `before`.
    expect(result?.before).toContain('```json');
    expect(result?.before).toContain('{"spot": 1}');
    expect(result?.before).toContain('```');
  });

  it('returns null when prose mentions a JSON snippet but has no closing fence', () => {
    // Open fence somewhere in prose without a matching close — the
    // backward walk finds the open as the lastIndexOf('```'), which
    // is then its own match (open === close → null).
    const text = 'Prose mentions ```json {"spot":1} and ends here.';
    expect(parseTrailingJsonBlock(text)).toBeNull();
  });

  it('returns null when the open fence has no newline after it', () => {
    // Without the newline marker we cannot determine the body start
    // and must reject rather than silently grab the wrong slice.
    const text = '```json{"spot": 1}```';
    expect(parseTrailingJsonBlock(text)).toBeNull();
  });

  it('returns body="" when the fences enclose only whitespace', () => {
    const text = '```json\n   \n```';
    const result = parseTrailingJsonBlock(text);
    expect(result).not.toBeNull();
    expect(result?.body).toBe('');
    expect(result?.before).toBe('');
    expect(result?.after).toBe('');
  });

  it('returns null when the only ```json appears AFTER the only ```', () => {
    // Close fence first, then a stray ```json — degenerate input that
    // earlier code rejected. lastIndexOf walks must keep that contract.
    const text = '``` no opener\nthen later ```json\n';
    expect(parseTrailingJsonBlock(text)).toBeNull();
  });

  it('captures `after` when text continues past the close fence', () => {
    const text = [
      'Prose.',
      '```json',
      '{"x": 1}',
      '```',
      'Trailing words.',
    ].join('\n');
    const result = parseTrailingJsonBlock(text);
    expect(result).not.toBeNull();
    expect(result?.after).toContain('Trailing words.');
  });
});
