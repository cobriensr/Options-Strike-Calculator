/**
 * AddContractForm — modal dialog with a tab switch between a
 * structured form and a free-text input.
 *
 * Structured mode collects ticker, expiry, strike, side, direction,
 * entry price, quantity, and optional notes. Free-text mode hands the
 * raw string to the server, which routes it through `parseFreeText()`.
 *
 * Submitting calls `onCreate(body)` which the parent wires to
 * `useTrackerContracts.create`. The parent is responsible for closing
 * the modal on success.
 */

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createPortal } from 'react-dom';

import type {
  ContractCreateInput,
  ContractFreeTextInput,
  Direction,
  OptionSide,
} from './types.js';
import { getErrorMessage } from '../../utils/error.js';

type Mode = 'structured' | 'free-text';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (
    body: ContractCreateInput | ContractFreeTextInput,
  ) => Promise<void>;
}

interface StructuredFormState {
  ticker: string;
  expiry: string;
  strike: string;
  side: OptionSide;
  direction: Direction;
  entry_price: string;
  quantity: string;
  notes: string;
}

const EMPTY_STRUCTURED: StructuredFormState = {
  ticker: '',
  expiry: '',
  strike: '',
  side: 'C',
  direction: 'long',
  entry_price: '',
  quantity: '1',
  notes: '',
};

export const AddContractForm = memo(function AddContractForm({
  open,
  onClose,
  onCreate,
}: Props) {
  const [mode, setMode] = useState<Mode>('structured');
  const [structured, setStructured] =
    useState<StructuredFormState>(EMPTY_STRUCTURED);
  const [freeText, setFreeText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const errorId = useId();

  // Reset state whenever the modal is re-opened so a previous error
  // doesn't linger across opens.
  useEffect(() => {
    if (open) {
      setError(null);
      setSubmitting(false);
      setStructured(EMPTY_STRUCTURED);
      setFreeText('');
      setMode('structured');
      // Focus the first field on open for keyboard users.
      const t = setTimeout(() => firstFieldRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const handleStructuredSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setError(null);
      const ticker = structured.ticker.trim().toUpperCase();
      const strike = Number.parseFloat(structured.strike);
      const entryPrice = Number.parseFloat(structured.entry_price);
      const quantity = Number.parseInt(structured.quantity, 10);
      if (!ticker) {
        setError('Ticker is required');
        return;
      }
      if (!structured.expiry) {
        setError('Expiry is required');
        return;
      }
      if (!Number.isFinite(strike) || strike <= 0) {
        setError('Strike must be a positive number');
        return;
      }
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        setError('Entry price must be a positive number');
        return;
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setError('Quantity must be a positive integer');
        return;
      }
      const body: ContractCreateInput = {
        ticker,
        expiry: structured.expiry,
        strike,
        side: structured.side,
        direction: structured.direction,
        entry_price: entryPrice,
        quantity,
      };
      if (structured.notes.trim()) {
        body.notes = structured.notes.trim();
      }
      setSubmitting(true);
      try {
        await onCreate(body);
        onClose();
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setSubmitting(false);
      }
    },
    [structured, onCreate, onClose],
  );

  const handleFreeTextSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setError(null);
      const input = freeText.trim();
      if (!input) {
        setError('Input is required');
        return;
      }
      setSubmitting(true);
      try {
        await onCreate({ input });
        onClose();
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setSubmitting(false);
      }
    },
    [freeText, onCreate, onClose],
  );

  if (!open) return null;

  // Portal to <body> so `position: fixed` anchors to the viewport
  // rather than the SectionBox containing block — SectionBox uses
  // overflow-hidden for its collapse animation, which would otherwise
  // pin the modal inside the panel bounds (see screenshot bug 2026-05-17).
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-16"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-surface border-edge w-full max-w-md rounded-[14px] border-[1.5px] p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3
            id={titleId}
            className="text-primary font-sans text-base font-semibold"
          >
            Add Contract
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="text-tertiary hover:text-primary cursor-pointer p-1"
          >
            &#x2715;
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Input mode"
          className="border-edge mb-4 flex items-center gap-1 border-b"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'structured'}
            onClick={() => setMode('structured')}
            className={
              'cursor-pointer px-3 py-1.5 font-sans text-[13px] font-semibold ' +
              (mode === 'structured'
                ? 'text-accent border-accent -mb-px border-b-2'
                : 'text-secondary')
            }
          >
            Structured
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'free-text'}
            onClick={() => setMode('free-text')}
            className={
              'cursor-pointer px-3 py-1.5 font-sans text-[13px] font-semibold ' +
              (mode === 'free-text'
                ? 'text-accent border-accent -mb-px border-b-2'
                : 'text-secondary')
            }
          >
            Free-text
          </button>
        </div>

        {error && (
          <div
            id={errorId}
            role="alert"
            className="text-danger mb-3 font-sans text-[12px]"
          >
            {error}
          </div>
        )}

        {mode === 'structured' ? (
          <form onSubmit={handleStructuredSubmit} className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-tertiary font-sans text-[11px] font-semibold uppercase">
                  Ticker
                </span>
                <input
                  ref={firstFieldRef}
                  type="text"
                  value={structured.ticker}
                  onChange={(e) =>
                    setStructured((s) => ({
                      ...s,
                      ticker: e.target.value.toUpperCase(),
                    }))
                  }
                  maxLength={6}
                  required
                  className="border-edge bg-surface focus:border-accent rounded border px-2 py-1.5 font-mono text-[13px] outline-none"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-tertiary font-sans text-[11px] font-semibold uppercase">
                  Expiry
                </span>
                <input
                  type="date"
                  value={structured.expiry}
                  onChange={(e) =>
                    setStructured((s) => ({ ...s, expiry: e.target.value }))
                  }
                  required
                  className="border-edge bg-surface focus:border-accent rounded border px-2 py-1.5 font-mono text-[13px] outline-none"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-tertiary font-sans text-[11px] font-semibold uppercase">
                  Strike
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={structured.strike}
                  onChange={(e) =>
                    setStructured((s) => ({ ...s, strike: e.target.value }))
                  }
                  required
                  className="border-edge bg-surface focus:border-accent rounded border px-2 py-1.5 font-mono text-[13px] outline-none"
                />
              </label>
              <div className="flex flex-col gap-1">
                <span className="text-tertiary font-sans text-[11px] font-semibold uppercase">
                  Side
                </span>
                <div
                  role="radiogroup"
                  aria-label="Option side"
                  className="flex items-center gap-1"
                >
                  {(['C', 'P'] as const).map((s) => (
                    <label
                      key={s}
                      className={
                        'border-edge flex-1 cursor-pointer rounded border px-2 py-1.5 text-center font-mono text-[13px] ' +
                        (structured.side === s
                          ? 'text-accent border-accent bg-accent-bg'
                          : 'text-secondary')
                      }
                    >
                      <input
                        type="radio"
                        name="side"
                        value={s}
                        checked={structured.side === s}
                        onChange={() =>
                          setStructured((p) => ({ ...p, side: s }))
                        }
                        className="sr-only"
                      />
                      {s === 'C' ? 'Call' : 'Put'}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-tertiary font-sans text-[11px] font-semibold uppercase">
                  Direction
                </span>
                <div
                  role="radiogroup"
                  aria-label="Trade direction"
                  className="flex items-center gap-1"
                >
                  {(['long', 'short'] as const).map((d) => (
                    <label
                      key={d}
                      className={
                        'border-edge flex-1 cursor-pointer rounded border px-2 py-1.5 text-center font-mono text-[13px] capitalize ' +
                        (structured.direction === d
                          ? 'text-accent border-accent bg-accent-bg'
                          : 'text-secondary')
                      }
                    >
                      <input
                        type="radio"
                        name="direction"
                        value={d}
                        checked={structured.direction === d}
                        onChange={() =>
                          setStructured((p) => ({ ...p, direction: d }))
                        }
                        className="sr-only"
                      />
                      {d}
                    </label>
                  ))}
                </div>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-tertiary font-sans text-[11px] font-semibold uppercase">
                  Quantity
                </span>
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={structured.quantity}
                  onChange={(e) =>
                    setStructured((s) => ({ ...s, quantity: e.target.value }))
                  }
                  required
                  className="border-edge bg-surface focus:border-accent rounded border px-2 py-1.5 font-mono text-[13px] outline-none"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-tertiary font-sans text-[11px] font-semibold uppercase">
                Entry price
              </span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={structured.entry_price}
                onChange={(e) =>
                  setStructured((s) => ({ ...s, entry_price: e.target.value }))
                }
                required
                className="border-edge bg-surface focus:border-accent rounded border px-2 py-1.5 font-mono text-[13px] outline-none"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-tertiary font-sans text-[11px] font-semibold uppercase">
                Notes (optional)
              </span>
              <textarea
                value={structured.notes}
                onChange={(e) =>
                  setStructured((s) => ({ ...s, notes: e.target.value }))
                }
                rows={2}
                maxLength={2000}
                className="border-edge bg-surface focus:border-accent rounded border px-2 py-1.5 font-sans text-[13px] outline-none"
              />
            </label>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="text-secondary hover:text-primary cursor-pointer rounded px-3 py-1.5 font-sans text-[13px]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="bg-accent cursor-pointer rounded px-3 py-1.5 font-sans text-[13px] font-semibold text-white disabled:opacity-50"
              >
                {submitting ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleFreeTextSubmit} className="space-y-3">
            <label className="flex flex-col gap-1">
              <span className="text-tertiary font-sans text-[11px] font-semibold uppercase">
                Free-text input
              </span>
              <input
                ref={firstFieldRef}
                type="text"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="NVDA 225P 05/22/26 @ 4.30 x 5 long  —  or paste UW URL / OCC"
                required
                className="border-edge bg-surface focus:border-accent rounded border px-2 py-1.5 font-mono text-[13px] outline-none"
              />
              <span className="text-tertiary font-sans text-[11px]">
                Accepts: <code>TICKER STRIKE+SIDE EXPIRY</code>,{' '}
                <code>OCC symbol</code> (e.g. TSLA261016C00800000), or{' '}
                <code>UW URL</code> (e.g.
                unusualwhales.com/option-chain/TSLA261016C00800000). Append{' '}
                <code>@ PRICE x QTY long|short</code> in every case.
              </span>
            </label>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="text-secondary hover:text-primary cursor-pointer rounded px-3 py-1.5 font-sans text-[13px]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="bg-accent cursor-pointer rounded px-3 py-1.5 font-sans text-[13px] font-semibold text-white disabled:opacity-50"
              >
                {submitting ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
});
