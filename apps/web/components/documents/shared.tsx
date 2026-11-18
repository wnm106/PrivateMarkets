'use client';

import { useEffect, useRef, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';

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
  READY: 'Ready',
  FAILED: 'Could not be read',
};
const STAGE_TEXT: Record<string, string> = { READING: 'Reading the file', TAGGING: 'Tagging sections', EMBEDDING: 'Embedding for search' };

/** Where a document is in being read, in words. */
export function DocumentStatus({ document }: { document: DocumentRow }) {
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
  }
  return (
    <div>
      <span style={{ color, fontWeight: 500 }}>{STATUS_TEXT[document.status]}</span>
      {detail && <div style={hint}>{detail}</div>}
    </div>
  );
}

interface EntityHit {
  id: string;
  entityName: string;
  entityCode: string;
  domainName: string;
}

const SEARCH_ENTITIES = `query($query: String!) { searchEntities(query: $query, limit: 8) { id entityName entityCode domainName } }`;

/** The records a document is about. Search by name, pick, and say what each is to the document. */
export function EntityLinksEditor({ links, onChange }: { links: EntityLink[]; onChange: (links: EntityLink[]) => void }) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<EntityHit[]>([]);
  const latest = useRef(0);

  useEffect(() => {
    const query = text.trim();
    if (query.length < 2) {
      setHits([]);
      return;
    }
    const mine = latest.current + 1;
    latest.current = mine;
    const timer = setTimeout(async () => {
      const { data } = await graphqlQuery<{ searchEntities: EntityHit[] }, { query: string }>(SEARCH_ENTITIES, { query }, 'network-only');
      if (latest.current === mine) setHits(data?.searchEntities || []);
    }, 250);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {links.map((link, index) => (
        <div key={`${link.entityId}:${index}`} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 500 }}>{link.entityName}</span>
          <select className="text-input" style={{ width: 150 }} value={link.role} aria-label={`What ${link.entityName} is to the document`}
            onChange={(event) => onChange(links.map((other, at) => (at === index ? { ...other, role: event.target.value } : other)))}>
            {[...new Set([...ENTITY_ROLES, link.role])].map((role) => (
              <option key={role} value={role}>{role.charAt(0) + role.slice(1).toLowerCase()}</option>
            ))}
          </select>
          <button type="button" className="btn btn-sm" onClick={() => onChange(links.filter((_, at) => at !== index))}>Remove</button>
        </div>
      ))}
      <div style={{ position: 'relative', maxWidth: 420 }}>
        <input className="text-input" value={text} placeholder="Find a record by name or code" aria-label="Find a record to link"
          onChange={(event) => setText(event.target.value)} />
        {hits.length > 0 && (
          <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, top: '100%', background: 'var(--surface, #fff)', border: '1px solid var(--line, #e5e5e5)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}>
            {hits.map((hit) => (
              <button key={hit.id} type="button"
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 0, cursor: 'pointer', fontSize: 13 }}
                onClick={() => {
                  if (!links.some((link) => link.entityId === hit.id)) {
                    onChange([...links, { entityId: hit.id, entityName: hit.entityName, entityCode: hit.entityCode, role: 'SUBJECT' }]);
                  }
                  setText('');
                  setHits([]);
                }}>
                {hit.entityName} <span style={hint}>{hit.domainName} · {hit.entityCode}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
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
