'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { graphqlQuery, DOMAIN_TYPES_QUERY } from '@/lib/graphql';
import { EntityHome } from '@/components/entities/EntityHome';
import { useTemporalStore } from '@/lib/store';
import { domainCodeFromRoute } from '@/lib/domain-routes';

const ACCENTS: Record<string, string> = {
  PRICE: '#0a84e0',
  CASH_FLOW: '#047857',
};

export default function DomainListPage() {
  const params = useParams();
  const route = String(params.domain || '');
  const domainCode = domainCodeFromRoute(route);
  const [domainName, setDomainName] = useState(domainCode.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()));
  const [known, setKnown] = useState<boolean | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const asOfDate = useTemporalStore(state => state.asOfDate);

  useEffect(() => {
    let cancelled = false;
    graphqlQuery<{ domainTypes: Array<{ domainCode: string; domainName: string; isActive: boolean }> }, Record<string, never>>(
      DOMAIN_TYPES_QUERY,
      {},
      'network-only'
    ).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setKnown(false);
        return;
      }
      const match = (result.data?.domainTypes || []).find((domain) => domain.domainCode === domainCode && domain.isActive);
      setKnown(Boolean(match));
      if (match) setDomainName(match.domainName);
    });
    return () => { cancelled = true; };
  }, [domainCode]);

  if (known === false) {
    return (
      <div className="view-fade" style={{ padding: '48px 0', color: 'var(--ink-3)' }}>
        No entity type matches this page.
      </div>
    );
  }

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{domainName}</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: ACCENTS[domainCode] || '#00334e' }}></div>
          <div>
            <div className="page-title">{domainName}</div>
            <div className="page-meta">{totalCount} records · Generic Entity Model</div>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn">Export</button>
          <button className="btn">Bulk Edit</button>
          <Link href={`/${route}/new`} className="btn btn-primary">+ New Record</Link>
        </div>
      </div>

      <EntityHome
        domainCode={domainCode}
        domainKey={route}
        asOfDate={asOfDate}
        emptyMessage={`No ${domainName.toLowerCase()} records yet.`}
        onTotalChange={setTotalCount}
      />
    </div>
  );
}
