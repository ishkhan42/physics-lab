import { useEffect, useRef, type ReactNode } from 'react';

// A details-based menu that closes on outside click or Escape.
export default function Popover({ label, icon, text, className = '', children }: {
  label: string;
  icon: ReactNode;
  text?: string;
  className?: string;
  children: ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent | KeyboardEvent) => {
      const details = detailsRef.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        details.open = false;
        details.querySelector('summary')?.focus();
      } else if (event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close, true);
    };
  }, []);
  return (
    <details className={`popover ${className}`} ref={detailsRef}>
      <summary className={text ? 'toolbar-button' : 'toolbar-button toolbar-button--icon'} aria-label={text ? undefined : label} title={label}>
        {icon}{text ? <span>{text}</span> : null}
      </summary>
      <div className="popover__panel" role="group" aria-label={label}>{children}</div>
    </details>
  );
}
