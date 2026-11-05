'use client';

import { domainHref } from '@/lib/domain-routes';
import { graphqlQuery } from '@/lib/graphql';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

interface SearchHit {
  id: string;
  entityName: string;
  domainCode: string;
  domainName: string;
  depth: number;
  match: 'NAME' | 'PARENT' | 'RELATED';
  matchedName: string | null;
  matchedDomainName: string | null;
}

const SEARCH_ENTITIES = `
  query SearchEntities($query: String!, $limit: Int) {
    searchEntities(query: $query, limit: $limit) {
      id
      entityName
      domainCode
      domainName
      depth
      match
      matchedName
      matchedDomainName
    }
  }
`;

const MIN_QUERY = 2;

export function GlobalSearch() {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [shortcut, setShortcut] = useState('Ctrl K');

  const trimmed = query.trim();
  const showPanel = open && trimmed.length >= MIN_QUERY;

  useEffect(() => {
    const platform = navigator.platform || '';
    if (/Mac|iPhone|iPad/.test(platform)) setShortcut('⌘K');
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const requestId = ++requestRef.current;
    if (trimmed.length < MIN_QUERY) {
      setHits([]);
      setStatus('idle');
      setErrorMessage('');
      return;
    }
    setHits([]);
    setStatus('loading');
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const result = await graphqlQuery<{ searchEntities: SearchHit[] }, { query: string; limit: number }>(
        SEARCH_ENTITIES,
        { query: trimmed, limit: 20 },
        'network-only',
        controller.signal,
      );
      if (controller.signal.aborted || requestId !== requestRef.current) return;
      if (result.error || !result.data) {
        setHits([]);
        setStatus('error');
        setErrorMessage(result.error?.message || 'Search failed');
        return;
      }
      setHits(result.data.searchEntities || []);
      setActive(0);
      setStatus('ready');
      setErrorMessage('');
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  const rows = useMemo(() => groupHits(hits), [hits]);

  function move(delta: number) {
    if (!hits.length) return;
    setActive((current) => (current + delta + hits.length) % hits.length);
    setOpen(true);
  }

  function closeSearch() {
    setOpen(false);
    setQuery('');
  }

  return (
    <div className="topbar-search">
      <label className="topbar-search-field">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={inputRef}
          role="combobox"
          type="search"
          value={query}
          placeholder="Search entities"
          aria-label="Search entities"
          aria-autocomplete="list"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-activedescendant={showPanel && hits[active] ? optionId(hits[active].id) : undefined}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              move(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              move(-1);
            } else if (event.key === 'Enter' && showPanel && hits[active]) {
              event.preventDefault();
              const hit = hits[active];
              router.push(`${domainHref(hit.domainCode)}/${hit.id}`);
              closeSearch();
            } else if (event.key === 'Escape') {
              setOpen(false);
              setQuery('');
              inputRef.current?.blur();
            }
          }}
        />
        {!query && <span className="topbar-search-kbd">{shortcut}</span>}
      </label>
      {showPanel && (
        <div className="topbar-search-panel" id={listId} role="listbox" aria-label="Entity results">
          {status === 'loading' && hits.length === 0 && <div className="topbar-search-note">Searching…</div>}
          {status === 'error' && <div className="topbar-search-note is-error">{errorMessage}</div>}
          {status === 'ready' && hits.length === 0 && <div className="topbar-search-note">No entities match.</div>}
          {rows.map((row) => {
            if (row.kind === 'label') {
              return (
                <div key={row.label} className="topbar-search-group" role="presentation">{row.label}</div>
              );
            }
            const captionText = matchCaption(row.hit);
            const href = `${domainHref(row.hit.domainCode)}/${row.hit.id}`;
            return (
              <Link
                key={row.hit.id}
                id={optionId(row.hit.id)}
                role="option"
                aria-selected={row.index === active}
                href={href}
                className={`topbar-search-hit ${row.index === active ? 'is-active' : ''}`}
                onMouseEnter={() => setActive(row.index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.preventDefault();
                  router.push(href);
                  closeSearch();
                }}
              >
                <span className="topbar-search-copy">
                  <span className="topbar-search-name">{highlight(row.hit.entityName, trimmed)}</span>
                  {captionText && <span className="topbar-search-meta">{captionText}</span>}
                </span>
                <span className="topbar-search-domain">{row.hit.domainName}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

type SearchRow =
  | { kind: 'label'; label: string }
  | { kind: 'hit'; hit: SearchHit; index: number };

function groupHits(hits: SearchHit[]): SearchRow[] {
  const rows: SearchRow[] = [];
  let last = '';
  hits.forEach((hit, index) => {
    const label = hit.depth === 0 ? 'Parent entities' : 'Child entities';
    if (label !== last) {
      rows.push({ kind: 'label', label });
      last = label;
    }
    rows.push({ kind: 'hit', hit, index });
  });
  return rows;
}

function matchCaption(hit: SearchHit) {
  if (!hit.matchedName || hit.match === 'NAME') return null;
  if (hit.match === 'PARENT') return `Parent ${hit.matchedName}`;
  const kind = hit.matchedDomainName ? hit.matchedDomainName.toLowerCase() : 'record';
  return `Related ${kind} ${hit.matchedName}`;
}

function highlight(name: string, query: string) {
  const index = name.toLowerCase().indexOf(query.toLowerCase());
  if (!query || index < 0) return name;
  return (
    <>
      {name.slice(0, index)}
      <mark>{name.slice(index, index + query.length)}</mark>
      {name.slice(index + query.length)}
    </>
  );
}

function optionId(id: string) {
  return `global-search-${id}`;
}
