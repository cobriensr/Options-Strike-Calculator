import type {
  CashEntry,
  DataQualityWarning,
  IronCondor,
  NakedPosition,
  OpenLeg,
  PnLSummary,
  Spread,
  WarningCode,
  WarningSeverity,
} from '../types';
import type { SectionBounds } from './section-parsers';

// ── Data Quality Warnings ──────────────────────────────────

export function generateWarnings(
  cashEntries: CashEntry[],
  openLegs: OpenLeg[],
  hasMark: boolean,
  pnl: PnLSummary,
  naked: NakedPosition[],
  sections: Map<string, SectionBounds>,
  spreads: Spread[],
  ironCondors: IronCondor[],
): DataQualityWarning[] {
  const warnings: DataQualityWarning[] = [];

  // Always emit PAPER_TRADING
  warnings.push(
    makeWarning(
      'PAPER_TRADING',
      'info',
      'This data is from a paperMoney account.' + ' Results are simulated.',
    ),
  );

  // MISSING_MARK
  if (!hasMark && openLegs.length > 0) {
    warnings.push(
      makeWarning(
        'MISSING_MARK',
        'warn',
        'Options section lacks Mark/Mark Value columns.' +
          ' Current market values unavailable.',
      ),
    );
  }

  // UNMATCHED_SHORT
  for (const n of naked) {
    const msg =
      `Naked short ${n.type} at strike ` +
      `${n.leg.strike} (${n.contracts} contracts).` +
      ' No matching long leg found.';
    warnings.push(
      makeWarning(
        'UNMATCHED_SHORT',
        'error',
        msg,
        `Option code: ${n.leg.optionCode}`,
      ),
    );
  }

  // BALANCE_DISCONTINUITY
  for (let i = 1; i < cashEntries.length; i++) {
    const prev = cashEntries[i - 1]!;
    const curr = cashEntries[i]!;
    if (curr.type === 'BAL') continue;

    const expectedBalance =
      prev.balance + curr.amount + curr.miscFees + curr.commissions;
    const diff = Math.abs(expectedBalance - curr.balance);

    if (diff > 0.02) {
      const expected = expectedBalance.toFixed(2);
      const actual = curr.balance.toFixed(2);
      const diffStr = diff.toFixed(2);
      const detail =
        `Expected ${expected}, got ${actual}` + ` (diff: ${diffStr})`;
      warnings.push(
        makeWarning(
          'BALANCE_DISCONTINUITY',
          'warn',
          `Balance mismatch after ${curr.type}` + ` at ${curr.time}.`,
          detail,
        ),
      );
    }
  }

  // MISSING_SECTION
  const expectedSections = [
    'Cash Balance',
    'Account Order History',
    'Account Trade History',
    'Options',
    'Profits and Losses',
    'Account Summary',
  ];
  for (const name of expectedSections) {
    if (!sections.has(name)) {
      warnings.push(
        makeWarning(
          'MISSING_SECTION',
          'warn',
          `Expected section "${name}" not found in CSV.`,
        ),
      );
    }
  }

  // PNL_MISMATCH — compare computed credit to P&L section
  if (pnl.totals) {
    let computedOpenPnl = 0;
    for (const spread of spreads) {
      computedOpenPnl += spread.creditReceived;
    }
    for (const ic of ironCondors) {
      computedOpenPnl += ic.totalCredit;
    }

    // Flag large discrepancies between reported and computed
    if (pnl.totals.markValue !== 0 && computedOpenPnl !== 0) {
      const reported = pnl.totals.plOpen;
      if (openLegs.length > 0 && Math.abs(reported) > computedOpenPnl * 5) {
        const reportedStr = reported.toFixed(2);
        warnings.push(
          makeWarning(
            'PNL_MISMATCH',
            'warn',
            `Reported P/L Open ($${reportedStr})` +
              ' may not match computed positions.',
            'This can happen if positions were' + ' opened on prior days.',
          ),
        );
      }
    }
  }

  return warnings;
}

function makeWarning(
  code: WarningCode,
  severity: WarningSeverity,
  message: string,
  detail?: string,
): DataQualityWarning {
  return detail
    ? { code, severity, message, detail }
    : { code, severity, message };
}
