'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EntityHome } from '@/components/entities/EntityHome';
import { useTemporalStore } from '@/lib/store';
import { DomainKey } from '@/lib/mock-data';

export default function SecuritiesPage() {
  const domain: DomainKey = 'securities';
  const [totalCount, setTotalCount] = useState(0);
  const asOfDate = useTemporalStore(state => state.asOfDate);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Securities</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#c2410c' }}></div>
          <div>
            <div className="page-title">Securities</div>
            <div className="page-meta">{totalCount} records · Generic Entity Model</div>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn">Export</button>
          <button className="btn">Bulk Edit</button>
          <Link href="/securities/new" className="btn btn-primary">+ New Record</Link>
        </div>
      </div>

      <EntityHome
        domainCode="SECURITY"
        domainKey={domain}
        asOfDate={asOfDate}
        emptyMessage="No securities found. Add securities via the generic entity API."
        onTotalChange={setTotalCount}
        related={[{
          alias: 'issuer',
          label: 'Issuer',
          direction: 'UP',
          relationshipCode: 'SECURITY_ISSUER',
          domainCode: 'ISSUER',
          field: 'entity_name',
          header: 'Issuer',
        }]}
      />
    </div>
  );
}
