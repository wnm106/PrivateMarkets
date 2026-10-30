'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface Option {
  id: string;
  label: string;
  detail?: string;
}

interface Question {
  id: string;
  prompt: string;
  detail: string;
  required: boolean;
  assumed: boolean;
  answer: string | null;
  options: Option[];
  allowDate?: boolean;
  allowText?: boolean;
  textLabel?: string;
}

interface Recommendation {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  payload: {
    column?: string;
    dataType?: string;
    columns?: { column: string; role: string; attributeName?: string }[];
  };
}

interface Reading {
  findings: string[];
  questions: Question[];
  recommendations: Recommendation[];
  map: {
    mapCode: string;
    name: string;
    sourceCode: string;
    description: string;
    domains: {
      domainCode: string;
      identityColumn: string;
      nameColumn: string;
      attributes: { column: string; attributeCode: string }[];
      parents: { column: string; parentDomainCode: string; existing?: boolean }[];
    }[];
  } | null;
  loadWaves: string[][];
  blockedReasons: string[];
  sampleRows: Record<string, string>[];
  asOfDate: string | null;
  sourceCode: string | null;
  focusQuestionId: string | null;
  acceptedRecommendationIds: string[];
}

interface SessionSummary {
  id: string;
  fileName: string;
  rowCount: number;
  status: string;
  receivedAt: string;
  asOfDate: string | null;
  sourceCode: string | null;
}

interface SessionDetail extends SessionSummary {
  extractionMethod: string;
  extractionNote: string | null;
  savedMapCode: string | null;
  errorMessage: string | null;
  reading: Reading;
  dismissedRecommendationIds: string[];
  result: {
    domains: { domainCode: string; created: number; matched: number; failed: number }[];
    relationships: { created: number; matched: number; failed: number };
    attributes: { created: number; updated: number; unchanged: number };
    warnings: string[];
    errors: string[];
  } | null;
}

interface LibraryResponse {
  azureConfigured: boolean;
  maps: { mapCode: string; name: string; sourceCode: string; description: string; domains: string[] }[];
  sessions: SessionSummary[];
}

function formatWhen(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
}

function answerLabel(question: Question) {
  if (!question.answer) return 'Not decided';
  const option = question.options.find((item) => item.id === question.answer);
  if (option) return option.label;
  if (question.answer.startsWith('date:')) return question.answer.slice(5);
  if (question.answer.startsWith('new:')) return question.answer.slice(4);
  return question.answer;
}

export function DataSpecialist() {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);
  const [dateDraft, setDateDraft] = useState('');
  const [sourceDraft, setSourceDraft] = useState('');
  const [mapName, setMapName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshLibrary() {
    const response = await fetch('/api/feeds/specialist');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'The specialist is unavailable');
    setLibrary(body);
  }

  useEffect(() => {
    refreshLibrary().catch((err) => setError(err.message));
  }, []);

  function show(session: SessionDetail) {
    setDetail(session);
    setOpenQuestion(session.reading.focusQuestionId);
    setMapName(session.reading.map?.name || '');
    setError(null);
  }

  async function openSession(id: string) {
    setBusy('open');
    setError(null);
    try {
      const response = await fetch(`/api/feeds/specialist/${id}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The session could not be opened');
      show(body);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function send(next: { answers?: Record<string, string>; accepted?: string[]; dismissed?: string[] }) {
    if (!detail) return;
    setBusy('answer');
    setError(null);
    try {
      const response = await fetch(`/api/feeds/specialist/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers: next.answers || {},
          acceptedRecommendationIds: next.accepted ?? detail.reading.acceptedRecommendationIds,
          dismissedRecommendationIds: next.dismissed ?? detail.dismissedRecommendationIds,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'That answer could not be applied');
      show(body);
      await refreshLibrary();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  const reading = detail?.reading;
  const openRecommendations = (reading?.recommendations || []).filter((item) =>
    !reading?.acceptedRecommendationIds.includes(item.id) && !detail?.dismissedRecommendationIds.includes(item.id)
  );
  const ready = Boolean(reading && reading.blockedReasons.length === 0 && reading.map);

  return (
    <div className="view-fade">
      <style>{`
        .specialist-grid { display: grid; grid-template-columns: 1fr; gap: 22px; align-items: start; }
        @media (min-width: 980px) {
          .specialist-grid { grid-template-columns: minmax(320px, 460px) minmax(0, 1fr); }
        }
        .specialist-note { border-left: 3px solid #1b3a4b; padding: 2px 0 2px 12px; margin: 0 0 10px; }
      `}</style>
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Data specialist</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#1b3a4b' }} />
          <div>
            <div className="page-title">Data specialist</div>
            <div className="page-meta">Any file, one map, parents first</div>
          </div>
        </div>
        <label className="btn btn-primary">
          {busy === 'upload' ? 'Reading…' : 'Bring a file'}
          <input
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls,.json,.pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.doc,.docx"
            style={{ display: 'none' }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setBusy('upload');
              setError(null);
              const form = new FormData();
              form.set('file', file);
              try {
                const response = await fetch('/api/feeds/specialist', { method: 'POST', body: form });
                const body = await response.json();
                if (!response.ok) throw new Error(body.error || 'The file could not be read');
                show(body);
                await refreshLibrary();
              } catch (err: any) {
                setError(err.message);
              } finally {
                setBusy(null);
              }
            }}
          />
        </label>
      </div>

      <p className="hero-sub" style={{ maxWidth: 820, marginTop: 0 }}>
        Drop in a CSV, workbook, JSON extract, or a PDF. I map columns onto the entities you already track, reuse a map when I recognize one, and ask only when a date, a source, or an entity id could go more than one way. If the data has nowhere to live, I will say so and wait for you to add the attribute or entity.
      </p>
      <p className="page-meta" style={{ marginTop: 0 }}>
        {library?.azureConfigured
          ? 'Azure Document Intelligence is available for PDFs and scans.'
          : 'Azure Document Intelligence is not configured. Structured files still load. Set AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT and AZURE_DOCUMENT_INTELLIGENCE_KEY to read PDFs and scans.'}
        {' '}The position file remains available on <Link href="/imports">its own queue</Link>.
      </p>
      {error && <div className="filter-bar" style={{ color: '#b42318' }}>{error}</div>}

      <div className="section-title">
        <h2>Saved maps</h2>
        <span className="hint">Reusable across files</span>
      </div>
      <div className="filter-bar" style={{ flexWrap: 'wrap', gap: 8 }}>
        {(library?.maps || []).length === 0 && <span className="nav-desc">No maps stored yet. The Position File map is used as soon as the catalog is available.</span>}
        {(library?.maps || []).map((map) => (
          <span key={map.mapCode} className="filter-pill" title={map.description}>
            {map.name} · {map.domains.join(', ') || 'no entities'}
          </span>
        ))}
      </div>

      <div className="section-title">
        <h2>Recent files</h2>
        <span className="hint">Eastern time</span>
      </div>
      <div className="data-table" style={{ marginBottom: 22 }}>
        <div className="tbl-head" style={{ gridTemplateColumns: '190px 1.4fr 80px 120px 1fr' }}>
          <div>Received</div>
          <div>File</div>
          <div>Rows</div>
          <div>Status</div>
          <div>Source</div>
        </div>
        {(library?.sessions || []).length === 0 ? (
          <div className="tbl-row" style={{ gridTemplateColumns: '1fr' }}><div>No files yet.</div></div>
        ) : library?.sessions.map((session) => (
          <div key={session.id} className="tbl-row" style={{ gridTemplateColumns: '190px 1.4fr 80px 120px 1fr' }}>
            <div>{formatWhen(session.receivedAt)}</div>
            <button onClick={() => openSession(session.id)} style={{ textAlign: 'left', background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }}>{session.fileName}</button>
            <div>{session.rowCount}</div>
            <div>{session.status}</div>
            <div>{session.sourceCode || '—'}</div>
          </div>
        ))}
      </div>

      {detail && reading && (
        <div className="specialist-grid">
          <section>
            <div className="section-title">
              <h2>{detail.fileName}</h2>
              <span className="hint">{detail.extractionNote}</span>
            </div>
            {reading.findings.map((finding) => (
              <p key={finding} className="specialist-note">{finding}</p>
            ))}

            {reading.questions.map((question) => {
              const open = openQuestion === question.id || (openQuestion === null && question.id === reading.focusQuestionId);
              return (
                <article key={question.id} style={{ border: open ? '1px solid #1b3a4b' : '1px solid var(--line)', padding: '12px 14px', marginBottom: 10, background: 'var(--surface)' }}>
                  <button onClick={() => setOpenQuestion(open ? '' : question.id)} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit' }}>
                    <div style={{ fontWeight: 600 }}>{question.prompt}</div>
                    <div className="page-meta" style={{ marginTop: 4 }}>
                      {question.assumed ? 'Assumed' : question.answer ? 'Answered' : question.required ? 'Needed' : 'Optional'}
                      {' · '}
                      {answerLabel(question)}
                    </div>
                  </button>
                  {open && (
                    <div style={{ marginTop: 10 }}>
                      <p style={{ marginTop: 0 }}>{question.detail}</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {question.options.map((option) => (
                          <button
                            key={option.id}
                            className="btn"
                            disabled={busy !== null}
                            onClick={() => {
                              if (option.id === 'specific') return;
                              send({ answers: { [question.id]: option.id } });
                            }}
                            style={{ textAlign: 'left', background: question.answer === option.id ? '#e7eef2' : undefined }}
                          >
                            <div>{option.label}</div>
                            {option.detail && <div className="page-meta">{option.detail}</div>}
                          </button>
                        ))}
                      </div>
                      {question.allowDate && (
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                          <input type="date" value={dateDraft} onChange={(event) => setDateDraft(event.target.value)} style={{ border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', padding: '6px 8px' }} />
                          <button className="btn" disabled={busy !== null || !dateDraft} onClick={() => send({ answers: { [question.id]: `date:${dateDraft}` } })}>Use this date</button>
                        </div>
                      )}
                      {question.allowText && (
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                          <input value={sourceDraft} placeholder={question.textLabel || 'New source'} onChange={(event) => setSourceDraft(event.target.value)} style={{ flex: 1, border: '1px solid var(--line)', padding: '6px 8px' }} />
                          <button className="btn" disabled={busy !== null || !sourceDraft.trim()} onClick={() => send({ answers: { [question.id]: `new:${sourceDraft.trim()}` } })}>Use this source</button>
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </section>

          <section>
            {openRecommendations.length > 0 && (
              <>
                <div className="section-title">
                  <h2>Nothing fits yet</h2>
                  <span className="hint">I will not add these unless you accept them</span>
                </div>
                {openRecommendations.map((item) => (
                  <article key={item.id} style={{ border: '1px solid var(--line)', padding: '12px 14px', marginBottom: 10 }}>
                    <div style={{ fontWeight: 600 }}>{item.title}</div>
                    <p style={{ margin: '6px 0 10px' }}>{item.rationale}</p>
                    {item.payload.dataType && <div className="page-meta">Stored as {item.payload.dataType}</div>}
                    {item.payload.columns && (
                      <div className="page-meta">{item.payload.columns.map((column) => `${column.column} (${column.role})`).join(' · ')}</div>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button className="btn btn-primary" disabled={busy !== null} onClick={() => send({ accepted: [...reading.acceptedRecommendationIds, item.id] })}>Add it</button>
                      <button className="btn" disabled={busy !== null} onClick={() => send({ dismissed: [...detail.dismissedRecommendationIds, item.id] })}>Leave it out</button>
                    </div>
                  </article>
                ))}
              </>
            )}

            <div className="section-title">
              <h2>{reading.map ? reading.map.name : 'Map'}</h2>
              <span className="hint">{reading.map ? reading.map.mapCode : 'Waiting on a decision'}</span>
            </div>
            {reading.map && reading.map.domains.length > 0 ? (
              <div className="data-table" style={{ marginBottom: 14 }}>
                <div className="tbl-head" style={{ gridTemplateColumns: '140px 1fr 1.3fr' }}>
                  <div>Entity</div>
                  <div>Identity</div>
                  <div>Depends on</div>
                </div>
                {reading.map.domains.map((domain) => (
                  <div key={domain.domainCode} className="tbl-row" style={{ gridTemplateColumns: '140px 1fr 1.3fr', cursor: 'default' }}>
                    <div className="row-id">{domain.domainCode}</div>
                    <div>
                      {domain.identityColumn}
                      {domain.nameColumn !== domain.identityColumn ? ` · ${domain.nameColumn}` : ''}
                      {domain.attributes.length > 0 && (
                        <div className="page-meta">{domain.attributes.map((attribute) => attribute.attributeCode).join(', ')}</div>
                      )}
                    </div>
                    <div>{domain.parents.length === 0 ? '—' : domain.parents.map((parent) => `${parent.parentDomainCode}${parent.existing ? ' (already stored)' : ''}`).join(', ')}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p>I do not have an entity id yet, so there is nothing to load.</p>
            )}
            {reading.loadWaves.length > 0 && (
              <p className="page-meta">Load order {reading.loadWaves.map((wave) => wave.join(' + ')).join(' → ')}</p>
            )}
            {reading.blockedReasons.length > 0 && (
              <div className="filter-bar" style={{ marginBottom: 12 }}>{reading.blockedReasons[0]}</div>
            )}
            <div className="filter-bar" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button
                className="btn btn-primary"
                disabled={!ready || busy !== null}
                onClick={async () => {
                  setBusy('load');
                  setError(null);
                  try {
                    const response = await fetch(`/api/feeds/specialist/${detail.id}/load`, { method: 'POST' });
                    const body = await response.json();
                    if (!response.ok) throw new Error(body.error || 'The file could not be loaded');
                    show(body);
                    await refreshLibrary();
                  } catch (err: any) {
                    setError(err.message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === 'load' ? 'Loading…' : ready ? `Load as of ${reading.asOfDate}` : 'Load'}
              </button>
              <input value={mapName} onChange={(event) => setMapName(event.target.value)} placeholder="Map name" style={{ border: '1px solid var(--line)', padding: '6px 8px' }} />
              <button
                className="btn"
                disabled={!reading.map || busy !== null}
                onClick={async () => {
                  setBusy('save');
                  setError(null);
                  try {
                    const response = await fetch(`/api/feeds/specialist/${detail.id}/save`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name: mapName }),
                    });
                    const body = await response.json();
                    if (!response.ok) throw new Error(body.error || 'The map could not be saved');
                    show(body);
                    await refreshLibrary();
                  } catch (err: any) {
                    setError(err.message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === 'save' ? 'Saving…' : detail.savedMapCode ? 'Update saved map' : 'Save map'}
              </button>
            </div>
            {detail.result && (
              <div style={{ marginTop: 14 }}>
                <div className="page-meta">
                  {detail.result.domains.map((domain) => `${domain.domainCode}: ${domain.created} created, ${domain.matched} matched${domain.failed ? `, ${domain.failed} failed` : ''}`).join(' · ')}
                </div>
                <div className="page-meta">
                  Attributes created {detail.result.attributes.created}, updated {detail.result.attributes.updated}. Relationships created {detail.result.relationships.created}, matched {detail.result.relationships.matched}.
                </div>
                {detail.errorMessage && <div className="filter-bar" style={{ color: '#b42318' }}>{detail.errorMessage}</div>}
                {detail.result.warnings.slice(0, 4).map((warning) => <div key={warning} className="page-meta">{warning}</div>)}
              </div>
            )}
            {reading.sampleRows.length > 0 && (
              <div className="data-table" style={{ marginTop: 16, overflowX: 'auto' }}>
                <div className="tbl-head" style={{ gridTemplateColumns: `repeat(${Math.min(Object.keys(reading.sampleRows[0]).length, 6)}, minmax(120px, 1fr))` }}>
                  {Object.keys(reading.sampleRows[0]).slice(0, 6).map((header) => <div key={header}>{header}</div>)}
                </div>
                {reading.sampleRows.slice(0, 4).map((row, index) => (
                  <div key={index} className="tbl-row" style={{ gridTemplateColumns: `repeat(${Math.min(Object.keys(reading.sampleRows[0]).length, 6)}, minmax(120px, 1fr))`, cursor: 'default' }}>
                    {Object.keys(reading.sampleRows[0]).slice(0, 6).map((header) => <div key={header}>{row[header] || '—'}</div>)}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
