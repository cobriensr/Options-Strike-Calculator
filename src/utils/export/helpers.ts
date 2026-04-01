import type * as XLSX from 'xlsx';

export type { CalculationResults, DeltaRow } from '../../types';

export function setColumnWidths(
  ws: XLSX.WorkSheet,
  widths: number[],
): void {
  ws['!cols'] = widths.map((w) => ({ wch: w }));
}
