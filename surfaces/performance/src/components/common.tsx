'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useSurfaceHost } from '@tapestrai/surface-sdk/react';

/** One attribute on one record: what a displayed value points back to. */
export interface BindTarget {
  entityId: string;
  entityName?: string;
  domainCode: string;
  code: string;
  name: string;
}

/** A value that points back to its attribute. Right-click opens its sources. */
export function Bound({ entityId, entityName, domainCode, code, name, value, children, className }: BindTarget & { value?: string; children: ReactNode; className?: string }) {
  const host = useSurfaceHost();
  const open = useCallback((event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    host.inspectAttribute({ entityId, entityName, domainCode, attributeCode: code, attributeName: name, value });
  }, [host, entityId, entityName, domainCode, code, name, value]);
  return (
    <span className={`attr-inspectable x-bound${className ? ` ${className}` : ''}`} title={`${name}: right-click for sources`} data-attr={code} onContextMenu={open}>
      {children}
    </span>
  );
}

/** A bound value when the record holds one, else a quiet dash that says nothing is recorded. */
export function BoundOr({ bind, value, shown, className }: { bind: BindTarget | null; value: unknown; shown: string; className?: string }) {
  if (!bind || value == null || value === '') return <span className={`x-nil${className ? ` ${className}` : ''}`} title="Nothing recorded">—</span>;
  return <Bound {...bind} value={shown} className={className}>{shown}</Bound>;
}

// ---------- derived figures ----------

/** How a figure with no attribute of its own is worked out, and the records behind it. */
export interface Derivation {
  title: string;
  value?: string;
  /** One or two sentences: what is pooled or divided, at which dates. */
  formula: string;
  rows?: Array<{ label: string; sub?: string; value: string; bind?: BindTarget }>;
  more?: number;
}

interface OpenDerivation { how: Derivation; x: number; y: number }
const DerivationContext = createContext<((how: Derivation, x: number, y: number) => void) | null>(null);
const POP_WIDTH = 380;

/** Holds the one "how this is worked out" panel for the surface. */
export function DerivationLayer({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<OpenDerivation | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const show = useCallback((how: Derivation, x: number, y: number) => setOpen({ how, x, y }), []);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setOpen(null); };
    const onDown = (event: globalThis.MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(null); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [open]);
  const place = useMemo(() => {
    if (!open || typeof window === 'undefined') return undefined;
    const left = Math.max(8, Math.min(open.x, window.innerWidth - POP_WIDTH - 12));
    const below = open.y < window.innerHeight * 0.55;
    return below ? { left, top: open.y + 6, maxHeight: window.innerHeight - open.y - 18 } : { left, bottom: window.innerHeight - open.y + 6, maxHeight: open.y - 18 };
  }, [open]);
  return (
    <DerivationContext.Provider value={show}>
      {children}
      {open && (
        <div className="x-pop" role="dialog" aria-label={`How ${open.how.title} is worked out`} ref={ref} style={place}>
          <div className="x-pophead">
            <div>
              <small>How this is worked out</small>
              <b>{open.how.title}{open.how.value ? <span> {open.how.value}</span> : null}</b>
            </div>
            <button className="btn btn-sm" aria-label="Close" onClick={() => setOpen(null)}>Close</button>
          </div>
          <p>{open.how.formula}</p>
          {open.how.rows && open.how.rows.length > 0 && (
            <table className="x-poprows">
              <tbody>
                {open.how.rows.map((row, i) => (
                  <tr key={`${row.label}-${i}`}>
                    <td>{row.label}{row.sub ? <small>{row.sub}</small> : null}</td>
                    <td>{row.bind ? <Bound {...row.bind} value={row.value}>{row.value}</Bound> : row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {open.how.more ? <p className="x-popmore">and {open.how.more} more</p> : null}
          {open.how.rows?.some((row) => row.bind) && <p className="x-popmore">Right-click a figure above for its sources.</p>}
        </div>
      )}
    </DerivationContext.Provider>
  );
}

/** A figure worked out from other values. Right-click shows how, and the records behind it. */
export function Derived({ name, how, children, className }: { name: string; how: () => Derivation; children: ReactNode; className?: string }) {
  const show = useContext(DerivationContext);
  return (
    <span
      className={`x-derived${className ? ` ${className}` : ''}`}
      title={`${name}: right-click to see how it is worked out`}
      data-derived={name}
      onContextMenu={(event) => {
        if (!show) return;
        event.preventDefault();
        event.stopPropagation();
        show(how(), event.clientX, event.clientY);
      }}
    >
      {children}
    </span>
  );
}

// ---------- records and states ----------

/** A record's name, linked to its golden record. */
export function RecordLink({ path, children }: { path: string; children: ReactNode }) {
  const host = useSurfaceHost();
  return <a className="x-rec" href={host.href(path)} onClick={(event) => event.stopPropagation()}>{children}</a>;
}

export function Loading({ text }: { text: string }) {
  return <div className="x-empty" role="status">{text}</div>;
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="x-error" role="alert">
      {message}
      {onRetry && <> <button className="btn btn-sm" onClick={onRetry}>Try again</button></>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="x-empty">{children}</div>;
}
