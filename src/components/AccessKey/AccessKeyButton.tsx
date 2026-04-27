/**
 * AccessKeyButton — small key icon mounted in the sidebar bottom slot.
 *
 * Always visible (per scoping decision) so the owner sees the same chrome
 * a guest sees. The button is just a one-symbol affordance; clicking it
 * opens AccessKeyModal which renders the right state for the current mode.
 */

import { useState } from 'react';
import { useAccessSession } from '../../hooks/useAccessSession';
import AccessKeyModal from './AccessKeyModal';

export default function AccessKeyButton() {
  const { mode, refresh, logout } = useAccessSession();
  const [open, setOpen] = useState(false);

  const filled = mode === 'guest' || mode === 'owner';
  const ariaLabel =
    mode === 'guest'
      ? 'Guest mode active — open access menu'
      : mode === 'owner'
        ? 'Owner mode active — open access menu'
        : 'Enter access key';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={ariaLabel}
        title={ariaLabel}
        className={`hover:bg-surface-alt flex w-full items-center gap-2 rounded-md px-3 py-2 font-sans text-[12px] font-semibold transition-colors ${
          filled ? 'text-accent' : 'text-tertiary hover:text-primary'
        }`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle
            cx="6"
            cy="10"
            r="2.5"
            fill={filled ? 'currentColor' : 'none'}
          />
          <path d="M8 9.5l6-6" strokeLinecap="round" />
          <path d="M11 6.5l1.5 1.5" strokeLinecap="round" />
          <path d="M13 4.5l1.5 1.5" strokeLinecap="round" />
        </svg>
        <span className="text-[11px] tracking-wide">
          {mode === 'guest' ? 'Guest' : mode === 'owner' ? 'Owner' : 'Access'}
        </span>
      </button>
      {open && (
        <AccessKeyModal
          mode={mode}
          onClose={() => setOpen(false)}
          onLoginSuccess={() => {
            refresh();
            setOpen(false);
          }}
          onLogout={logout}
        />
      )}
    </>
  );
}
