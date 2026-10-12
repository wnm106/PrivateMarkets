'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

interface MapDomain {
  domainCode: string;
  templateCode: string;
  identityColumn: string;
  nameColumn: string;
  attributes: { column: string; attributeCode: string }[];
  parents: { column: string; parentDomainCode: string }[];
}

interface FeedMapInfo {
  mapCode: string;
  sourceCode: string;
  name: string;
  description: string;
  loadWaves: string[][];
  domains: MapDomain[];
}

interface NormalizationHit {
  attributeCode: string;
  listCode: string;
  input: string;
  canonicalCode: string | null;
  canonicalLabel: string | null;
  matchType: string;
}

interface Preview {
  rowCount: number;
  fileName: string;
  loadWaves: string[][];
  domains: {
    domainCode: string;
    distinctEntities: number;
    parentColumns: { column: string; parentDomainCode: string; relationshipCode: string | null }[];
  }[];
  unmappedColumns: string[];
  contextColumns: { column: string; purpose: string }[];
  suggestedAsOfDate: string | null;
  normalizations: NormalizationHit[];
  warnings: string[];
}

interface LoadResult {
  asOfDate: string;
  rowCount: number;
  loadWaves: string[][];
  domains: { domainCode: string; distinctEntities: number; created: number; matched: number; failed: number; errors: string[] }[];
  relationships: { created: number; matched: number; failed: number };
  attributes: { created: number; updated: number; unchanged: number };
  warnings: string[];
  errors: string[];
}

function todayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

const DOMAIN_LABEL: Record<string, string> = {
  ISSUER: 'Issuer',
  FUND: 'Fund',
  SECURITY: 'Security',
  POSITION: 'Position',
};

export default function PositionFilePage() {
  const [mapInfo, setMapInfo] = useState<FeedMapInfo | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<LoadResult | null>(null);
  const [asOfMode, setAsOfMode] = useState<'today' | 'specific'>('specific');
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [busy, setBusy] = useState<'preview' | 'load' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/feeds/position-file')
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'The position file map is unavailable');
        setMapInfo(body);
      })
      .catch((err) => setError(err.message));
  }, []);

  const chosenDate = asOfMode === 'today' ? todayIso() : asOfDate;

  const createdTotal = useMemo(
    () => result?.domains.reduce((sum, domain) => sum + domain.created, 0) ?? 0,
    [result]
  );
  const matchedTotal = useMemo(
    () => result?.domains.reduce((sum, domain) => sum + domain.matched, 0) ?? 0,
    [result]
  );

  async function send(mode: 'preview' | 'load', selected: File) {
    setBusy(mode);
    setError(null);
    if (mode === 'load') setResult(null);
    const form = new FormData();
    form.set('file', selected);
    form.set('mode', mode);
    form.set('asOfDate', chosenDate);
    try {
      const response = await fetch('/api/feeds/position-file', { method: 'POST', body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The file could not be loaded');
      if (mode === 'preview') {
        setPreview(body);
        if (body.suggestedAsOfDate) {
          setAsOfDate(body.suggestedAsOfDate);
          setAsOfMode('specific');
        }
      } else {
        setResult(body);
      }
    } catch (err: any) {
      setError(err.message || 'The file could not be loaded');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Position File</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#1b3a4b' }} />
          <div>
            <div className="page-title">Position file load</div>
            <div className="page-meta">
              {mapInfo ? `${mapInfo.name} · source ${mapInfo.sourceCode}` : 'Source map'}
            </div>
          </div>
        </div>
      </div>

      <p className="hero-sub" style={{ maxWidth: 760, marginTop: 0 }}>
        {mapInfo?.description || 'Upload a flat position file. Each column is mapped to one entity, list values are normalized, and parents load before the records that reference them.'}
      </p>

      {error && (
        <div className="filter-bar" style={{ borderColor: 'var(--red, #b42318)', color: 'var(--red, #b42318)' }}>
          {error}
        </div>
      )}

      <div className="section-title">
        <h2>Load order</h2>
        <span className="hint">Computed from the parent columns on this source map</span>
      </div>
      <div className="nav-row">
        {(preview?.loadWaves || mapInfo?.loadWaves || []).map((wave, index) => (
          <div key={wave.join('-')} className="nav-card" style={{ cursor: 'default' }}>
            <div className="nav-icon">{index + 1}</div>
            <div>
              <div className="nav-title">{wave.map((code) => DOMAIN_LABEL[code] || code).join(' and ')}</div>
              <div className="nav-desc">
                {index === 0 ? 'No parents in this file' : `After ${ (preview?.loadWaves || mapInfo?.loadWaves || []).slice(0, index).flat().map((code) => DOMAIN_LABEL[code] || code).join(', ') }`}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">
        <h2>Column map</h2>
        <span className="hint">Specific to {mapInfo?.sourceCode || 'POSITION_FILE'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginBottom: 22 }}>
        {(mapInfo?.domains || []).map((domain) => (
          <div key={domain.domainCode} className="nav-card" style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <div>
              <div className="nav-title">{DOMAIN_LABEL[domain.domainCode] || domain.domainCode}</div>
              <div className="nav-desc" style={{ marginBottom: 8 }}>
                Identity <strong>{domain.identityColumn}</strong>
                {domain.parents.length > 0 && (
                  <> · depends on {domain.parents.map((parent) => parent.parentDomainCode).join(', ')}</>
                )}
              </div>
              {domain.attributes.map((attribute) => (
                <div key={attribute.column} style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.6 }}>
                  {attribute.column} → {attribute.attributeCode}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">
        <h2>File and as-of date</h2>
      </div>
      <div className="filter-bar" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <label className="btn">
          {file ? file.name : 'Choose CSV or Excel'}
          <input
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            style={{ display: 'none' }}
            onChange={(event) => {
              const selected = event.target.files?.[0] || null;
              setFile(selected);
              setPreview(null);
              setResult(null);
              if (selected) send('preview', selected);
            }}
          />
        </label>
        <label className="filter-pill" style={{ cursor: 'pointer' }}>
          <input
            type="radio"
            name="asof"
            checked={asOfMode === 'today'}
            onChange={() => setAsOfMode('today')}
          />{' '}
          Today ({todayIso()})
        </label>
        <label className="filter-pill" style={{ cursor: 'pointer' }}>
          <input
            type="radio"
            name="asof"
            checked={asOfMode === 'specific'}
            onChange={() => setAsOfMode('specific')}
          />{' '}
          Specific date
        </label>
        {asOfMode === 'specific' && (
          <input
            type="date"
            value={asOfDate}
            onChange={(event) => setAsOfDate(event.target.value)}
            style={{ border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', padding: '6px 8px' }}
          />
        )}
        <button
          className="btn btn-primary"
          disabled={!file || busy !== null || !chosenDate}
          onClick={() => file && send('load', file)}
        >
          {busy === 'load' ? 'Loading…' : `Load as of ${chosenDate}`}
        </button>
        {busy === 'preview' && <span className="nav-desc">Reading the file…</span>}
      </div>

      {preview && (
        <>
          <div className="section-title">
            <h2>Preview</h2>
            <span className="hint">{preview.fileName} · {preview.rowCount} rows</span>
          </div>
          <div className="nav-row">
            {preview.domains.map((domain) => (
              <div key={domain.domainCode} className="nav-card" style={{ cursor: 'default' }}>
                <div>
                  <div className="nav-title">{domain.distinctEntities}</div>
                  <div className="nav-desc">
                    {DOMAIN_LABEL[domain.domainCode] || domain.domainCode}
                    {domain.parentColumns.length > 0 && (
                      <> · {domain.parentColumns.map((parent) => parent.relationshipCode || parent.parentDomainCode).join(', ')}</>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {preview.contextColumns.length > 0 && (
            <div className="nav-desc" style={{ marginBottom: 12 }}>
              {preview.contextColumns.map((column) => `${column.column}: ${column.purpose}`).join(' · ')}
            </div>
          )}
          {preview.unmappedColumns.length > 0 && (
            <div className="nav-desc" style={{ marginBottom: 12 }}>Unmapped columns: {preview.unmappedColumns.join(', ')}</div>
          )}
          <div className="data-table" style={{ marginBottom: 22 }}>
            <div className="tbl-head" style={{ gridTemplateColumns: '180px 160px 1fr 160px 120px' }}>
              <div>Attribute</div>
              <div>List</div>
              <div>File value</div>
              <div>List value</div>
              <div>Match</div>
            </div>
            {preview.normalizations.map((hit) => (
              <div key={`${hit.attributeCode}-${hit.input}`} className="tbl-row" style={{ gridTemplateColumns: '180px 160px 1fr 160px 120px' }}>
                <div>{hit.attributeCode}</div>
                <div>{hit.listCode}</div>
                <div>{hit.input}</div>
                <div>{hit.canonicalCode || '—'}</div>
                <div>{hit.matchType === 'unmapped' ? 'Needs a list value' : hit.matchType.replace('_', ' ')}</div>
              </div>
            ))}
          </div>
          {preview.warnings.length > 0 && (
            <div className="nav-desc" style={{ marginBottom: 18 }}>{preview.warnings.join(' · ')}</div>
          )}
        </>
      )}

      {result && (
        <>
          <div className="section-title">
            <h2>Load result</h2>
            <span className="hint">As of {result.asOfDate}</span>
          </div>
          <div className="page-header">
            <div>
              <div className="page-title" style={{ fontSize: 18 }}>
                {createdTotal === 0
                  ? `${matchedTotal} existing entities matched. No new entities were created.`
                  : `${createdTotal} entities created, ${matchedTotal} matched.`}
              </div>
              <div className="page-meta">
                Attributes created {result.attributes.created}, updated {result.attributes.updated}, unchanged {result.attributes.unchanged}.
                Relationships created {result.relationships.created}, matched {result.relationships.matched}.
              </div>
            </div>
            <div className="page-actions">
              <Link href="/issuers" className="btn">Issuers</Link>
              <Link href="/funds" className="btn">Funds</Link>
              <Link href="/securities" className="btn">Securities</Link>
              <Link href="/positions" className="btn">Positions</Link>
            </div>
          </div>
          <div className="data-table">
            <div className="tbl-head" style={{ gridTemplateColumns: '160px 1fr 1fr 1fr 1fr' }}>
              <div>Entity</div>
              <div>In file</div>
              <div>Created</div>
              <div>Matched</div>
              <div>Failed</div>
            </div>
            {result.domains.map((domain) => (
              <div key={domain.domainCode} className="tbl-row" style={{ gridTemplateColumns: '160px 1fr 1fr 1fr 1fr' }}>
                <div>{DOMAIN_LABEL[domain.domainCode] || domain.domainCode}</div>
                <div>{domain.distinctEntities}</div>
                <div>{domain.created}</div>
                <div>{domain.matched}</div>
                <div>{domain.failed}</div>
              </div>
            ))}
          </div>
          {(result.errors.length > 0 || result.warnings.length > 0) && (
            <div className="nav-desc" style={{ marginTop: 12 }}>
              {[...result.errors, ...result.warnings].slice(0, 8).join(' · ')}
            </div>
          )}
        </>
      )}
    </div>
  );
}
