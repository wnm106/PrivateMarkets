'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { graphqlQuery, graphqlMutation } from '@/lib/graphql';
import { useTemporalStore } from '@/lib/store';
import { AppGrid, type ColDef } from '@/components/grid/AppGrid';

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

function memberText(row: IntersectionNode) {
  return row.members.map((member) => `${member.memberRole}: ${member.entityName}`).join(', ');
}

function attributeText(row: IntersectionNode) {
  return Object.keys(row.attributes || {}).slice(0, 3).map((key) => `${key}: ${String(row.attributes[key]?.value ?? '').slice(0, 20)}`).join(', ');
}

export default function IntersectionsPage() {
  const router = useRouter();
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

  const columns = useMemo<ColDef<IntersectionNode>[]>(() => [
    { field: 'intersectionCode', headerName: 'Code', minWidth: 160, flex: 1, cellClass: 'mono' },
    { field: 'intersectionTypeName', headerName: 'Type', minWidth: 140, flex: 1 },
    {
      colId: 'members',
      headerName: 'Members',
      minWidth: 220,
      flex: 1.4,
      autoHeight: true,
      wrapText: true,
      valueGetter: (params) => params.data ? memberText(params.data) : '',
    },
    {
      colId: 'attributes',
      headerName: 'Attributes',
      minWidth: 220,
      flex: 1.4,
      autoHeight: true,
      wrapText: true,
      valueGetter: (params) => params.data ? attributeText(params.data) : '',
    },
    { field: 'validFrom', headerName: 'Valid From', minWidth: 140 },
  ], []);

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
        <AppGrid
          rows={intersections}
          columns={columns}
          getRowId={(row) => row.id}
          autoHeight={false}
          height="100%"
          autoRowHeight
          loading={loading}
          emptyMessage="No intersections found."
          onRowClicked={(row) => router.push(`/intersections/${row.intersectionCode}`)}
        />
      </div>
    </div>
  );
}
