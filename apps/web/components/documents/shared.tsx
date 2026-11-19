'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { graphqlQuery } from '@/lib/graphql';
import { domainHref } from '@/lib/domain-routes';

/** Types, styles and small pieces shared by the document screens. */

export interface DocumentTypeRow {
  id: string;
  clientId: string | null;
  typeCode: string;
  typeName: string;
  description: string | null;
  isActive: boolean;
  documentCount: number;
  publishedTemplateId: string | null;
  publishedTemplateVersion: number | null;
}

export interface EntityLink {
  entityId: string;
  entityName: string;
  entityCode?: string | null;
  domainCode?: string | null;
  /** The record type as people read it, when it is known: Fund, Issuer, Deal. */
  typeName?: string | null;
  role: string;
}

export interface DocumentSectionRow {
  id: string;
  seq: number;
  parentSeq: number | null;
  level: number;
  number: string | null;
  heading: string;
  charStart: number;
  charEnd: number;
  templateSectionCode: string | null;
  matchMethod: string | null;
  matchScore: number | null;
  chunkCount: number;
}

export interface DocumentRow {
  id: string;
  typeId: string;
  typeCode: string;
  typeName: string;
  templateId: string | null;
  templateVersion: number | null;
  title: string;
  fileName: string;
  sizeBytes: number | null;
  status: 'RECEIVED' | 'PROCESSING' | 'READY' | 'FAILED';
  stage: string | null;
  message: string | null;
  documentDate: string | null;
  tags: string[];
  format: string | null;
  pageCount: number | null;
  charCount: number;
  chunkCount: number;
  embeddedCount: number;
  embeddingModel: string | null;
  createdAt: string;
  processedAt: string | null;
  entities: EntityLink[];
  sections?: DocumentSectionRow[];
}

export interface TemplateSection {
  code: string;
  title: string;
  parentCode: string | null;
  aliases: string[];
  tags: string[];
  guidance: string;
  required: boolean;
  order: number;
  seenIn: number;
}

export interface TemplateTopic {
  code: string;
  title: string;
  description: string;
}

export interface TemplateRow {
  id: string;
  clientId: string | null;
  typeId: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  sections: TemplateSection[];
  topics: TemplateTopic[];
  sourceDocumentIds: string[];
  notes: string | null;
  updatedAt: string;
  publishedAt: string | null;
}

export const DOCUMENT_FIELDS = `
  id typeId typeCode typeName templateId templateVersion title fileName sizeBytes status stage message documentDate tags
  format pageCount charCount chunkCount embeddedCount embeddingModel createdAt processedAt
  entities { entityId entityName entityCode domainCode role }
`;
export const SECTION_FIELDS = `id seq parentSeq level number heading charStart charEnd templateSectionCode matchMethod matchScore chunkCount`;
export const TEMPLATE_FIELDS = `
  id clientId typeId version status notes sourceDocumentIds updatedAt publishedAt
  sections { code title parentCode aliases tags guidance required order seenIn }
  topics { code title description }
`;
export const TYPE_FIELDS = `id clientId typeCode typeName description isActive documentCount publishedTemplateId publishedTemplateVersion`;

export const ENTITY_ROLES = ['SUBJECT', 'BORROWER', 'LENDER', 'AGENT', 'GUARANTOR', 'FUND', 'INVESTOR', 'ISSUER', 'COUNTERPARTY'];

export const cell: React.CSSProperties = { padding: '8px 8px', verticalAlign: 'top' };
export const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
export const headRow: React.CSSProperties = { textAlign: 'left', color: 'var(--ink-3)', fontSize: 11, textTransform: 'uppercase' };
export const bodyRow: React.CSSProperties = { borderTop: '1px solid var(--line, #e5e5e5)' };
export const hint: React.CSSProperties = { color: 'var(--ink-3)', fontSize: 12 };
export const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, monospace)' };
export const sectionHead: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '24px 0 10px' };
export const sectionTitle: React.CSSProperties = { fontSize: 15, fontWeight: 600, margin: 0 };
export const formBox: React.CSSProperties = { margin: '0 0 16px', padding: 16, border: '1px solid var(--line, #e5e5e5)', borderRadius: 8, display: 'grid', gap: 12, maxWidth: 860 };
export const formRow: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 };
export const field: React.CSSProperties = { display: 'grid', gap: 4 };
export const fieldLabel: React.CSSProperties = { fontSize: 12, color: 'var(--ink-2)' };
export const danger: React.CSSProperties = { color: 'var(--danger, #9b2c2c)' };

const chipBase: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 11,
  border: '1px solid var(--line, #e5e5e5)', color: 'var(--ink-2)', background: 'transparent', lineHeight: 1.6,
};

/** A tag as people read it: "section:NEGATIVE_COVENANTS" is "Negative covenants". */
export function tagLabel(tag: string): string {
  const at = tag.indexOf(':');
  if (at < 0) return tag;
  const prefix = tag.slice(0, at);
  const value = tag.slice(at + 1);
  if (prefix === 'section' || prefix === 'type' || prefix === 'topic') {
    const words = value.toLowerCase().replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  if (prefix === 'kind') return value.charAt(0).toUpperCase() + value.slice(1);
  return value;
}

export function Chip({ children, active, onClick, title }: { children: React.ReactNode; active?: boolean; onClick?: () => void; title?: string }) {
  const style: React.CSSProperties = active
    ? { ...chipBase, borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 600 }
    : chipBase;
  if (!onClick) return <span style={style} title={title}>{children}</span>;
  return (
    <button type="button" onClick={onClick} aria-pressed={Boolean(active)} title={title} style={{ ...style, cursor: 'pointer' }}>
      {children}
    </button>
  );
}

const STATUS_TEXT: Record<DocumentRow['status'], string> = {
  RECEIVED: 'Waiting to be read',
  PROCESSING: 'Being read',
  READY: 'Ready to search',
  FAILED: 'Could not be read',
};
const STAGE_TEXT: Record<string, string> = { READING: 'Reading the file', TAGGING: 'Tagging sections', EMBEDDING: 'Embedding for search' };

/** Where a document is in being read, in words. */
export function DocumentStatus({ document, explain = false }: { document: DocumentRow; explain?: boolean }) {
  const color = document.status === 'FAILED' ? 'var(--danger, #9b2c2c)' : document.status === 'READY' ? 'var(--ink-2)' : 'var(--accent)';
  let detail: string | null = document.message;
  if (document.status === 'PROCESSING') {
    detail = document.stage === 'EMBEDDING' && document.chunkCount > 0
      ? `${STAGE_TEXT.EMBEDDING}: ${document.embeddedCount} of ${document.chunkCount}`
      : STAGE_TEXT[document.stage || ''] || null;
  } else if (document.status === 'RECEIVED') {
    detail = 'The job worker reads it. See Jobs if this does not change.';
  } else if (document.status === 'READY' && !detail && document.embeddedCount < document.chunkCount) {
    detail = `${document.embeddedCount} of ${document.chunkCount} passages searchable by meaning`;
  } else if (document.status === 'READY' && !detail && explain) {
    detail = 'The file has been read, its sections tagged, and its passages indexed.';
  }
  return (
    <div>
      {explain && <div style={{ ...hint, textTransform: 'uppercase', fontSize: 11 }}>Status</div>}
      <span style={{ color, fontWeight: 500 }}>{STATUS_TEXT[document.status]}</span>
      {detail && <div style={hint}>{detail}</div>}
    </div>
  );
}

interface EntityHit {
  id: string;
  domainCode: string;
  entityName: string;
  entityCode: string;
  domainName: string;
}

const SEARCH_ENTITIES = `query($query: String!) { searchEntities(query: $query, limit: 24) { id entityName entityCode domainCode domainName } }`;

/** The page of a linked record, when its type is known. */
export function recordHref(link: { entityId: string; domainCode?: string | null }): string | null {
  return link.domainCode ? `${domainHref(link.domainCode)}/${link.entityId}` : null;
}

/** A linked record's name, as a link to its page where that is known. */
export function RecordName({ link }: { link: { entityId: string; entityName: string; domainCode?: string | null } }) {
  const href = recordHref(link);
  return href ? <Link href={href} className="crumb-link">{link.entityName}</Link> : <>{link.entityName}</>;
}

/** Hits under the record type each belongs to. Types keep the order of their best hit. At most five of a type are shown. */
function groupByType(hits: EntityHit[]): Array<{ type: string; hits: EntityHit[]; more: number }> {
  const groups = new Map<string, EntityHit[]>();
  for (const hit of hits) {
    const type = hit.domainName || 'Other';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type)!.push(hit);
  }
  return [...groups.entries()].map(([type, rows]) => ({ type, hits: rows.slice(0, 5), more: Math.max(rows.length - 5, 0) }));
}

/** Tabs across the top of a page. The panel each shows is the caller's to render. */
export function Tabs({ tabs, current, onChange, label }: { tabs: Array<{ id: string; label: string }>; current: string; onChange: (id: string) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--line, #e5e5e5)', margin: '16px 0 12px' }}>
      {tabs.map((tab) => {
        const on = tab.id === current;
        return (
          <button key={tab.id} type="button" role="tab" aria-selected={on} onClick={() => onChange(tab.id)}
            style={{
              border: 0, background: 'none', padding: '10px 14px', font: 'inherit', fontSize: 13, cursor: 'pointer', marginBottom: -1,
              color: on ? 'var(--ink)' : 'var(--ink-3)', fontWeight: on ? 600 : 400,
              borderBottom: `3px solid ${on ? 'var(--accent)' : 'transparent'}`,
            }}>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** "LIMITED_PARTNER" as "Limited partner". */
function readable(code: string): string {
  const words = code.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The records a document is about, as a table: the record, its type, and what
 * it is to the document. Below it, a search that adds a row. Nothing is saved
 * here; the form this sits in saves the whole table.
 */
export function EntityLinksEditor({ links, onChange, saveLabel = 'Save' }: { links: EntityLink[]; onChange: (links: EntityLink[]) => void; saveLabel?: string }) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<EntityHit[]>([]);
  // The text the list of hits answers. With no hits, it is what nothing was found for.
  const [answered, setAnswered] = useState('');
  const [added, setAdded] = useState('');
  const latest = useRef(0);
  const headingId = useId();

  const query = text.trim();
  useEffect(() => {
    if (query.length < 2) {
      setHits([]);
      setAnswered('');
      return;
    }
    const mine = latest.current + 1;
    latest.current = mine;
    const timer = setTimeout(async () => {
      const { data } = await graphqlQuery<{ searchEntities: EntityHit[] }, { query: string }>(SEARCH_ENTITIES, { query }, 'network-only');
      if (latest.current !== mine) return;
      setHits(data?.searchEntities || []);
      setAnswered(query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const searching = query.length >= 2 && answered !== query;
  const linked = new Set(links.map((link) => link.entityId));

  const add = (hit: EntityHit) => {
    onChange([...links, { entityId: hit.id, entityName: hit.entityName, entityCode: hit.entityCode, domainCode: hit.domainCode, typeName: hit.domainName, role: 'SUBJECT' }]);
    setAdded(hit.entityName);
    setText('');
    setHits([]);
  };

  return (
    <section aria-labelledby={headingId}
      style={{ display: 'grid', gap: 14, marginTop: 8, padding: '16px 16px 12px', border: '1px solid var(--line, #e5e5e5)', borderLeft: '4px solid var(--accent)', borderRadius: 8, background: 'var(--surface-2, rgba(0, 0, 0, 0.02))' }}>
      <div>
        <h3 id={headingId} style={{ fontSize: 16, fontWeight: 600, margin: 0, color: 'var(--ink)' }}>
          Linked records{links.length > 0 ? ` (${links.length})` : ''}
        </h3>
        <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 4 }}>
          The funds, issuers, deals and other records this document is about.
        </div>
      </div>

      <div style={{ display: 'grid', gap: 6, maxWidth: 560 }}>
        <label style={field}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Add a record</span>
          <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>
            Search for a record by its name or code, and click it to add it to this document. The links are kept when you press {saveLabel}.
          </span>
          <input className="text-input" style={{ background: 'var(--surface, #fff)' }} value={text} placeholder="Start typing a name or code, for example Bench Fund" aria-label="Search for a record to link" autoComplete="off"
            onChange={(event) => { setText(event.target.value); setAdded(''); }} />
        </label>

        <div role="status" aria-live="polite" style={hint}>
          {query.length === 0 && added && `${added} was added below. Choose what it is to this document, then press ${saveLabel}.`}
          {query.length === 1 && 'Type at least two characters to search.'}
          {searching && 'Searching…'}
          {!searching && query.length >= 2 && hits.length > 0 && `${hits.length === 24 ? 'More than 24' : hits.length} records match. Click one to add it, or keep typing to narrow the list.`}
          {!searching && query.length >= 2 && hits.length === 0 && `No record matches "${answered}". Check the spelling, or try its code. A document can only be linked to a record that already exists, so if it is new, add the record first and then link it here.`}
        </div>

        {!searching && hits.length > 0 && (
          <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid var(--line, #e5e5e5)', borderRadius: 6, background: 'var(--surface, #fff)' }}>
            {groupByType(hits).map((group) => (
              <div key={group.type} role="group" aria-label={group.type}>
                <div style={{ padding: '6px 10px 2px', fontSize: 11, textTransform: 'uppercase', color: 'var(--ink-3)', letterSpacing: '0.04em' }}>{group.type}</div>
                {group.hits.map((hit) => (
                  linked.has(hit.id) ? (
                    <div key={hit.id} style={{ padding: '5px 10px 5px 18px', fontSize: 13, color: 'var(--ink-3)' }}>
                      {hit.entityName} <span style={hint}>{hit.entityCode} · already added</span>
                    </div>
                  ) : (
                    <button key={hit.id} type="button" onClick={() => add(hit)}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 10px 5px 18px', background: 'transparent', border: 0, cursor: 'pointer', fontSize: 13 }}>
                      {hit.entityName} <span style={hint}>{hit.entityCode}</span>
                    </button>
                  )
                ))}
                {group.more > 0 && <div style={{ ...hint, padding: '2px 10px 6px 18px' }}>{group.more} more of this type. Type more of the name to narrow it down.</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {links.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>No records are linked yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ ...table, maxWidth: 820 }}>
            <thead>
              <tr style={headRow}>
                <th style={cell}>Record</th>
                <th style={cell}>Type</th>
                <th style={cell}>Code</th>
                <th style={cell}>What it is to this document</th>
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {links.map((link, index) => (
                <tr key={`${link.entityId}:${index}`} style={bodyRow}>
                  <td style={{ ...cell, fontWeight: 500, verticalAlign: 'middle' }}><RecordName link={link} /></td>
                  <td style={{ ...cell, verticalAlign: 'middle' }}>{link.typeName || (link.domainCode ? readable(link.domainCode) : '')}</td>
                  <td style={{ ...cell, ...mono, fontSize: 12, verticalAlign: 'middle' }}>{link.entityCode || ''}</td>
                  <td style={{ ...cell, verticalAlign: 'middle' }}>
                    <select className="text-input" style={{ width: 170 }} value={link.role} aria-label={`What ${link.entityName} is to this document`}
                      onChange={(event) => onChange(links.map((other, at) => (at === index ? { ...other, role: event.target.value } : other)))}>
                      {[...new Set([...ENTITY_ROLES, link.role])].map((role) => <option key={role} value={role}>{readable(role)}</option>)}
                    </select>
                  </td>
                  <td style={{ ...cell, textAlign: 'right', verticalAlign: 'middle' }}>
                    <button type="button" className="btn btn-sm" aria-label={`Remove ${link.entityName}`} onClick={() => onChange(links.filter((_, at) => at !== index))}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** "a, b , c" to ["a", "b", "c"]. */
export function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
