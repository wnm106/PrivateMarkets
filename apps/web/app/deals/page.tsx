'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EntityHome } from '@/components/entities/EntityHome';
import { useTemporalStore } from '@/lib/store';
import { DomainKey } from '@/lib/mock-data';

export default function DealsPage() {
  const domain: DomainKey = 'deals';
  const [totalCount, setTotalCount] = useState(0);
  const asOfDate = useTemporalStore(state => state.asOfDate);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Deals</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#047857' }}></div>
          <div>
            <div className="page-title">Deals</div>
            <div className="page-meta">{totalCount} records · Generic Entity Model</div>
          </div>
        </div>
        <div className="page-actions">
          <Link href="/pipeline" className="btn btn-primary">Pipeline</Link>
          <button className="btn">Export</button>
          <button className="btn">Bulk Edit</button>
          <Link href="/deals/new" className="btn">+ New Record</Link>
        </div>
      </div>

      <EntityHome
        domainCode="DEAL"
        domainKey={domain}
        asOfDate={asOfDate}
        emptyMessage="No deals found. Add deals via the generic entity API."
        onTotalChange={setTotalCount}
      />
    </div>
  );
}
