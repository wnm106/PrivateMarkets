'use client';

import { useTemporalStore, type Persona } from '@/lib/store';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useRef, useEffect, useCallback } from 'react';
import { AsOfDatePicker } from './AsOfDatePicker';

const PERSONAS: { id: Persona; label: string }[] = [
  { id: 'steward', label: 'Data Steward' },
  { id: 'ops', label: 'Operations Analyst' },
  { id: 'governance', label: 'Governance Lead' },
];

const CRUMB_LABELS: Record<string, string> = {
  funds: 'Funds',
  issuers: 'Issuers',
  securities: 'Securities',
  deals: 'Deals',
  investors: 'Investors',
  positions: 'Positions',
  prices: 'Prices',
  precedence: 'Precedence Rules',
  quality: 'Data Quality',
  reconcile: 'Reconcile',
  lists: 'Value Lists',
  intersections: 'Composite Entities',
  imports: 'Position File Load',
  profile: 'Profile',
  resolve: 'Resolve',
  admin: 'Admin',
  entities: 'Entity Management',
  sources: 'Data Sources',
  attributes: 'Attributes',
  'expression-functions': 'Expression Functions',
  templates: 'Templates',
  layouts: 'Display Layouts',
  'dq-rules': 'DQ Rules',
  compliance: 'Compliance',
  dashboards: 'Dashboards',
  narratives: 'Narratives',
  tenancy: 'Clients, Users & Roles',
  new: 'New',
  edit: 'Edit',
};

function crumbLabel(segment: string) {
  if (CRUMB_LABELS[segment]) return CRUMB_LABELS[segment];
  if (segment.length > 18) return 'Record';
  return segment
    .split('-')
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

export function TopBar() {
  const pathname = usePathname() || '/';
  const { persona, setPersona, chatOpen, toggleChat, asOfDate } = useTemporalStore();
  const [showAdminMenu, setShowAdminMenu] = useState(false);
  const [showPersonaMenu, setShowPersonaMenu] = useState(false);
  const [live, setLive] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);
  const personaRef = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((event: MouseEvent) => {
    const target = event.target as Node;
    if (menuRef.current && !menuRef.current.contains(target)) setShowAdminMenu(false);
    if (personaRef.current && !personaRef.current.contains(target)) setShowPersonaMenu(false);
  }, []);

  useEffect(() => {
    if (showAdminMenu || showPersonaMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showAdminMenu, showPersonaMenu, handleClickOutside]);

  useEffect(() => {
    setLive(asOfDate === new Date().toISOString().split('T')[0]);
  }, [asOfDate]);

  const crumbs = pathname === '/'
    ? [{ href: '/', label: 'Master Data' }, { href: '/', label: 'Overview' }]
    : [
        { href: '/', label: 'Master Data' },
        ...pathname.split('/').filter(Boolean).reduce<Array<{ href: string; label: string }>>((items, segment) => {
          const prev = items.length ? items[items.length - 1].href : '';
          items.push({ href: `${prev}/${segment}`, label: crumbLabel(segment) });
          return items;
        }, []),
      ];

  const personaLabel = PERSONAS.find((item) => item.id === persona)?.label || 'Operations Analyst';

  return (
    <div className="topbar">
      <nav className="topbar-crumbs" aria-label="Breadcrumb">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <span key={`${crumb.href}-${crumb.label}`} className="topbar-crumb">
              {index > 0 && <span className="topbar-crumb-sep">/</span>}
              {last ? (
                <span className="topbar-crumb-current">{crumb.label}</span>
              ) : (
                <Link href={crumb.href}>{crumb.label}</Link>
              )}
            </span>
          );
        })}
      </nav>
      <div className="topbar-right">
        <AsOfDatePicker />
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            className="admin-menu-btn"
            onClick={() => setShowAdminMenu(!showAdminMenu)}
            style={{
              padding: '8px 16px',
              background: 'var(--brand-gradient)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: '500',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            Admin
            <span style={{ fontSize: '10px' }}>▼</span>
          </button>
          {showAdminMenu && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: '8px',
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                borderRadius: '10px',
                boxShadow: '0 12px 32px rgba(10, 22, 40, 0.14)',
                minWidth: '200px',
                zIndex: 1000,
                overflow: 'hidden'
              }}
            >
                <Link href="/admin/entities" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Entity Management
                  </div>
                </Link>
                <Link href="/admin/sources" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Data Sources
                  </div>
                </Link>
                <Link href="/admin/attributes" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Attributes
                  </div>
                </Link>
                <Link href="/admin/templates/studio" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Statement Studio
                  </div>
                </Link>
                <Link href="/admin/expression-functions" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Expression functions
                  </div>
                </Link>
                <Link href="/admin/templates" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Templates
                  </div>
                </Link>
                <Link href="/admin/layouts" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Display layouts
                  </div>
                </Link>
                <Link href="/admin/dq-rules" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    DQ Rules
                  </div>
                </Link>
                <Link href="/admin/compliance" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Compliance Rules
                  </div>
                </Link>
                <Link href="/admin/dashboards" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Dashboards
                  </div>
                </Link>
                <Link href="/admin/narratives" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Narratives
                  </div>
                </Link>
                <Link href="/admin/tenancy" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Clients, Users &amp; Roles
                  </div>
                </Link>
              </div>
          )}
        </div>
        <div className={`status-pill ${live ? '' : 'is-historical'}`}>
          <span className="status-dot"></span>{live ? 'Live' : 'Historical'}
        </div>
        <div ref={personaRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className="persona-btn"
            onClick={() => setShowPersonaMenu(!showPersonaMenu)}
            aria-haspopup="menu"
            aria-expanded={showPersonaMenu}
          >
            {personaLabel}
            <span aria-hidden>▾</span>
          </button>
          {showPersonaMenu && (
            <div className="persona-menu" role="menu">
              {PERSONAS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={persona === item.id}
                  className={persona === item.id ? 'active' : ''}
                  onClick={() => {
                    setPersona(item.id);
                    setShowPersonaMenu(false);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          className={`chat-launcher ${chatOpen ? 'active' : ''}`}
          onClick={toggleChat}
          aria-label={chatOpen ? 'Close assistant' : 'Open assistant'}
          aria-expanded={chatOpen}
          title={chatOpen ? 'Close assistant' : 'Open assistant'}
        >
          <Image
            className="chat-launcher-avatar"
            src="/tapestraichat-icon.png"
            alt=""
            width={26}
            height={26}
            unoptimized
          />
          <span className="chat-launcher-label">Chat</span>
        </button>
      </div>
    </div>
  );
}