'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  loadSurfaceCatalog,
  loadSurfaceResolution,
  loadSurfaces,
  optionalityLabel,
  type SurfaceCatalog,
  type SurfaceDefinition,
  type SurfaceResolution,
} from '@/lib/surfaces';
import { QualificationTable, StatusBadge } from './QualificationTable';

type Mode = 'profile' | 'entity';

export function SurfaceQualificationStudio() {
  const searchParams = useSearchParams();
  const [surfaces, setSurfaces] = useState<SurfaceDefinition[]>([]);
  const [surfaceCode, setSurfaceCode] = useState(searchParams.get('surface') || '');
  const [catalog, setCatalog] = useState<SurfaceCatalog | null>(null);
  const [mode, setMode] = useState<Mode>(searchParams.get('entity') ? 'entity' : 'profile');
  const [profileCode, setProfileCode] = useState(searchParams.get('profile') || '');
  const [entityCode, setEntityCode] = useState(searchParams.get('entity') || '');
  const [entityDraft, setEntityDraft] = useState(searchParams.get('entity') || '');
  const [resolution, setResolution] = useState<SurfaceResolution | null>(null);
  const [ledger, setLedger] = useState<'all' | 'rendered'>('all');
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingResolution, setLoadingResolution] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await loadSurfaces();
      if (cancelled) return;
      if (result.error) {
        setError(result.error.message || 'Failed to load surfaces');
        setLoadingCatalog(false);
        return;
      }
      const rows = result.data?.surfaces || [];
      setSurfaces(rows);
      if (rows.length === 0) {
        setLoadingCatalog(false);
        setError('No surfaces are defined yet.');
      }
      setSurfaceCode((current) => current || rows[0]?.surfaceCode || '');
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!surfaceCode) return;
    let cancelled = false;
    setLoadingCatalog(true);
    setError(null);
    (async () => {
      const result = await loadSurfaceCatalog(surfaceCode);
      if (cancelled) return;
      if (result.error) {
        setError(result.error.message || 'Failed to load the surface catalog');
        setCatalog(null);
        setLoadingCatalog(false);
        return;
      }
      const next = result.data?.surfaceCatalog ?? null;
      setCatalog(next);
      setProfileCode((current) => {
        if (next?.sampleProfiles.some((profile) => profile.profileCode === current)) return current;
        return next?.sampleProfiles[0]?.profileCode || '';
      });
      setLoadingCatalog(false);
    })();
    return () => { cancelled = true; };
  }, [surfaceCode]);

  useEffect(() => {
    if (!surfaceCode || !catalog || catalog.surface.surfaceCode !== surfaceCode) return;
    if (mode === 'profile' && !catalog.sampleProfiles.some((profile) => profile.profileCode === profileCode)) return;
    if (mode === 'entity' && !entityCode) return;
    let cancelled = false;
    setLoadingResolution(true);
    (async () => {
      const result = await loadSurfaceResolution(
        mode === 'entity'
          ? { surfaceCode, entityCode }
          : { surfaceCode, profileCode },
      );
      if (cancelled) return;
      if (result.error) {
        setError(result.error.message || 'Failed to resolve the surface');
        setResolution(null);
      } else {
        setResolution(result.data?.resolveSurface ?? null);
        setError(null);
      }
      setLoadingResolution(false);
    })();
    return () => { cancelled = true; };
  }, [surfaceCode, catalog, mode, profileCode, entityCode]);

  const experienceName = (code: string) =>
    catalog?.experiences.find((experience) => experience.experienceCode === code)?.experienceName || code;

  const renderedPages = resolution?.pages.filter((page) => page.status === 'RENDERED') ?? [];
  const qualifiedComponents = resolution?.components.filter((component) => component.status === 'QUALIFIED') ?? [];
  const visibleComponents = ledger === 'rendered'
    ? qualifiedComponents
    : resolution?.components ?? [];

  return (
    <div className="view-fade">
      <style>{`
        .surface-qual-grid { display: grid; grid-template-columns: minmax(280px, 0.9fr) minmax(0, 1.4fr); gap: 22px; align-items: start; }
        @media (max-width: 960px) { .surface-qual-grid { grid-template-columns: 1fr; } }
        button.filter-pill { font: inherit; cursor: pointer; }
      `}</style>
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Surface qualification</span>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">Surface qualification</div>
          <div className="page-meta">
            Experiences, page slots, and the rule that qualified each component
          </div>
        </div>
      </div>

      <p style={{ maxWidth: '760px', color: 'var(--ink-2)', fontSize: '14px', lineHeight: 1.5, marginTop: 0 }}>
        A surface stays one shell for its domain. The profile decides which experiences qualify,
        which page variant wins each slot, and which components render. Every row below keeps the
        supporting logic, including components that stayed hidden or lost a priority contest.
      </p>

      {error && (
        <div style={{ background: '#fdecec', color: '#b91c1c', padding: '12px 14px', marginBottom: '16px', fontSize: '13px' }}>
          {error}
        </div>
      )}

      <div className="filter-bar" style={{ marginBottom: '18px' }}>
        <div className="filter-label">Surface</div>
        {surfaces.map((surface) => (
          <button
            key={surface.surfaceCode}
            type="button"
            className={`filter-pill ${surface.surfaceCode === surfaceCode ? 'active' : ''}`}
            onClick={() => {
              setSurfaceCode(surface.surfaceCode);
              setMode('profile');
              setEntityCode('');
              setEntityDraft('');
            }}
          >
            {surface.surfaceName}
          </button>
        ))}
      </div>

      {loadingCatalog && !catalog ? (
        <div style={{ color: 'var(--ink-3)', padding: '24px 0' }}>Loading catalog…</div>
      ) : catalog ? (
        <div className="surface-qual-grid">
          <section>
            <h2 style={sectionTitle}>Authored logic</h2>
            <p style={sectionCopy}>{catalog.surface.description}</p>

            <h3 style={subTitle}>Experiences</h3>
            <QualificationTable
              headers={['Experience', 'Rule']}
              rows={catalog.experiences.map((experience) => [
                <div key={experience.experienceCode}>
                  <div style={{ fontWeight: 600 }}>{experience.experienceName}</div>
                  <div style={codeStyle}>{experience.experienceCode}</div>
                </div>,
                experience.ruleSummary,
              ])}
            />

            <h3 style={{ ...subTitle, marginTop: '18px' }}>Page slots and variants</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {catalog.slots.map((slot) => (
                <div key={slot.slotCode} style={{ border: '1px solid var(--line)', background: 'var(--surface)', padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline' }}>
                    <strong style={{ fontSize: '13px' }}>{slot.slotName}</strong>
                    <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>{optionalityLabel(slot.optionality)}</span>
                  </div>
                  {slot.description && <div style={{ fontSize: '12px', color: 'var(--ink-2)', marginTop: '4px' }}>{slot.description}</div>}
                  <ul style={{ margin: '8px 0 0', paddingLeft: '18px', fontSize: '12px', color: 'var(--ink-2)' }}>
                    {slot.variants.map((variant) => (
                      <li key={variant.variantCode} style={{ marginBottom: '4px' }}>
                        <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{variant.variantName}</span>
                        {' '}priority {variant.qualificationPriority}
                        {variant.requiredExperienceCodes.length === 0
                          ? ' · surface default'
                          : ` · requires ${variant.requiredExperienceCodes.map(experienceName).join(', ')}`}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 style={sectionTitle}>Qualification for a profile</h2>
            <div className="filter-bar" style={{ marginBottom: '12px' }}>
              <div className="filter-label">Profile</div>
              {catalog.sampleProfiles.map((profile) => (
                <button
                  key={profile.profileCode}
                  type="button"
                  className={`filter-pill ${mode === 'profile' && profile.profileCode === profileCode ? 'active' : ''}`}
                  onClick={() => {
                    setMode('profile');
                    setProfileCode(profile.profileCode);
                    setEntityCode('');
                    setEntityDraft('');
                  }}
                >
                  {profile.profileName}
                </button>
              ))}
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                const next = entityDraft.trim();
                if (!next) return;
                setMode('entity');
                setEntityCode(next);
              }}
              style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '14px' }}
            >
              <input
                value={entityDraft}
                onChange={(event) => setEntityDraft(event.target.value)}
                placeholder="Or resolve a live entity code"
                aria-label="Entity code"
                style={{
                  flex: 1,
                  border: '1px solid var(--line)',
                  background: 'var(--surface)',
                  color: 'var(--ink)',
                  padding: '7px 10px',
                  fontSize: '13px',
                }}
              />
              <button className="btn btn-primary" type="submit">Resolve entity</button>
            </form>

            {loadingResolution && <div style={{ color: 'var(--ink-3)', fontSize: '13px' }}>Resolving…</div>}

            {resolution && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <div style={{ fontSize: '16px', fontWeight: 600 }}>{resolution.subjectName}</div>
                  <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '4px' }}>
                    {resolution.subjectKind === 'ENTITY' ? 'Live entity' : 'Sample profile'}
                    {resolution.templateCode ? ` · template ${resolution.templateCode}` : ''}
                    {` · ${renderedPages.length} pages rendered · ${qualifiedComponents.length} components qualified`}
                  </div>
                  {resolution.note && (
                    <div style={{ marginTop: '8px', fontSize: '12px', color: '#92400e' }}>{resolution.note}</div>
                  )}
                </div>

                <div>
                  <h3 style={subTitle}>Classifier facts</h3>
                  <QualificationTable
                    headers={['Fact', 'Value', 'Source']}
                    rows={resolution.facts.map((fact) => [fact.key, fact.value, fact.source])}
                  />
                </div>

                <div>
                  <h3 style={subTitle}>Experiences</h3>
                  <QualificationTable
                    headers={['Experience', 'Status', 'Supporting logic']}
                    rows={resolution.experiences.map((experience) => [
                      experience.experienceName,
                      <StatusBadge key={experience.experienceCode} status={experience.status} />,
                      experience.ruleTrace,
                    ])}
                  />
                </div>

                <div>
                  <h3 style={subTitle}>Page slots</h3>
                  <QualificationTable
                    headers={['Page', 'Optionality', 'Variant', 'Decision']}
                    rows={resolution.pages.map((page) => [
                      page.slotName,
                      optionalityLabel(page.optionality),
                      page.status === 'RENDERED' ? (page.variantName || '—') : <StatusBadge key={page.slotCode} status="HIDDEN" />,
                      page.decision,
                    ])}
                  />
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                    <h3 style={{ ...subTitle, marginBottom: 0 }}>Components</h3>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button type="button" className={`filter-pill ${ledger === 'all' ? 'active' : ''}`} onClick={() => setLedger('all')}>Full catalog</button>
                      <button type="button" className={`filter-pill ${ledger === 'rendered' ? 'active' : ''}`} onClick={() => setLedger('rendered')}>Rendered only</button>
                    </div>
                  </div>
                  <div style={{ marginTop: '8px' }}>
                    <QualificationTable
                      headers={['Component', 'Page', 'Experience', 'Status', 'Supporting logic']}
                      rows={visibleComponents.map((component) => [
                        component.componentName,
                        component.pageName,
                        component.experienceName,
                        <StatusBadge key={component.componentCode} status={component.status} />,
                        component.ruleTrace,
                      ])}
                    />
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

const sectionTitle: CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  margin: '0 0 8px',
};

const sectionCopy: CSSProperties = {
  fontSize: '13px',
  color: 'var(--ink-2)',
  lineHeight: 1.5,
  marginTop: 0,
};

const subTitle: CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
  margin: '0 0 8px',
};

const codeStyle: CSSProperties = {
  fontFamily: 'var(--font-ibm-plex-mono), monospace',
  fontSize: '11px',
  color: 'var(--ink-3)',
  marginTop: '2px',
};
