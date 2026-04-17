/**
 * Small presentational primitives used across FuturesCalculator panels:
 *   - FieldLabel: uppercase caption above a control
 *   - PriceInput: numeric text input with label; strips non-digits
 *   - ResultRow: label/value row inside results panels
 */

import type React from 'react';
import { theme } from '../../themes';

export function FieldLabel({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <span className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase">
      {children}
    </span>
  );
}

interface PriceInputProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}

export function PriceInput({
  id,
  label,
  value,
  onChange,
  placeholder,
}: Readonly<PriceInputProps>) {
  return (
    <div>
      <label
        htmlFor={id}
        className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value.replaceAll(/[^0-9.]/g, ''))}
        className="bg-input border-edge-strong hover:border-edge-heavy text-primary w-full rounded-lg border-[1.5px] px-3 py-[11px] font-mono text-sm transition-[border-color] duration-150 outline-none"
      />
    </div>
  );
}

interface ResultRowProps {
  label: string;
  value: string;
  color?: string;
  bold?: boolean;
}

export function ResultRow({
  label,
  value,
  color,
  bold = false,
}: Readonly<ResultRowProps>) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span
        className="font-sans text-[11px]"
        style={{ color: theme.textMuted }}
      >
        {label}
      </span>
      <span
        className={`font-mono text-[13px] ${bold ? 'font-bold' : 'font-medium'}`}
        style={{ color: color ?? theme.text }}
      >
        {value}
      </span>
    </div>
  );
}
