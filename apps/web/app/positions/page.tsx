'use client';

import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';
import { graphqlQuery, POSITIONS_QUERY } from '@/lib/graphql';
import { useTemporalStore } from '@/lib/store';

interface RelatedChild {
  childEntityCode: string;
  childEntityName: string;
  childDomainCode: string;
  relationshipType: string;
}

interface RelatedParent {
  parentEntityCode: string;
  parentEntityName: string;
  parentDomainCode: string;
  relationshipType: string;
}

interface PositionNode {
  id: string;
  entityCode: string;
  entityName: string;
  attributes: Record<string, { value?: string } | string>;
  childRelationships: RelatedChild[];
  parentRelationships: RelatedParent[];
}

function relatedName(position: PositionNode, domainCode: string) {
  const child = position.childRelationships?.find((rel) => rel.childDomainCode === domainCode);
  if (child) return child.childEntityName;
  const parent = position.parentRelationships?.find((rel) => rel.parentDomainCode === domainCode);
  return parent?.parentEntityName || '—';
}

function attributeText(attributes: PositionNode['attributes'], code: string) {
  const value = attributes?.[code];
  if (value && typeof value === 'object' && 'value' in value) return value.value ?? '';
  return value == null ? '' : String(value);
}

export default function PositionsPage() {
  const [positions, setPositions] = useState<PositionNode[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const asOfDate = useTemporalStore(state => state.asOfDate);

  const fetchPositions = useCallback(async () => {
    setLoading(true);
    const { data } = await graphqlQuery<{ positions: { edges: { node: PositionNode }[]; totalCount: number } }, any>(
      POSITIONS_QUERY,
      { pagination: { first: 100 }, asOfDate }
    );
    if (data?.positions) {
      setPositions(data.positions.edges.map(edge => edge.node));
      setTotalCount(data.positions.totalCount);
    }
    setLoading(false);
  }, [asOfDate]);

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

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
            <div className="page-meta">{totalCount} records · Linked to fund and security</div>
          </div>
        </div>
        <div className="page-actions">
          <Link href="/imports" className="btn btn-primary">Load position file</Link>
          <Link href="/load" className="btn">Any file</Link>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-label">As of</div>
        <div className="filter-pill">{asOfDate}</div>
        <div className="filter-count">
          Showing <strong>{positions.length}</strong> of {totalCount}
        </div>
      </div>

      <div className="data-table">
        <div className="tbl-head" style={{ gridTemplateColumns: '120px 1fr 1.2fr 1.2fr 140px' }}>
          <div>Code</div>
          <div>Type</div>
          <div>Fund</div>
          <div>Security</div>
          <div>Market value</div>
        </div>
        {loading ? (
          <div className="tbl-row" style={{ gridTemplateColumns: '1fr' }}><div>Loading...</div></div>
        ) : positions.length === 0 ? (
          <div className="tbl-row" style={{ gridTemplateColumns: '1fr' }}>
            <div>No positions yet. Load a position file to create issuers, funds, securities, and positions.</div>
          </div>
        ) : (
          positions.map((position) => {
            return (
              <Link key={position.id} href={`/positions/${position.id}`}>
                <div className="tbl-row" style={{ cursor: 'pointer', gridTemplateColumns: '120px 1fr 1.2fr 1.2fr 140px' }}>
                  <div className="row-id">{position.entityCode}</div>
                  <div>{attributeText(position.attributes, 'POSITION_TYPE') || '—'}</div>
                  <div>{relatedName(position, 'FUND')}</div>
                  <div>{relatedName(position, 'SECURITY')}</div>
                  <div>{attributeText(position.attributes, 'TOTAL_FAIR_MARKET_VALUE_AMOUNT') || '—'}</div>
                </div>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
