/**
 * AccessKeyButton — key icon affordance in two flavors:
 *
 *   default — full-width, icon + label. Mounted in the SectionNav vertical
 *             sidebar's bottomSlot at lg+.
 *   compact — icon-only square button matching the other header chips
 *             (Sign-in, Collapse, etc.). Mounted in the App header bar at
 *             <lg so phone/tablet users have a way to authenticate too.
 *
 * Visible to everyone (owner + guest + public) — single component, single
 * modal, just two visual treatments.
 */

import { useState } from 'react';
import { useAccessSession } from '../../hooks/useAccessSession';
import AccessKeyModal from './AccessKeyModal';

interface Props {
  compact?: boolean;
}

export default function AccessKeyButton({ compact = false }: Props) {
  const { mode, refresh, logout } = useAccessSession();
  const [open, setOpen] = useState(false);

  const filled = mode === 'guest' || mode === 'owner';
  const ariaLabel =
    mode === 'guest'
      ? 'Guest mode active — open access menu'
      : mode === 'owner'
        ? 'Owner mode active — open access menu'
        : 'Enter access key';

  const buttonClass = compact
    ? `border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base transition-all duration-200 ${
        filled ? 'text-accent' : 'text-primary'
      }`
    : `hover:bg-surface-alt flex w-full items-center gap-2 rounded-md px-3 py-2 font-sans text-[12px] font-semibold transition-colors ${
        filled ? 'text-accent' : 'text-tertiary hover:text-primary'
      }`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={ariaLabel}
        title={ariaLabel}
        className={buttonClass}
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
        <span
          className={
            compact ? 'text-[11px] font-semibold' : 'text-[11px] tracking-wide'
          }
        >
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
