'use client';

import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';
import { graphqlQuery, graphqlMutation } from '@/lib/graphql';
import { useTemporalStore } from '@/lib/store';

interface IntersectionMember {
  memberRole: string;
  entityId: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
}

interface IntersectionNode {
  id: string;
  intersectionCode: string;
  intersectionTypeCode: string;
  intersectionTypeName: string;
  members: IntersectionMember[];
  attributes: Record<string, any>;
  validFrom: string;
  validTo: string;
}

const INTERSECTIONS_QUERY = `
  query Intersections($filter: IntersectionFilter, $pagination: PaginationInput, $asOfDate: Date) {
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
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      totalCount
    }
  }
`;

export default function IntersectionsPage() {
  const [intersections, setIntersections] = useState<IntersectionNode[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const asOfDate = useTemporalStore(state => state.asOfDate);

  const fetchIntersections = useCallback(async () => {
    const { data } = await graphqlQuery<{ intersections: { edges: { node: IntersectionNode }[]; totalCount: number } }>(
      INTERSECTIONS_QUERY,
      { asOfDate }
    );
    if (data?.intersections) {
      setIntersections(data.intersections.edges.map(e => e.node));
      setTotalCount(data.intersections.totalCount);
    }
    setLoading(false);
  }, [asOfDate]);

  useEffect(() => {
    fetchIntersections();
  }, [fetchIntersections]);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Intersections</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#6366f1' }}></div>
          <div>
            <div className="page-title">Intersections</div>
            <div className="page-meta">{totalCount} composite entities · Bi-temporal tracking</div>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn">Export</button>
          <button className="btn btn-primary">+ New Intersection</button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-label">Filter</div>
        <div className="filter-pill">
          Type: All <span style={{ color: 'var(--ink-4)' }}>▾</span>
        </div>
        <div className="filter-count">
          Showing <strong>{intersections.length}</strong> of {totalCount}
        </div>
      </div>

      <div className="data-table">
        <div className="tbl-head">
          <div>Code</div>
          <div>Type</div>
          <div>Members</div>
          <div>Attributes</div>
          <div>Valid From</div>
        </div>
        {loading ? (
          <div className="tbl-row"><div>Loading...</div></div>
        ) : intersections.length === 0 ? (
          <div className="tbl-row"><div>No intersections found. Create your first composite entity.</div></div>
        ) : (
          intersections.map((intersection) => (
            <Link key={intersection.id} href={`/intersections/${intersection.intersectionCode}`}>
              <div className="tbl-row" style={{ cursor: 'pointer' }}>
                <div className="row-id">{intersection.intersectionCode}</div>
                <div>{intersection.intersectionTypeName}</div>
                <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
                  {intersection.members.map((m, i) => (
                    <span key={i} style={{ marginRight: '8px' }}>
                      {m.memberRole}: {m.entityName}
                    </span>
                  ))}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
                  {Object.keys(intersection.attributes || {}).slice(0, 3).map(k => (
                    <span key={k} style={{ marginRight: '8px' }}>
                      {k}: {String(intersection.attributes[k]?.value ?? '').slice(0, 20)}
                    </span>
                  ))}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--ink-3)' }}>{intersection.validFrom}</div>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
