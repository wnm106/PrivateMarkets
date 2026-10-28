'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { graphqlQuery } from '@/lib/graphql';
import { RECORD_EXPERIENCES_QUERY, type RecordExperience } from '@/lib/experience';
import { AppGrid, type ColDef } from '@/components/grid/AppGrid';

export default function ExperiencesAdminPage() {
  const [rows, setRows] = useState<RecordExperience[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    graphqlQuery<{ recordExperiences: RecordExperience[] }, { isActive: boolean }>(
      RECORD_EXPERIENCES_QUERY,
      { isActive: true },
      'network-only',
    ).then((result) => {
      if (result.error) {
        setError(result.error.message || 'Could not load experiences');
        return;
      }
      setRows(result.data?.recordExperiences || []);
    });
  }, []);

  const columns = useMemo<ColDef<RecordExperience>[]>(() => [
    { field: 'experienceName', headerName: 'Experience', minWidth: 200, flex: 1.2 },
    {
      colId: 'code',
      headerName: 'Code',
      minWidth: 220,
      flex: 1,
      valueGetter: (params) => params.data ? `${params.data.experienceCode} · ${params.data.anchorDomainCode}${params.data.isDefault ? ' · default' : ''}` : '',
    },
    { field: 'description', headerName: 'Description', minWidth: 220, flex: 1.4, autoHeight: true, wrapText: true },
    {
      colId: 'sections',
      headerName: 'Sections',
      minWidth: 220,
      flex: 1.4,
      autoHeight: true,
      wrapText: true,
      valueGetter: (params) => params.data ? `${params.data.sections.map((section) => section.title).join(' · ')}${params.data.pipeline ? ' · pipeline' : ''}` : '',
    },
  ], []);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Record Experiences</span>
      </div>
      <div className="page-header">
        <div className="page-title-block">
          <div>
            <div className="page-title">Record Experiences</div>
            <div className="page-meta">Working screens composed from entities, relationships, and dashboards</div>
          </div>
        </div>
        <div className="page-actions">
          <Link href="/pipeline" className="btn btn-primary">Deal Pipeline</Link>
        </div>
      </div>
      {error && <div className="xp-error">{error}</div>}
      <div className="data-table">
        <AppGrid
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          autoHeight={false}
          height="100%"
          autoRowHeight
          emptyMessage={error || 'No experiences yet.'}
        />
      </div>
    </div>
  );
}
