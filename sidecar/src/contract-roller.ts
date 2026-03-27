const QUARTER_MONTHS = [3, 6, 9, 12] as const;
const MONTH_CODES: Record<number, string> = {
  3: 'H',
  6: 'M',
  9: 'U',
  12: 'Z',
};

function thirdFriday(year: number, month: number): Date {
  const firstDay = new Date(year, month - 1, 1);
  const dayOfWeek = firstDay.getDay();
  const firstFriday = 1 + ((5 - dayOfWeek + 7) % 7);
  const third = firstFriday + 14;
  return new Date(year, month - 1, third);
}

export function resolveContractSymbol(now: Date = new Date()): string {
  const year = now.getFullYear();

  // Check this year's quarters then next year's first quarter
  const candidates: Array<{ month: number; expiryYear: number }> = [
    ...QUARTER_MONTHS.map((m) => ({ month: m, expiryYear: year })),
    { month: 3, expiryYear: year + 1 },
  ];

  for (const { month, expiryYear } of candidates) {
    const expiry = thirdFriday(expiryYear, month);
    const rollDate = new Date(expiry);
    rollDate.setDate(rollDate.getDate() - 7);

    if (now < rollDate) {
      const code = MONTH_CODES[month];
      const yearDigit = expiryYear % 10;
      return `ES${code}${yearDigit}`;
    }
  }

  // Fallback: should not be reached given the candidates above
  const nextYear = year + 1;
  return `ESH${nextYear % 10}`;
}
