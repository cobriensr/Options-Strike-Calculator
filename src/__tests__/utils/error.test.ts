import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../../utils/error';

describe('getErrorMessage', () => {
  it('returns the message property when err is an Error instance', () => {
    const err = new Error('something went wrong');
    expect(getErrorMessage(err)).toBe('something went wrong');
  });

  it('returns the string directly when err is a string', () => {
    expect(getErrorMessage('custom error string')).toBe('custom error string');
  });

  it('returns the fallback message for non-Error, non-string values', () => {
    expect(getErrorMessage(null)).toBe('An unexpected error occurred');
    expect(getErrorMessage(undefined)).toBe('An unexpected error occurred');
    expect(getErrorMessage(42)).toBe('An unexpected error occurred');
    expect(getErrorMessage({ message: 'obj' })).toBe(
      'An unexpected error occurred',
    );
  });
});
