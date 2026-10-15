'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { graphqlQuery, graphqlMutation, DOMAIN_TYPES_QUERY, ENTITIES_QUERY } from '@/lib/graphql';
import { authHeaders } from '@/lib/reporting';
import { retargetLine } from '@tapestrai/graphql/src/lib/statement-template/build';
import type { CatalogAttribute } from '@tapestrai/graphql/src/lib/statement-template/types';

type SourceKind = 'image' | 'file' | 'paste';
type MatchKind = 'exact' | 'alias' | 'manual' | 'new';

interface DraftLine {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  displayOrder: number;
  displayLabel: string;
  matchKind: MatchKind;
  confidence: number;
  isNew: boolean;
  required: boolean;
  aliases: string[];
  sampleValue: string | null;
  sources: string[];
}

interface DraftSection {
  sectionCode: string;
  sectionName: string;
  displayOrder: number;
  lines: DraftLine[];
}

interface CatalogEntry {
  attributeCode: string;
  attributeName: string;
  dataType: string;
}

interface PreparedSource {
  id: string;
  sourceName: string;
  sourceKind: SourceKind;
  text: string;
  previewUrl?: string;
  file?: File;
}

interface DomainOption {
  domainCode: string;
  domainName: string;
}

interface EntityOption {
  entityCode: string;
  entityName: string;
}

const PREVIEW_QUERY = `
  query PreviewStatementTemplate($input: PreviewStatementTemplateInput!) {
    previewStatementTemplate(input: $input) {
      warnings
      catalog { attributeCode attributeName dataType }
      sections {
        sectionCode
        sectionName
        displayOrder
        lines {
          attributeCode
          attributeName
          dataType
          displayOrder
          displayLabel
          matchKind
          confidence
          isNew
          required
          aliases
          sampleValue
          sources
        }
      }
    }
  }
`;

const APPLY_MUTATION = `
  mutation ApplyStatementTemplate($input: ApplyStatementTemplateInput!) {
    applyStatementTemplate(input: $input) {
      aliasCount
      sectionCount
      template { id templateCode templateName domainCode }
      errors { field message code }
    }
  }
`;

const DATA_TYPES = ['NUMBER', 'STRING', 'DATE', 'BOOLEAN'];

function codeFromName(value: string): string {
  const code = value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return code && /^[A-Z]/.test(code) ? code : code ? `T_${code}` : '';
}

function renumber<T extends { displayOrder: number }>(items: T[]): T[] {
  return items.map((item, index) => ({ ...item, displayOrder: index + 1 }));
}

function move<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const next = index + direction;
  if (next < 0 || next >= items.length) return items;
  const copy = items.slice();
  const [item] = copy.splice(index, 1);
  copy.splice(next, 0, item);
  return copy;
}

function kindLabel(kind: string): string {
  if (kind === 'NAV') return 'NAV statement';
  if (kind === 'FINANCIAL') return 'Financial statement';
  return 'Custom statement';
}

export default function StatementStudioPage() {
  const [domains, setDomains] = useState<DomainOption[]>([]);
  const [entities, setEntities] = useState<EntityOption[]>([]);
  const [domainCode, setDomainCode] = useState('FUND');
  const [statementKind, setStatementKind] = useState('NAV');
  const [scope, setScope] = useState<'domain' | 'entity'>('domain');
  const [entityCode, setEntityCode] = useState('');
  const [templateName, setTemplateName] = useState('Fund NAV statement');
  const [templateCode, setTemplateCode] = useState('FUND_NAV_STATEMENT');
  const [nameTouched, setNameTouched] = useState(false);
  const [codeTouched, setCodeTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [paste, setPaste] = useState('');
  const [sources, setSources] = useState<PreparedSource[]>([]);
  const [sections, setSections] = useState<DraftSection[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<{ templateCode: string; aliasCount: number; sectionCount: number } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const domain = params.get('domain');
    const kind = params.get('kind');
    if (domain) setDomainCode(domain.toUpperCase());
    if (kind) setStatementKind(kind.toUpperCase());
  }, []);

  useEffect(() => {
    graphqlQuery<{ domainTypes: DomainOption[] }, Record<string, never>>(DOMAIN_TYPES_QUERY).then((result) => {
      const rows = result.data?.domainTypes || [];
      if (rows.length > 0) setDomains(rows);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    graphqlQuery<{ entities: { edges: Array<{ node: EntityOption }> } }, { filter: { domainCode: string; isActive: boolean }; pagination: { first: number } }>(ENTITIES_QUERY, {
      filter: { domainCode, isActive: true },
      pagination: { first: 100 },
    }).then((result) => {
      setEntities((result.data?.entities?.edges || []).map((edge) => edge.node));
    }).catch(() => setEntities([]));
  }, [domainCode]);

  useEffect(() => {
    if (nameTouched) return;
    const domainName = domains.find((domain) => domain.domainCode === domainCode)?.domainName || titleCase(domainCode);
    const nextName = `${domainName} ${kindLabel(statementKind)}`;
    setTemplateName(nextName);
    if (!codeTouched) setTemplateCode(codeFromName(nextName));
  }, [domainCode, statementKind, domains, nameTouched, codeTouched]);

  const lineCount = useMemo(
    () => sections.reduce((sum, section) => sum + section.lines.length, 0),
    [sections],
  );
  const aliasCount = useMemo(
    () => sections.reduce((sum, section) => sum + section.lines.filter((line) => line.matchKind === 'alias' || line.matchKind === 'manual').length, 0),
    [sections],
  );

  function addPastedStatement() {
    const text = paste.trim();
    if (!text) return;
    setSources((current) => [...current, {
      id: crypto.randomUUID(),
      sourceName: `Pasted statement ${current.filter((source) => source.sourceKind === 'paste').length + 1}`,
      sourceKind: 'paste',
      text,
    }]);
    setPaste('');
    setSaved(null);
  }

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    setSources((current) => [
      ...current,
      ...files.map((file) => ({
        id: crypto.randomUUID(),
        sourceName: file.name,
        sourceKind: (file.type.startsWith('image/') ? 'image' : 'file') as SourceKind,
        text: '',
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      })),
    ]);
    setSaved(null);
  }

  function removeSource(id: string) {
    setSources((current) => {
      const target = current.find((source) => source.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((source) => source.id !== id);
    });
  }

  async function buildTemplate() {
    setError('');
    setSaved(null);
    if (sources.length === 0 && !paste.trim()) {
      setError('Paste a table or add a file or image first.');
      return;
    }
    setBuilding(true);
    try {
      const prepared = sources.slice();
      if (paste.trim()) {
        prepared.push({
          id: 'pending-paste',
          sourceName: `Pasted statement ${prepared.filter((source) => source.sourceKind === 'paste').length + 1}`,
          sourceKind: 'paste',
          text: paste.trim(),
        });
      }
      const binary = prepared.filter((source) => !source.text && source.file);
      const extracted = new Map<string, string>();
      if (binary.length > 0) {
        const form = new FormData();
        binary.forEach((source) => {
          const file = source.file;
          if (file) form.append('files', file, source.sourceName);
        });
        const response = await fetch('/api/templates/statement/extract', {
          method: 'POST',
          headers: authHeaders(),
          body: form,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'The file could not be read.');
        (body.sources || []).forEach((source: { sourceName: string; text: string }, index: number) => {
          extracted.set(binary[index]?.id || source.sourceName, source.text);
        });
      }
      const withText = prepared.map((source) => ({
        ...source,
        text: source.text || extracted.get(source.id) || '',
      }));
      setSources(withText.filter((source) => source.id !== 'pending-paste'));
      setPaste('');

      const result = await graphqlQuery<{
        previewStatementTemplate: { sections: DraftSection[]; warnings: string[]; catalog: CatalogEntry[] };
      }, { input: Record<string, unknown> }>(PREVIEW_QUERY, {
        input: {
          domainCode,
          statementKind,
          sources: withText.map((source) => ({
            sourceName: source.sourceName,
            sourceKind: source.sourceKind,
            text: source.text,
          })),
        },
      }, 'network-only');
      if (result.error) throw new Error(result.error.message || 'The statements could not be read.');
      const draft = result.data?.previewStatementTemplate;
      if (!draft) throw new Error('The statements could not be read.');
      setSections(draft.sections);
      setWarnings(draft.warnings || []);
      setCatalog(draft.catalog || []);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'The statements could not be read.');
    } finally {
      setBuilding(false);
    }
  }

  function updateSection(index: number, patch: Partial<DraftSection>) {
    setSections((current) => current.map((section, sectionIndex) => (
      sectionIndex === index ? { ...section, ...patch } : section
    )));
  }

  function updateLine(sectionIndex: number, lineIndex: number, patch: Partial<DraftLine>) {
    setSections((current) => current.map((section, index) => {
      if (index !== sectionIndex) return section;
      return {
        ...section,
        lines: section.lines.map((line, itemIndex) => (itemIndex === lineIndex ? { ...line, ...patch } : line)),
      };
    }));
  }

  function chooseAttribute(sectionIndex: number, lineIndex: number, attributeCode: string) {
    setSections((current) => current.map((section, index) => {
      if (index !== sectionIndex) return section;
      return {
        ...section,
        lines: section.lines.map((line, itemIndex) => {
          if (itemIndex !== lineIndex) return line;
          if (!attributeCode) return retargetLine(line, null) as DraftLine;
          const attribute = catalog.find((entry) => entry.attributeCode === attributeCode);
          if (!attribute) return line;
          const catalogAttribute: CatalogAttribute = { ...attribute, aliases: [] };
          return retargetLine(line, catalogAttribute) as DraftLine;
        }),
      };
    }));
  }

  async function saveTemplate() {
    setError('');
    if (!templateCode || !templateName) {
      setError('Template name and code are required.');
      return;
    }
    if (sections.length === 0) {
      setError('Build the template before saving it.');
      return;
    }
    setSaving(true);
    try {
      const result = await graphqlMutation<{
        applyStatementTemplate: {
          aliasCount: number;
          sectionCount: number;
          template: { templateCode: string } | null;
          errors: Array<{ message: string }>;
        };
      }, { input: Record<string, unknown> }>(APPLY_MUTATION, {
        input: {
          templateCode,
          templateName,
          domainCode,
          description: description || null,
          statementKind,
          entityCode: scope === 'entity' ? entityCode || null : null,
          sections: sections.filter((section) => section.lines.length > 0).map((section) => ({
            sectionCode: section.sectionCode,
            sectionName: section.sectionName,
            displayOrder: section.displayOrder,
            lines: section.lines.map((line) => ({
              attributeCode: line.attributeCode,
              attributeName: line.attributeName,
              dataType: line.dataType,
              displayOrder: line.displayOrder,
              displayLabel: line.displayLabel,
              matchKind: line.matchKind,
              isNew: line.isNew,
              required: line.required,
              aliases: line.aliases,
            })),
          })),
          sources: sources.map((source) => ({
            sourceName: source.sourceName,
            sourceKind: source.sourceKind,
            excerpt: source.text.slice(0, 4000),
          })),
        },
      });
      if (result.error) throw new Error(result.error.message || 'The template could not be saved.');
      const payload = result.data?.applyStatementTemplate;
      const message = payload?.errors?.[0]?.message;
      if (!payload?.template) throw new Error(message || 'The template could not be saved.');
      setSaved({
        templateCode: payload.template.templateCode,
        aliasCount: payload.aliasCount,
        sectionCount: payload.sectionCount,
      });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'The template could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/admin/templates" className="crumb-link">Templates</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Statement studio</span>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">Statement studio</div>
          <div className="page-meta">
            Supply NAV statements or financial statements. The studio aggregates their sections and keeps an alias when a line is another name for an attribute you already have.
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" style={bannerStyle('var(--red)')}>{error}</div>
      )}
      {saved && (
        <div role="status" style={bannerStyle('var(--green)')}>
          Saved {saved.templateCode} with {saved.sectionCount} sections and {saved.aliasCount} aliases.{' '}
          <Link href="/admin/templates">Open templates</Link>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px', alignItems: 'start' }}>
        <section style={panelStyle}>
          <div className="section-title" style={{ marginTop: 0 }}>
            <h2>Template</h2>
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="statement-domain">Entity type</label>
              <select id="statement-domain" className="select" value={domainCode} onChange={(event) => setDomainCode(event.target.value)}>
                {(domains.length > 0 ? domains : defaultDomains).map((domain) => (
                  <option key={domain.domainCode} value={domain.domainCode}>{domain.domainName}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="statement-kind">Statement</label>
              <select id="statement-kind" className="select" value={statementKind} onChange={(event) => setStatementKind(event.target.value)}>
                <option value="NAV">NAV statement</option>
                <option value="FINANCIAL">Financial statement</option>
                <option value="CUSTOM">Custom statement</option>
              </select>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Applies to</label>
              <div style={{ display: 'flex', gap: '14px', marginTop: '6px' }}>
                <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <input type="radio" name="scope" checked={scope === 'domain'} onChange={() => setScope('domain')} />
                  Any {domainCode.toLowerCase()}
                </label>
                <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <input type="radio" name="scope" checked={scope === 'entity'} onChange={() => setScope('entity')} />
                  One entity
                </label>
              </div>
              {scope === 'entity' && (
                <div style={{ marginTop: '8px' }}>
                  {entities.length > 0 ? (
                    <select className="select" value={entityCode} onChange={(event) => setEntityCode(event.target.value)} aria-label="Entity">
                      <option value="">Choose an entity</option>
                      {entities.map((entity) => (
                        <option key={entity.entityCode} value={entity.entityCode}>{entity.entityName} ({entity.entityCode})</option>
                      ))}
                    </select>
                  ) : (
                    <input className="text-input mono" value={entityCode} placeholder="Entity code" onChange={(event) => setEntityCode(event.target.value)} aria-label="Entity code" />
                  )}
                </div>
              )}
            </div>
            <div className="field">
              <label htmlFor="template-name">Template name</label>
              <input id="template-name" className="text-input" value={templateName} onChange={(event) => { setNameTouched(true); setTemplateName(event.target.value); if (!codeTouched) setTemplateCode(codeFromName(event.target.value)); }} />
            </div>
            <div className="field">
              <label htmlFor="template-code">Template code</label>
              <input id="template-code" className="text-input mono" value={templateCode} onChange={(event) => { setCodeTouched(true); setTemplateCode(codeFromName(event.target.value)); }} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="template-description">Description</label>
              <textarea id="template-description" className="text-input" rows={2} value={description} placeholder="Optional note about this statement shape" onChange={(event) => setDescription(event.target.value)} />
            </div>
          </div>

          <div className="section-title">
            <h2>Statements</h2>
            <span className="hint">Paste a table, or drop CSV, Excel, HTML, JSON, or an image</span>
          </div>
          <label htmlFor="statement-paste" style={{ display: 'block', fontSize: '11px', color: 'var(--ink-3)', marginBottom: '6px' }}>
            Paste a table or a statement
          </label>
          <textarea
            id="statement-paste"
            className="text-input"
            rows={8}
            value={paste}
            placeholder={'Assets\nInvestments at Fair Value    12400000\nCash and Cash Equivalents     1250000\n\nNet Asset Value\nEnding NAV                   13565000'}
            onChange={(event) => setPaste(event.target.value)}
            onPaste={(event) => {
              const html = event.clipboardData.getData('text/html');
              if (html && /<table/i.test(html)) {
                event.preventDefault();
                setPaste(html);
              }
            }}
            style={{ width: '100%', fontFamily: 'var(--font-ibm-plex-mono), monospace', fontSize: '12px' }}
          />
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm" onClick={addPastedStatement} disabled={!paste.trim()}>Add pasted statement</button>
            <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
              Add files or images
              <input
                type="file"
                multiple
                accept="image/*,.csv,.txt,.tsv,.xlsx,.xls,.html,.md,.json,text/csv,text/plain,text/html"
                style={{ display: 'none' }}
                onChange={(event) => {
                  if (event.target.files) addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
          <div
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (event.dataTransfer.files?.length) addFiles(event.dataTransfer.files);
            }}
            style={{ marginTop: '10px', border: '1px dashed var(--line-strong)', padding: '14px', color: 'var(--ink-3)', fontSize: '12px', textAlign: 'center' }}
          >
            Drop statement files and images here
          </div>

          {sources.length > 0 && (
            <ul style={{ listStyle: 'none', marginTop: '12px', display: 'grid', gap: '6px' }}>
              {sources.map((source) => (
                <li key={source.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', border: '1px solid var(--line)', padding: '8px 10px', background: 'var(--bg)' }}>
                  {source.previewUrl && <img src={source.previewUrl} alt="" style={{ width: '42px', height: '42px', objectFit: 'cover', border: '1px solid var(--line)' }} />}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{source.sourceName}</div>
                    <div className="mono" style={{ fontSize: '10px', color: 'var(--ink-3)' }}>{source.sourceKind}{source.text ? ' · read' : ''}</div>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => removeSource(source.id)}>Remove</button>
                </li>
              ))}
            </ul>
          )}

          <div style={{ marginTop: '14px' }}>
            <button type="button" className="btn btn-primary" onClick={buildTemplate} disabled={building}>
              {building ? 'Building sections…' : 'Build template'}
            </button>
          </div>
        </section>

        <section style={panelStyle}>
          <div className="section-title" style={{ marginTop: 0 }}>
            <h2>Aggregated sections</h2>
            <span className="hint">{sections.length === 0 ? 'Nothing built yet' : `${sections.length} sections · ${lineCount} lines · ${aliasCount} aliases`}</span>
          </div>
          <p style={{ color: 'var(--ink-3)', fontSize: '12px', marginBottom: '12px' }}>
            Section and line order follow where each item sat across the statements you supplied. An alias keeps the statement’s wording and stores the value on the existing attribute.
          </p>
          {warnings.map((warning) => (
            <div key={warning} style={{ ...bannerStyle('var(--amber)'), marginBottom: '8px' }}>{warning}</div>
          ))}
          {sections.length === 0 && (
            <div style={{ padding: '28px 8px', color: 'var(--ink-3)', textAlign: 'center' }}>
              The template appears here after you build it.
            </div>
          )}
          {sections.map((section, sectionIndex) => (
            <article key={`${section.sectionCode}-${sectionIndex}`} style={{ border: '1px solid var(--line)', marginBottom: '12px' }}>
              <header style={{ display: 'flex', gap: '8px', alignItems: 'center', padding: '10px 12px', background: 'var(--bg)', borderBottom: '1px solid var(--line)' }}>
                <span className="mono" style={{ color: 'var(--ink-3)', width: '18px' }}>{section.displayOrder}</span>
                <input
                  className="text-input"
                  aria-label={`Section ${section.displayOrder} name`}
                  value={section.sectionName}
                  onChange={(event) => updateSection(sectionIndex, { sectionName: event.target.value })}
                  style={{ flex: 1 }}
                />
                <button type="button" className="btn btn-sm" onClick={() => setSections((current) => renumber(move(current, sectionIndex, -1)))} aria-label="Move section up">Up</button>
                <button type="button" className="btn btn-sm" onClick={() => setSections((current) => renumber(move(current, sectionIndex, 1)))} aria-label="Move section down">Down</button>
              </header>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--ink-3)', fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      <th style={cellStyle}>Line</th>
                      <th style={cellStyle}>Attribute</th>
                      <th style={cellStyle}>Type</th>
                      <th style={cellStyle}>Alias</th>
                      <th style={cellStyle}>Required</th>
                      <th style={cellStyle}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.lines.map((line, lineIndex) => (
                      <tr key={`${line.attributeCode}-${lineIndex}`} style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={cellStyle}>
                          <input className="text-input" aria-label="Statement label" value={line.displayLabel} onChange={(event) => {
                            const displayLabel = event.target.value;
                            const aliases = line.aliases.filter((alias) => alias !== line.displayLabel);
                            if (displayLabel.trim() && displayLabel.trim().toLowerCase() !== line.attributeName.toLowerCase()) aliases.unshift(displayLabel.trim());
                            updateLine(sectionIndex, lineIndex, { displayLabel, aliases: [...new Set(aliases)] });
                          }} />
                          {line.sampleValue && <div className="mono" style={{ color: 'var(--ink-3)', marginTop: '4px' }}>{line.sampleValue}</div>}
                        </td>
                        <td style={cellStyle}>
                          <select
                            className="select"
                            aria-label="Canonical attribute"
                            value={line.isNew ? '' : line.attributeCode}
                            onChange={(event) => chooseAttribute(sectionIndex, lineIndex, event.target.value)}
                          >
                            <option value="">New · {line.isNew ? line.attributeCode : 'create attribute'}</option>
                            {catalog.map((attribute) => (
                              <option key={attribute.attributeCode} value={attribute.attributeCode}>
                                {attribute.attributeCode} · {attribute.attributeName}
                              </option>
                            ))}
                          </select>
                          <div style={{ marginTop: '6px' }}><MatchPill line={line} /></div>
                        </td>
                        <td style={cellStyle}>
                          <select className="select" aria-label="Data type" value={line.dataType} onChange={(event) => updateLine(sectionIndex, lineIndex, { dataType: event.target.value })}>
                            {DATA_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                          </select>
                        </td>
                        <td style={cellStyle}>
                          {line.aliases.length === 0 && <span style={{ color: 'var(--ink-4)' }}>—</span>}
                          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                            {line.aliases.map((alias) => (
                              <span key={alias} className="mono" style={{ fontSize: '10px', padding: '2px 6px', border: '1px solid var(--line)', background: 'var(--bg)' }}>{alias}</span>
                            ))}
                          </div>
                        </td>
                        <td style={{ ...cellStyle, textAlign: 'center' }}>
                          <input type="checkbox" checked={line.required} aria-label={`Required ${line.displayLabel}`} onChange={(event) => updateLine(sectionIndex, lineIndex, { required: event.target.checked })} />
                        </td>
                        <td style={cellStyle}>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button type="button" className="btn btn-sm" aria-label="Move line up" onClick={() => updateSection(sectionIndex, { lines: renumber(move(section.lines, lineIndex, -1)) })}>Up</button>
                            <button type="button" className="btn btn-sm" aria-label="Move line down" onClick={() => updateSection(sectionIndex, { lines: renumber(move(section.lines, lineIndex, 1)) })}>Down</button>
                            <button type="button" className="btn btn-sm" onClick={() => updateSection(sectionIndex, { lines: renumber(section.lines.filter((_, itemIndex) => itemIndex !== lineIndex)) })}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
          {sections.length > 0 && (
            <button type="button" className="btn btn-primary" onClick={saveTemplate} disabled={saving}>
              {saving ? 'Saving…' : 'Save template and aliases'}
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function MatchPill({ line }: { line: DraftLine }) {
  const tone = line.matchKind === 'exact'
    ? { background: 'rgba(47,125,79,0.12)', color: 'var(--green)' }
    : line.matchKind === 'new'
      ? { background: 'rgba(26,140,255,0.12)', color: 'var(--accent)' }
      : { background: 'rgba(201,138,12,0.16)', color: 'var(--amber)' };
  const label = line.matchKind === 'exact'
    ? 'Exact'
    : line.matchKind === 'new'
      ? 'New attribute'
      : line.matchKind === 'manual'
        ? `Alias of ${line.attributeCode}`
        : `Alias of ${line.attributeCode}`;
  return (
    <span style={{ ...tone, fontSize: '10px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '2px 6px' }}>
      {label}{line.matchKind === 'alias' ? ` · ${Math.round(line.confidence * 100)}%` : ''}
    </span>
  );
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

const defaultDomains: DomainOption[] = [
  { domainCode: 'FUND', domainName: 'Fund' },
  { domainCode: 'ISSUER', domainName: 'Issuer' },
  { domainCode: 'SECURITY', domainName: 'Security' },
  { domainCode: 'DEAL', domainName: 'Deal' },
];

const panelStyle: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  padding: '16px',
};

const cellStyle: CSSProperties = {
  padding: '8px 10px',
  verticalAlign: 'top',
};

function bannerStyle(color: string): CSSProperties {
  return {
    border: `1px solid ${color}`,
    color: 'var(--ink)',
    background: 'var(--surface)',
    padding: '10px 12px',
    marginBottom: '14px',
    fontSize: '12px',
  };
}
