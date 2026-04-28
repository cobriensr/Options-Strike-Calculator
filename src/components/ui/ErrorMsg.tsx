import { memo, type ReactNode } from 'react';

/** Error message display */
export const ErrorMsg = memo(function ErrorMsg({
  children,
  id,
}: {
  children: ReactNode;
  id?: string;
}) {
  return (
    <div
      id={id}
      role="alert"
      className="text-danger mt-1.5 font-mono text-[13px] font-medium"
    >
      {children}
    </div>
  );
});
