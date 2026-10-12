'use client';

import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';
import { graphqlQuery, graphqlMutation, toRelationshipInputs } from '@/lib/graphql';
import { IntersectionForm } from '@/components/forms/IntersectionForm';
import { useTemporalStore } from '@/lib/store';

interface IntersectionMember {
  memberRole: string;
  entityId: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
}

interface PositionNode {
  id: string;
  intersectionCode: string;
  intersectionTypeCode: string;
  intersectionTypeName: string;
  members: IntersectionMember[];
  attributes: Record<string, any>;
  validFrom: string;
  validTo: string;
}

const POSITIONS_QUERY = `
  query Positions($filter: IntersectionFilter, $pagination: PaginationInput, $asOfDate: Date) {
    intersections(filter: $filter, pagination: $pagination, asOfDate: $asOfDate) {
      edges {
        node {
          id
          intersectionCode
          intersectionTypeCode
          intersectionTypeName
          members {
            memberRole
            entityId
            entityCode
            entityName
            domainCode
          }
          attributes
          validFrom
          validTo
        }
      }
      totalCount
    }
  }
`;

export default function PositionsPage() {
  const [positions, setPositions] = useState<PositionNode[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const asOfDate = useTemporalStore(state => state.asOfDate);

  const fetchPositions = useCallback(async () => {
    const { data } = await graphqlQuery<{ intersections: { edges: { node: PositionNode }[]; totalCount: number } }, any>(
      POSITIONS_QUERY,
      { filter: { intersectionTypeCode: 'POSITION' }, asOfDate }
    );
    if (data?.intersections) {
      setPositions(data.intersections.edges.map(e => e.node));
      setTotalCount(data.intersections.totalCount);
    }
    setLoading(false);
  }, [asOfDate]);

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

  const handleCreate = async (intersection: any) => {
    setShowCreateModal(false);
    await fetchPositions();
  };

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Positions</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#475569' }}></div>
          <div>
            <div className="page-title">Positions</div>
            <div className="page-meta">{totalCount} records · Intersection Model</div>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn">Export</button>
          <button className="btn">Bulk Edit</button>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ New Record</button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-label">Filter</div>
        <div className="filter-pill">
          Position Type: All <span style={{ color: 'var(--ink-4)' }}>▾</span>
        </div>
        <div className="filter-pill">
          Status: All <span style={{ color: 'var(--ink-4)' }}>▾</span>
        </div>
        <div className="filter-count">
          Showing <strong>{positions.length}</strong> of {totalCount}
        </div>
      </div>

      <div className="data-table">
        <div className="tbl-head">
          <div>Code</div>
          <div>Members</div>
          <div>Attributes</div>
          <div>Valid From</div>
          <div style={{ textAlign: 'center' }}>Status</div>
        </div>
        {loading ? (
          <div className="tbl-row"><div>Loading...</div></div>
        ) : positions.length === 0 ? (
          <div className="tbl-row"><div>No positions found. Create a position by selecting intersecting entities (Fund + Security).</div></div>
        ) : (
          positions.map((position) => (
            <Link key={position.id} href={`/positions/${position.intersectionCode}`}>
              <div className="tbl-row" style={{ cursor: 'pointer' }}>
                <div className="row-id">{position.intersectionCode}</div>
                <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
                  {position.members.map((m, i) => (
                    <span key={i} style={{ marginRight: '8px' }}>
                      {m.memberRole}: {m.entityName}
                    </span>
                  ))}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
                  {Object.keys(position.attributes || {}).slice(0, 3).map(k => (
                    <span key={k} style={{ marginRight: '8px' }}>
                      {k}: {String(position.attributes[k]?.value ?? '').slice(0, 20)}
                    </span>
                  ))}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--ink-3)' }}>{position.validFrom}</div>
                <div style={{ textAlign: 'center' }}>
                  <span className="status-chip active">Active</span>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px', maxHeight: '90vh', overflow: 'auto' }}>
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Create New Position</h2>
              <button onClick={() => setShowCreateModal(false)} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer' }}>×</button>
            </div>
            <IntersectionForm
              intersectionTypeCode="POSITION"
              onSubmit={handleCreate}
              onCancel={() => setShowCreateModal(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}


