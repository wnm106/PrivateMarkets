'use client';

import Link from 'next/link';
import { useState } from 'react';
import { type RelatedAttributeColumn } from '@/components/entities/EntityAttributeTable';
import { EntityHome } from '@/components/entities/EntityHome';
import { useTemporalStore } from '@/lib/store';

const RELATED: RelatedAttributeColumn[] = [
  {
    alias: 'fund',
    label: 'Fund',
    direction: 'UP',
    relationshipCode: 'POSITION_FUND',
    domainCode: 'FUND',
    field: 'entity_name',
    header: 'Fund',
  },
  {
    alias: 'security',
    label: 'Security',
    direction: 'UP',
    relationshipCode: 'POSITION_SECURITY',
    domainCode: 'SECURITY',
    field: 'entity_name',
    header: 'Security',
  },
];

export default function PositionsPage() {
  const [totalCount, setTotalCount] = useState(0);
  const asOfDate = useTemporalStore(state => state.asOfDate);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Positions</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#0369a1' }}></div>
          <div>
            <div className="page-title">Positions</div>
            <div className="page-meta">{totalCount.toLocaleString()} records · Linked to fund and security</div>
          </div>
        </div>
        <div className="page-actions">
          <Link href="/imports" className="btn">Load position file</Link>
          <Link href="/load" className="btn">Any file</Link>
          <Link href="/positions/new" className="btn btn-primary">+ New Record</Link>
        </div>
      </div>

      <EntityHome
        domainCode="POSITION"
        domainKey="positions"
        asOfDate={asOfDate}
        emptyMessage="No positions yet. Load a position file to create issuers, funds, securities, and positions."
        related={RELATED}
        onTotalChange={setTotalCount}
      />
    </div>
  );
}
