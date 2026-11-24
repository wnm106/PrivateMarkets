'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useSurfaceHost } from '@tapestrai/surface-sdk/react';
import { fmtMeasure, type Measure } from '../lib/format';
import type { BandCell, BandState } from '../lib/tree';

/** One attribute on one record: what a displayed value points back to. */
export interface BindTarget {
  entityId: string;
  entityName?: string;
  domainCode: string;
  code: string;
  name: string;
}

/** Open the platform's source panel for a bound value. Returns the handler for onContextMenu. */
export function useInspect() {
  const host = useSurfaceHost();
  return useCallback((target: BindTarget, value?: string) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    host.inspectAttribute({ entityId: target.entityId, entityName: target.entityName, domainCode: target.domainCode, attributeCode: target.code, attributeName: target.name, value });
  }, [host]);
}

/** A value that points back to its attribute. Right-click opens its sources. */
export function Bound({ entityId, entityName, domainCode, code, name, value, children, className }: BindTarget & {
  value?: string;
  children: ReactNode;
  className?: string;
}) {
  const inspect = useInspect();
  return (
    <span
      className={`attr-inspectable x-bound${className ? ` ${className}` : ''}`}
      title={`${name}: right-click for sources`}
      data-attr={code}
      onContextMenu={inspect({ entityId, entityName, domainCode, code, name }, value)}
    >
      {children}
    </span>
  );
}

/**
 * Right-click on an editable box. It opens the value's sources, unless the box already had
 * the cursor in it, when the browser's own copy and paste menu is the useful one. (A right
 * click focuses the box before the menu event, so focus is read on the way down.)
 */
export function useInputInspect(bind: BindTarget | null, value?: string, implied?: () => Derivation) {
  const inspect = useInspect();
  const show = useContext(DerivationContext);
  const typing = useRef(false);
  return {
    onMouseDown: (event: MouseEvent<HTMLInputElement>) => { if (event.button === 2) typing.current = document.activeElement === event.currentTarget; },
    onContextMenu: (event: MouseEvent<HTMLInputElement>) => {
      if (typing.current) { typing.current = false; return; }
      // A box showing an implied figure (≈) holds no value of its own: say how it is implied.
      if (implied && show && (!value || !bind)) {
        event.preventDefault();
        event.stopPropagation();
        show(implied(), event.clientX, event.clientY);
      } else if (bind) inspect(bind, value)(event);
      else return;
      event.currentTarget.blur();
    },
  };
}

/** A value that is bound when a record holds it, and plain text when nothing has been entered. */
export function BoundIf({ bind, value, children, className }: { bind: BindTarget | null | undefined; value?: string; children: ReactNode; className?: string }) {
  return bind ? <Bound {...bind} value={value} className={className}>{children}</Bound> : <span className={className}>{children}</span>;
}

// ---------- derived figures ----------

/** How a figure with no attribute of its own is worked out, and the records behind it. */
export interface Derivation {
  title: string;
  /** The figure as shown. */
  value?: string;
  /** One or two sentences: what is added up or divided, at which dates. */
  formula: string;
  rows?: Array<{ label: string; sub?: string; value: string; bind?: BindTarget }>;
  /** How many more records count beyond the rows listed. */
  more?: number;
}

interface OpenDerivation { how: Derivation; x: number; y: number }
const DerivationContext = createContext<((how: Derivation, x: number, y: number) => void) | null>(null);

const POP_WIDTH = 360;

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
    return below
      ? { left, top: open.y + 6, maxHeight: window.innerHeight - open.y - 18 }
      : { left, bottom: window.innerHeight - open.y + 6, maxHeight: open.y - 18 };
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
export function Derived({ name, how, children, className }: {
  /** What the figure is, for the tooltip and the page's own checks. */
  name: string;
  /** Built when asked for, so a grid does not work out every cell's records up front. */
  how: () => Derivation;
  children: ReactNode;
  className?: string;
}) {
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

// ---------- editing ----------

/** A bound value a person can change where it stands: click to edit, Enter or leaving saves, Escape cancels. */
export function InlineEdit({ bind, shown, editable, parse, onCommit, placeholder }: {
  bind: BindTarget;
  /** The value as displayed; empty when none is recorded. */
  shown: string;
  editable: boolean;
  /** The typed text as a value, or null when it cannot be read. */
  parse: (text: string) => number | null;
  onCommit: (value: number) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const inspect = useInspect();
  const commit = () => {
    if (draft == null) return;
    if (draft.trim() === '' || draft === shown) { setDraft(null); setBad(false); return; }
    const value = parse(draft);
    if (value == null) { setBad(true); return; }
    setBad(false);
    setDraft(null);
    onCommit(value);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Escape') { setDraft(null); setBad(false); }
  };
  if (draft != null) {
    return (
      <input
        className="x-inedit"
        autoFocus
        value={draft}
        aria-label={bind.name}
        aria-invalid={bad || undefined}
        data-attr={bind.code}
        data-editable="true"
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={commit}
        onKeyDown={onKey}
      />
    );
  }
  if (!editable) return <Bound {...bind} value={shown}>{shown || '—'}</Bound>;
  return (
    <button
      type="button"
      className="attr-inspectable x-bound x-editable"
      title={`${bind.name}: click to change, right-click for sources`}
      data-attr={bind.code}
      data-editable="true"
      onClick={(event) => { event.stopPropagation(); setDraft(shown); }}
      onContextMenu={inspect(bind, shown)}
    >
      {shown || '—'}
    </button>
  );
}

// ---------- band bar ----------

/** The min-max band, target tick and committed fill under a measure. The figure beside it is the actual. */
export function BandBar({ k, a, b, st, actual }: { k: Measure; a: number | null; b: BandCell[]; st: BandState; actual?: ReactNode }) {
  const [lo, tg, hi] = b.map((x) => x.v);
  if (a == null && st.cls === 'none') return <div className="x-band"><span className="x-trk" /><span className="x-av x-nil">·</span></div>;
  const scale = Math.max(a || 0, hi || 0, tg || 0, lo || 0) * 1.12 || 1;
  const p = (v: number) => Math.max(0, Math.min(100, (v / scale) * 100));
  const range = lo != null || hi != null ? `range ${lo != null ? fmtMeasure(k, lo) : '…'} to ${hi != null ? fmtMeasure(k, hi) : '…'}` : '';
  const title = [`Actual ${a != null ? fmtMeasure(k, a) : 'none'}${k === 'pct' ? ' of committed' : ''}`, tg != null ? `target ${fmtMeasure(k, tg)}` : '', range, st.text].filter(Boolean).join(' · ');
  return (
    <div className={`x-band ${st.cls === 'none' ? '' : st.cls}`}>
      <span className="x-trk" title={title}>
        {(lo != null || hi != null) && <i className="r" style={{ left: `${p(lo ?? 0).toFixed(1)}%`, width: `${(p(hi ?? scale) - p(lo ?? 0)).toFixed(1)}%` }} />}
        <i className="f" style={{ width: `${p(a || 0).toFixed(1)}%` }} />
        {tg != null && <i className="t" style={{ left: `${p(tg).toFixed(1)}%` }} />}
      </span>
      <span className="x-av">{actual ?? (a != null ? fmtMeasure(k, a) : '—')}</span>
    </div>
  );
}

export function Dot({ cls, title }: { cls: string; title?: string }) {
  return <i className={`x-dot ${cls}`} title={title} />;
}

export function Loading({ text }: { text: string }) {
  return <div className="xp-empty">{text}</div>;
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="xp-error" role="alert">
      {message}
      {onRetry && <> <button className="btn btn-sm" onClick={onRetry}>Try again</button></>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="xp-empty">{children}</div>;
}
