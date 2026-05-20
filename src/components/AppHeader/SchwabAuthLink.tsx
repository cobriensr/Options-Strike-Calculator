// ── Owner-only admin link to /api/auth/init ───────────────────────────

interface SchwabAuthLinkProps {
  ariaLabel: string;
  text: string;
  color?: string;
}

export default function SchwabAuthLink({
  ariaLabel,
  text,
  color,
}: SchwabAuthLinkProps) {
  return (
    <a
      href="/api/auth/init"
      className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base no-underline transition-all duration-200"
      style={color ? { color } : undefined}
      aria-label={ariaLabel}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="3"
          y="7"
          width="10"
          height="8"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M5.5 7V5a2.5 2.5 0 015 0v2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-[11px] font-semibold">{text}</span>
    </a>
  );
}
