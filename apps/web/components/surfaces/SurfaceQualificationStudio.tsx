'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  loadDomainRecords,
  loadSurfaceCatalog,
  loadSurfaceResolution,
  loadSurfaces,
  saveSurfaceCatalog,
  type FundRecord,
  type SurfaceCatalog,
  type SurfaceDefinition,
  type SurfaceResolution,
} from '@/lib/surfaces';
import { SurfaceEditor } from './SurfaceEditor';

const SURFACE_ORDER = ['FUND_SURFACE', 'DEAL_PIPELINE'];

function surfaceErrorText(message: string | undefined): string {
  const text = message || 'Failed to load surfaces';
  if (text.includes('surface_definitions')) {
    return 'The surface catalog is not in the database yet. Run the surface migrations in the Supabase SQL editor, then reload this page.';
  }
  return text;
}

export function SurfaceQualificationStudio() {
  const searchParams = useSearchParams();
  const [surfaces, setSurfaces] = useState<SurfaceDefinition[]>([]);
  const [surfaceCode, setSurfaceCode] = useState(searchParams.get('surface') || 'FUND_SURFACE');
  const [catalog, setCatalog] = useState<SurfaceCatalog | null>(null);
  const [entityCode, setEntityCode] = useState(searchParams.get('entity') || '');
  const [resolution, setResolution] = useState<SurfaceResolution | null>(null);
  const [fundRecords, setFundRecords] = useState<FundRecord[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await loadSurfaces();
      if (cancelled) return;
      if (result.error) {
        setError(surfaceErrorText(result.error.message));
        setLoadingCatalog(false);
        return;
      }
      const rows = result.data?.surfaces || [];
      setSurfaces(rows);
      if (rows.length === 0) setError('No surfaces are defined yet.');
      setLoadingCatalog(false);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!surfaceCode) return;
    let cancelled = false;
    setLoadingCatalog(true);
    (async () => {
      const result = await loadSurfaceCatalog(surfaceCode);
      if (cancelled) return;
      if (result.error) {
        setError(result.error.message || 'Failed to load the surface catalog');
        setCatalog(null);
      } else {
        setCatalog(result.data?.surfaceCatalog ?? null);
        setError(null);
      }
      setLoadingCatalog(false);
    })();
    return () => { cancelled = true; };
  }, [surfaceCode]);

  useEffect(() => {
    const domain = catalog?.surface.domainCode;
    if (!domain) return;
    let cancelled = false;
    (async () => {
      const result = await loadDomainRecords(domain);
      if (cancelled) return;
      const rows = result.data?.entities.edges.map((edge) => edge.node) ?? [];
      setFundRecords(rows);
      const preferred = domain === 'DEAL' ? 'Project Brightwater' : 'Harbor Senior Income';
      setEntityCode((current) => current && rows.some((row) => row.entityCode === current)
        ? current
        : rows.find((row) => row.entityName === preferred)?.entityCode || rows[0]?.entityCode || '');
    })();
    return () => { cancelled = true; };
  }, [catalog?.surface.domainCode, catalog?.surface.surfaceCode]);

  useEffect(() => {
    if (!surfaceCode || !entityCode) return;
    let cancelled = false;
    (async () => {
      const result = await loadSurfaceResolution({ surfaceCode, entityCode });
      if (cancelled) return;
      setResolution(result.data?.resolveSurface ?? null);
    })();
    return () => { cancelled = true; };
  }, [surfaceCode, entityCode, catalog?.surface.domainCode]);

  const orderedSurfaces = [...surfaces].sort((left, right) => {
    const leftIndex = SURFACE_ORDER.indexOf(left.surfaceCode);
    const rightIndex = SURFACE_ORDER.indexOf(right.surfaceCode);
    return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
  });
  const previewFund = fundRecords.find((fund) => fund.entityCode === entityCode);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Surface qualification</span>
      </div>
      <div className="page-header">
        <div>
          <div className="page-title">Surface qualification</div>
          <div className="page-meta">
            {catalog?.surface.description || 'Saved rules decide which tabs are open when you open a record.'}
          </div>
        </div>
        <label style={{ fontSize: 13, color: 'var(--ink-2)' }}>
          Surface{' '}
          <select value={surfaceCode} aria-label="Surface" onChange={(event) => setSurfaceCode(event.target.value)} style={{ marginLeft: 6, padding: '6px 8px' }}>
            {orderedSurfaces.map((surface) => <option key={surface.surfaceCode} value={surface.surfaceCode}>{surface.surfaceName}</option>)}
          </select>
        </label>
      </div>
      {error && <div style={{ background: '#fdecec', color: '#b91c1c', padding: '12px 14px', marginBottom: 16, fontSize: 13 }}>{error}</div>}
      {loadingCatalog && !catalog && <div style={{ color: 'var(--ink-3)' }}>Loading…</div>}
      {catalog && (
        <SurfaceEditor
          catalog={catalog}
          funds={fundRecords}
          previewId={previewFund?.id || ''}
          onPreview={(id) => setEntityCode(fundRecords.find((fund) => fund.id === id)?.entityCode || '')}
          resolution={resolution}
          onSave={async (tabs) => {
            const result = await saveSurfaceCatalog(surfaceCode, tabs);
            if (result.error || !result.data?.saveSurfaceCatalog) {
              return result.error?.message || 'Could not save the surface.';
            }
            setCatalog(result.data.saveSurfaceCatalog);
            const resolved = await loadSurfaceResolution({ surfaceCode, entityCode });
            setResolution(resolved.data?.resolveSurface ?? null);
            return null;
          }}
        />
      )}
    </div>
  );
}
