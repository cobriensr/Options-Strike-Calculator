/**
 * Account balance + risk-% persistence for FuturesCalculator.
 *
 * Persists both values to localStorage so day traders don't re-enter them
 * every session. All errors swallowed — private/incognito and quota-exceeded
 * paths degrade to in-memory only.
 */

import { useCallback, useState } from 'react';

const ACCOUNT_KEY = 'fc-account';
const RISK_PCT_KEY = 'fc-riskpct';
const DEFAULT_RISK_PCT = '1';

function readLocal(key: string, fallback = ''): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* noop — quota exceeded or private mode */
  }
}

export interface AccountSettings {
  accountInput: string;
  riskPctInput: string;
  account: number;
  riskPct: number;
  accountValid: boolean;
  riskPctValid: boolean;
  derivedMaxRisk: number | null;
  setAccountInput: (v: string) => void;
  setRiskPctInput: (v: string) => void;
}

export function useAccountSettings(): AccountSettings {
  const [accountInput, setAccountInputState] = useState(() =>
    readLocal(ACCOUNT_KEY),
  );
  const [riskPctInput, setRiskPctInputState] = useState(() =>
    readLocal(RISK_PCT_KEY, DEFAULT_RISK_PCT),
  );

  const setAccountInput = useCallback((v: string) => {
    setAccountInputState(v);
    writeLocal(ACCOUNT_KEY, v);
  }, []);

  const setRiskPctInput = useCallback((v: string) => {
    setRiskPctInputState(v);
    writeLocal(RISK_PCT_KEY, v);
  }, []);

  const account = Number.parseFloat(accountInput);
  const accountValid = Number.isFinite(account) && account > 0;
  const riskPct = Number.parseFloat(riskPctInput);
  const riskPctValid = Number.isFinite(riskPct) && riskPct > 0;
  const derivedMaxRisk =
    accountValid && riskPctValid ? (account * riskPct) / 100 : null;

  return {
    accountInput,
    riskPctInput,
    account,
    riskPct,
    accountValid,
    riskPctValid,
    derivedMaxRisk,
    setAccountInput,
    setRiskPctInput,
  };
}
