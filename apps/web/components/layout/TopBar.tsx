'use client';

import { useTemporalStore } from '@/lib/store';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import { AsOfDatePicker } from './AsOfDatePicker';

const CRUMB_LABELS: Record<string, string> = {
  funds: 'Funds',
  issuers: 'Issuers',
  securities: 'Securities',
  deals: 'Deals',
  investors: 'Investors',
  positions: 'Positions',
  prices: 'Prices',
  quality: 'Data Quality',
  reconcile: 'Reconcile',
  lists: 'Value Lists',
  intersections: 'Composite Entities',
  imports: 'Position File Load',
  merge: 'Entity Resolution',
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
  const { chatOpen, toggleChat, asOfDate } = useTemporalStore();
  const [live, setLive] = useState(true);

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
        <div className={`status-pill ${live ? '' : 'is-historical'}`}>
          <span className="status-dot"></span>{live ? 'Live' : 'Historical'}
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