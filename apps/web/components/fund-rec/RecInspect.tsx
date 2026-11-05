'use client';

import { createContext, useCallback, useContext, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { useAttributeInspect } from '@/components/detail/AttributeInspect';
import type { RecBind } from '@/lib/fund-rec';

interface MenuState {
  x: number;
  y: number;
  sources: RecBind[];
  display: string;
}

interface RecInspectApi {
  open: (event: MouseEvent, sources: RecBind[] | undefined, display: string) => void;
}

const RecInspectContext = createContext<RecInspectApi>({ open: () => undefined });

export function joinSources(...groups: Array<RecBind[] | undefined>): RecBind[] {
  const seen = new Set<string>();
  const out: RecBind[] = [];
  for (const group of groups) {
    for (const source of group || []) {
      if (!source.entityId) continue;
      const key = `${source.entityId}:${source.code}:${source.sourceCode || ''}:${source.asOfDate || ''}:${source.knowledgeDate || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(source);
    }
  }
  return out;
}

function sourceDay(iso: string): string {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return iso;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function sourceCaption(source: RecBind): string {
  const who = source.sourceCode === 'FUND_ADMIN' ? 'Fund administrator' : source.sourceCode === 'INTERNAL' ? 'Internal' : source.sourceCode || '';
  const when = source.asOfDate ? sourceDay(source.asOfDate) : '';
  return [source.entityName, who, when].filter(Boolean).join(' · ');
}

function classNames(...parts: Array<string | undefined | false>): string | undefined {
  const text = parts.filter(Boolean).join(' ');
  return text || undefined;
}

export function RecInspectProvider({ children, onChanged }: { children: ReactNode; onChanged: () => void }) {
  const inspect = useAttributeInspect();
  const [menu, setMenu] = useState<MenuState | null>(null);

  const show = useCallback((source: RecBind, display: string) => {
    inspect.open({
      entityId: source.entityId,
      entityName: source.entityName,
      attributeCode: source.code,
      attributeName: source.name,
      dataType: source.dataType,
      domainCode: source.domainCode,
      asOfDate: source.asOfDate,
      knowledgeDate: source.knowledgeDate,
      value: display,
      onChanged,
    });
  }, [inspect, onChanged]);

  const open = useCallback((event: MouseEvent, sources: RecBind[] | undefined, display: string) => {
    const list = joinSources(sources);
    if (!list.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (list.length === 1) {
      setMenu(null);
      show(list[0], display);
      return;
    }
    const width = 280;
    const height = Math.min(320, 28 + list.length * 46);
    setMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
      sources: list,
      display,
    });
  }, [show]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  return (
    <RecInspectContext.Provider value={{ open }}>
      {children}
      {menu && (
        <>
          <button type="button" className="da-sourceback" aria-label="Close sources" onClick={() => setMenu(null)} />
          <div className="da-sourcemenu" role="menu" style={{ top: menu.y, left: menu.x }}>
            {menu.sources.map((source) => (
              <button
                key={`${source.entityId}:${source.code}:${source.sourceCode || ''}:${source.asOfDate || ''}`}
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  show(source, menu.display);
                }}
              >
                <b>{source.name}</b>
                <small>{sourceCaption(source)}</small>
              </button>
            ))}
          </div>
        </>
      )}
    </RecInspectContext.Provider>
  );
}

function useOpen() {
  return useContext(RecInspectContext).open;
}

export function RecFact({
  sources, display, className, children,
}: {
  sources?: RecBind[];
  display: string;
  className?: string;
  children: ReactNode;
}) {
  const open = useOpen();
  const bound = joinSources(sources);
  return (
    <div
      className={classNames(className, bound.length ? 'attr-inspectable' : undefined)}
      title={bound.length ? 'Right-click to view sources' : undefined}
      onContextMenu={bound.length ? (event) => open(event, bound, display) : undefined}
    >
      {children}
    </div>
  );
}

export function RecCell({
  sources, display, className, children, colSpan,
}: {
  sources?: RecBind[];
  display: string;
  className?: string;
  children: ReactNode;
  colSpan?: number;
}) {
  const open = useOpen();
  const bound = joinSources(sources);
  return (
    <td
      colSpan={colSpan}
      className={classNames(className, bound.length ? 'attr-inspectable' : undefined)}
      title={bound.length ? 'Right-click to view sources' : undefined}
      onContextMenu={bound.length ? (event) => open(event, bound, display) : undefined}
    >
      {children}
    </td>
  );
}

export function RecBit({
  sources, display, className, children,
}: {
  sources?: RecBind[];
  display: string;
  className?: string;
  children: ReactNode;
}) {
  const open = useOpen();
  const bound = joinSources(sources);
  return (
    <span
      className={classNames(className, bound.length ? 'attr-inspectable' : undefined)}
      title={bound.length ? 'Right-click to view sources' : undefined}
      onContextMenu={bound.length ? (event) => open(event, bound, display) : undefined}
    >
      {children}
    </span>
  );
}

export function RecLabel({
  sources, display, className, children,
}: {
  sources?: RecBind[];
  display: string;
  className?: string;
  children: ReactNode;
}) {
  const open = useOpen();
  const bound = joinSources(sources);
  return (
    <label
      className={classNames(className, bound.length ? 'attr-inspectable' : undefined)}
      title={bound.length ? 'Right-click to view sources' : undefined}
      onContextMenu={bound.length ? (event) => open(event, bound, display) : undefined}
    >
      {children}
    </label>
  );
}

export function RecPress({
  sources, display, className, disabled, onClick, children,
}: {
  sources?: RecBind[];
  display: string;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const open = useOpen();
  const bound = joinSources(sources);
  return (
    <button
      type="button"
      className={classNames(className, bound.length ? 'attr-inspectable' : undefined)}
      disabled={disabled}
      title={bound.length ? 'Right-click to view sources' : undefined}
      onClick={onClick}
      onContextMenu={bound.length ? (event) => open(event, bound, display) : undefined}
    >
      {children}
    </button>
  );
}
