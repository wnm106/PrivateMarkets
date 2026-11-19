'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * A button for something that should not happen on one stray click. The first
 * press changes it to its confirming label; a second press within a few
 * seconds acts. Left alone, it goes back.
 */
export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  className = 'btn',
  disabled = false,
  title,
}: {
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      title={title}
      style={armed ? { outline: '2px solid #b42318', outlineOffset: 1 } : undefined}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
