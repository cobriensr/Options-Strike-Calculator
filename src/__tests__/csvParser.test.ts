import { describe, it, expect } from 'vitest';
import { parseVixCSV } from '../csvParser';

describe('parseVixCSV: standard formats', () => {
  it('parses YYYY-MM-DD format', () => {
    const csv = `Date,Open,High,Low,Close
2024-03-04,14.50,15.20,14.10,14.80
2024-03-05,14.80,16.00,14.60,15.50`;

    const result = parseVixCSV(csv);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result['2024-03-04']).toEqual({
      open: 14.5,
      high: 15.2,
      low: 14.1,
      close: 14.8,
    });
  });

  it('parses MM/DD/YYYY format', () => {
    const csv = `Date,Open,High,Low,Close
03/04/2024,14.50,15.20,14.10,14.80`;

    const result = parseVixCSV(csv);
    expect(result['2024-03-04']).toBeDefined();
    expect(result['2024-03-04']?.open).toBe(14.5);
  });

  it('parses M/D/YY format (2-digit year)', () => {
    const csv = `Date,Open,High,Low,Close
3/4/24,14.50,15.20,14.10,14.80`;

    const result = parseVixCSV(csv);
    expect(result['2024-03-04']).toBeDefined();
  });

  it('handles "Adj Close" column name', () => {
    const csv = `Date,Open,High,Low,Adj Close
2024-03-04,14.50,15.20,14.10,14.80`;

    const result = parseVixCSV(csv);
    expect(result['2024-03-04']?.close).toBe(14.8);
  });

  it('handles case-insensitive headers', () => {
    const csv = `DATE,OPEN,HIGH,LOW,CLOSE
2024-03-04,14.50,15.20,14.10,14.80`;

    const result = parseVixCSV(csv);
    expect(result['2024-03-04']).toBeDefined();
  });
});

describe('parseVixCSV: edge cases', () => {
  it('returns empty object for empty string', () => {
    expect(parseVixCSV('')).toEqual({});
  });

  it('returns empty object for header only', () => {
    expect(parseVixCSV('Date,Open,High,Low,Close')).toEqual({});
  });

  it('returns empty object for missing Date column', () => {
    const csv = `Open,High,Low,Close
14.50,15.20,14.10,14.80`;

    expect(parseVixCSV(csv)).toEqual({});
  });

  it('handles missing OHLC columns gracefully', () => {
    const csv = `Date,Close
2024-03-04,14.80`;

    const result = parseVixCSV(csv);
    expect(result['2024-03-04']).toEqual({
      open: null,
      high: null,
      low: null,
      close: 14.8,
    });
  });

  it('handles empty lines in CSV', () => {
    const csv = `Date,Open,High,Low,Close
2024-03-04,14.50,15.20,14.10,14.80

2024-03-05,14.80,16.00,14.60,15.50`;

    const result = parseVixCSV(csv);
    expect(Object.keys(result)).toHaveLength(2);
  });

  it('handles non-numeric values as null', () => {
    const csv = `Date,Open,High,Low,Close
2024-03-04,N/A,15.20,14.10,14.80`;

    const result = parseVixCSV(csv);
    expect(result['2024-03-04']?.open).toBeNull();
    expect(result['2024-03-04']?.high).toBe(15.2);
  });

  it('handles large dataset without error', () => {
    const lines = ['Date,Open,High,Low,Close'];
    for (let i = 0; i < 9000; i++) {
      const date = new Date(1990, 0, 1 + i);
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      lines.push(`${y}-${m}-${d},20.00,21.00,19.00,20.50`);
    }
    const csv = lines.join('\n');
    const result = parseVixCSV(csv);
    expect(Object.keys(result).length).toBe(9000);
  });

  it('trims whitespace from values', () => {
    const csv = `Date, Open , High , Low , Close
2024-03-04 , 14.50 , 15.20 , 14.10 , 14.80`;

    const result = parseVixCSV(csv);
    expect(result['2024-03-04']?.open).toBe(14.5);
  });
});
