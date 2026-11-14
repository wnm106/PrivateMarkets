'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EntityHome } from '@/components/entities/EntityHome';
import { useTemporalStore } from '@/lib/store';
import { DomainKey } from '@/lib/mock-data';

export default function IssuersPage() {
  const domain: DomainKey = 'issuers';
  const [totalCount, setTotalCount] = useState(0);
  const asOfDate = useTemporalStore(state => state.asOfDate);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Issuers</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#6d28d9' }}></div>
          <div>
            <div className="page-title">Issuers</div>
            <div className="page-meta">{totalCount} records · Generic Entity Model</div>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn">Export</button>
          <button className="btn">Bulk Edit</button>
          <Link href="/issuers/new" className="btn btn-primary">+ New Record</Link>
        </div>
      </div>

      <EntityHome
        domainCode="ISSUER"
        domainKey={domain}
        asOfDate={asOfDate}
        emptyMessage="No issuers found. Add issuers via the generic entity API."
        onTotalChange={setTotalCount}
      />
    </div>
  );
}
