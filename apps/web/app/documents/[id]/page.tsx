'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePublishTabs, usePublishViewContext } from '@/lib/view-context';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { AnswerView, askDocuments, type DocumentAnswer } from '@/components/documents/AnswerView';
import {
  Chip, DOCUMENT_FIELDS, DocumentStatus, RecordName, Tabs, EntityLinksEditor, SECTION_FIELDS, TEMPLATE_FIELDS, TYPE_FIELDS, danger, field, fieldLabel,
  formBox, formRow, hint, sectionHead, sectionTitle, shortDate, splitList, tagLabel,
  type DocumentRow, type DocumentSectionRow, type DocumentTypeRow, type EntityLink, type TemplateRow,
} from '@/components/documents/shared';

const DOCUMENT_QUERY = `
  query Document($id: ID!) {
    document(id: $id) { ${DOCUMENT_FIELDS} sections { ${SECTION_FIELDS} } }
    documentTypes { ${TYPE_FIELDS} }
  }
`;
const TEMPLATES_QUERY = `query($typeId: ID) { documentTemplates(typeId: $typeId) { ${TEMPLATE_FIELDS} } }`;
const CHUNKS_QUERY = `
  query($documentId: ID!, $sectionId: ID, $first: Int, $offset: Int) {
    documentChunks(documentId: $documentId, sectionId: $sectionId, first: $first, offset: $offset) {
      id sectionId seq kind text charStart charEnd page clause tags embedded thin summary topics refinedBy
    }
  }
`;
const RESULT = `document { ${DOCUMENT_FIELDS} sections { ${SECTION_FIELDS} } } errors { message }`;
const UPDATE_DOCUMENT = `mutation($input: UpdateDocumentInput!) { updateDocument(input: $input) { ${RESULT} } }`;
const RETAG_DOCUMENT = `mutation($id: ID!) { retagDocument(id: $id) { ${RESULT} } }`;
const REPROCESS_DOCUMENT = `mutation($id: ID!) { reprocessDocument(id: $id) { ${RESULT} } }`;
const REFINE_CHUNK = `mutation($chunkId: ID!, $summary: String, $topics: [String!]) { refineDocumentChunk(chunkId: $chunkId, summary: $summary, topics: $topics) { success errors { message } } }`;
const ASSIGN_SECTION = `mutation($sectionId: ID!, $code: String) { assignDocumentSection(sectionId: $sectionId, templateSectionCode: $code) { ${RESULT} } }`;

interface ChunkRow {
  id: string;
  sectionId: string | null;
  seq: number;
  kind: string;
  text: string;
  charStart: number;
  charEnd: number;
  page: number | null;
  clause: string | null;
  tags: string[];
  embedded: boolean;
  thin: boolean;
  summary: string | null;
  topics: string[];
  refinedBy: string | null;
}

interface Draft {
  title: string;
  typeId: string;
  documentDate: string;
  tags: string;
  entities: EntityLink[];
}

/** A heading without its number or label, lower-cased: what is compared with a template section's name. */
function bareHeading(heading: string): string {
  return heading
    .replace(/^(section|article|part|exhibit|schedule|annex|appendix)\s+[a-z0-9][a-z0-9.()-]*\s*[.:-]?\s*/i, '')
    .replace(/^\d+(\.\d+)*\.?\s+/, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function sameHeading(heading: string, templateTitle: string): boolean {
  return bareHeading(heading) === bareHeading(templateTitle);
}

const PAGE_SIZE = 60;

export default function DocumentPage() {
  const params = useParams();
  const search = useSearchParams();
  const id = String(params?.id || '');
  const at = search?.get('at');
  // The passage to show: the one a search result elsewhere pointed at, then whichever is picked from a search on this page.
  const [target, setTarget] = useState<number | null>(at !== null && at !== undefined && at !== '' ? Number(at) : null);

  const [document, setDocument] = useState<DocumentRow | null>(null);
  const [types, setTypes] = useState<DocumentTypeRow[]>([]);
  const [template, setTemplate] = useState<TemplateRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ChunkRow[]>([]);
  const [more, setMore] = useState(false);
  const [tab, setTab] = useState<'passages' | 'details'>('passages');
  const [draft, setDraft] = useState<Draft | null>(null);
  // True while the Details form holds changes that are not saved.
  const [dirty, setDirty] = useState(false);
  const [working, setWorking] = useState(false);
  const [describing, setDescribing] = useState<{ id: string; summary: string; topics: string[] } | null>(null);
  const jumped = useRef(false);
  const [jumpDone, setJumpDone] = useState(false);
  const targetRef = useRef<HTMLDivElement | null>(null);
  // A question about this document, and the summary plus the sections that answer it.
  const [find, setFind] = useState('');
  const [finding, setFinding] = useState(false);
  const [answer, setAnswer] = useState<{ query: string } & DocumentAnswer | null>(null);
  const askTicket = useRef(0);
  // The dropdowns that change which template section a heading maps to. Hidden until asked for.
  const [mapping, setMapping] = useState(false);

  usePublishViewContext({
    activity: 'viewing',
    kind: 'document',
    label: document?.title || 'Document',
    summary: document ? `${document.typeName}, ${document.chunkCount} passages. Document id ${document.id}` : 'A stored document',
  });

  const load = useCallback(async () => {
    const response = await graphqlQuery<{ document: DocumentRow | null; documentTypes: DocumentTypeRow[] }, { id: string }>(DOCUMENT_QUERY, { id }, 'network-only');
    if (response.aborted) return;
    if (response.error) setMessage(response.error.message);
    else {
      setDocument(response.data?.document || null);
      setTypes(response.data?.documentTypes || []);
      if (!response.data?.document) setMessage('This document was not found, or you cannot see it.');
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // The Details form shows the document as it is, until a person starts changing it.
  useEffect(() => {
    if (!document || dirty) return;
    setDraft({
      title: document.title, typeId: document.typeId, documentDate: document.documentDate || '', tags: document.tags.join(', '), entities: document.entities,
    });
  }, [document, dirty]);

  const busy = document?.status === 'RECEIVED' || document?.status === 'PROCESSING';
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [busy, load]);

  // The template the document's sections are named from.
  const templateId = document?.templateId || null;
  const typeId = document?.typeId || null;
  useEffect(() => {
    if (!templateId || !typeId) {
      setTemplate(null);
      return;
    }
    let cancelled = false;
    graphqlQuery<{ documentTemplates: TemplateRow[] }, { typeId: string }>(TEMPLATES_QUERY, { typeId }, 'network-only').then(({ data }) => {
      if (!cancelled) setTemplate(data?.documentTemplates.find((row) => row.id === templateId) || null);
    });
    return () => {
      cancelled = true;
    };
  }, [templateId, typeId]);

  const sections = useMemo(() => document?.sections || [], [document]);

  usePublishTabs(document ? {
    passages: {
      label: 'Passages',
      purpose: 'What the document says: its headings in order and the text of the passages under the open heading.',
      howToRead: 'sections are the document\'s headings; chunkCount is how many passages sit under each. templateSection is the standard section the heading was matched to. openSection and passages are the heading the reader has open and its text, which is the beginning of it when the section is long.',
      data: {
        title: document.title, status: document.status, pages: document.pageCount, passageCount: document.chunkCount,
        sections: sections.slice(0, 150).map((section) => ({ number: section.number, heading: section.heading, level: section.level, passages: section.chunkCount, templateSection: section.templateSectionCode })),
        openSection: sections.find((section) => section.id === sectionId)?.heading || null,
        passages: chunks.slice(0, 30).map((chunk) => ({ page: chunk.page, clause: chunk.clause, kind: chunk.kind, text: chunk.text.length > 700 ? `${chunk.text.slice(0, 700)}…` : chunk.text })),
      },
    },
    details: {
      label: 'Details',
      purpose: 'What the document is and which records it is about: its type, date, tags, linked records and processing status.',
      howToRead: 'role is what the linked record is to the document. status says whether the document has been read: READY means its passages can be searched.',
      data: {
        title: document.title, type: document.typeName, fileName: document.fileName, format: document.format, documentDate: document.documentDate,
        tags: document.tags, status: document.status, stage: document.stage, message: document.message, processedAt: document.processedAt,
        pages: document.pageCount, passages: document.chunkCount, embedded: document.embeddedCount,
        records: document.entities.map((link) => ({ name: link.entityName, code: link.entityCode || null, type: link.typeName || link.domainCode || null, role: link.role })),
      },
    },
  } : {});

  // Arriving from a search result: open the heading that holds the passage.
  useEffect(() => {
    if (jumped.current || target === null || sections.length === 0) return;
    jumped.current = true;
    const holding = sections.filter((section) => section.charStart <= target && target < section.charEnd);
    const deepest = holding[holding.length - 1];
    if (deepest) setSectionId(deepest.id);
    setJumpDone(true);
  }, [sections, target]);

  // Each load is numbered so that an answer for a section the page has left is dropped.
  const loadNumber = useRef(0);
  // The section the passages on screen were loaded for. Undefined before the first load.
  const [chunksFor, setChunksFor] = useState<string | null | undefined>(undefined);
  const loadChunks = useCallback(async (offset: number) => {
    if (!id) return;
    loadNumber.current += 1;
    const mine = loadNumber.current;
    const response = await graphqlQuery<{ documentChunks: ChunkRow[] }, { documentId: string; sectionId: string | null; first: number; offset: number }>(
      CHUNKS_QUERY, { documentId: id, sectionId, first: PAGE_SIZE + 1, offset }, 'network-only',
    );
    if (response.aborted || !response.data || mine !== loadNumber.current) return;
    const rows = response.data.documentChunks;
    setMore(rows.length > PAGE_SIZE);
    setChunks((current) => (offset === 0 ? rows.slice(0, PAGE_SIZE) : [...current, ...rows.slice(0, PAGE_SIZE)]));
    setChunksFor(sectionId);
  }, [id, sectionId]);

  const chunkCount = document?.chunkCount || 0;
  useEffect(() => {
    // Arriving from a search result, wait for the section that holds the passage to be chosen.
    if (target !== null && !jumpDone) return;
    if (chunkCount > 0) loadChunks(0);
    else setChunks([]);
  }, [loadChunks, chunkCount, target, jumpDone]);

  // Keep the chosen heading in view in the list of sections.
  const activeSection = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeSection.current?.scrollIntoView({ block: 'nearest' });
  }, [sectionId]);

  // Bring the passage a search result pointed at into view, reading further into a long section to reach it.
  const scrolled = useRef(false);
  useEffect(() => {
    if (target === null || scrolled.current || !jumped.current) return;
    if (targetRef.current) {
      targetRef.current.scrollIntoView({ block: 'center' });
      scrolled.current = true;
    } else if (chunksFor === sectionId && more && chunks.length > 0 && chunks.length < 900 && chunks[chunks.length - 1].charEnd <= target) {
      // Only read further into the section on screen. Just after a jump the old section's passages are still showing.
      loadChunks(chunks.length);
    }
  }, [chunks, chunksFor, sectionId, more, target, loadChunks]);

  /** Shows the passage at this place in the document, in the section that holds it. */
  const jumpTo = (charStart: number) => {
    const holding = sections.filter((section) => section.charStart <= charStart && charStart < section.charEnd);
    const deepest = holding[holding.length - 1];
    jumped.current = true;
    scrolled.current = false;
    setTarget(charStart);
    setSectionId(deepest ? deepest.id : null);
    setJumpDone(true);
    setAnswer(null);
  };

  const ask = async () => {
    const query = find.trim();
    if (!query) return;
    const ticket = ++askTicket.current;
    setFinding(true);
    const response = await askDocuments({ query, documentIds: [id] });
    if (ticket !== askTicket.current) return;
    setFinding(false);
    if (response.error) {
      setMessage(response.error);
      return;
    }
    setMessage('');
    setAnswer(response.answer ? { query, ...response.answer } : null);
  };

  const run = async (mutation: string, name: string, variables: Record<string, unknown>, done: string) => {
    setWorking(true);
    const { data, error } = await graphqlMutation<Record<string, { document: DocumentRow | null; errors: Array<{ message: string }> }>>(mutation, variables);
    setWorking(false);
    const problem = error?.message || data?.[name]?.errors[0]?.message;
    setMessage(problem || '');
    setNotice(problem ? '' : done);
    const fresh = data?.[name]?.document;
    if (fresh && !problem) setDocument(fresh);
    return !problem;
  };

  const save = async () => {
    if (!draft || !document) return;
    const ok = await run(UPDATE_DOCUMENT, 'updateDocument', {
      input: {
        id: document.id,
        title: draft.title,
        typeId: draft.typeId !== document.typeId ? draft.typeId : null,
        documentDate: draft.documentDate,
        tags: splitList(draft.tags),
        entities: draft.entities.map((link) => ({ entityId: link.entityId, role: link.role })),
      },
    }, 'Saved.');
    if (ok) {
      // The saved document comes back and fills the form again.
      setDirty(false);
      loadChunks(0);
    }
  };

  const edit = (patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
  };

  const saveDescription = async () => {
    if (!describing) return;
    setWorking(true);
    const { data, error } = await graphqlMutation<{ refineDocumentChunk: { errors: Array<{ message: string }> } }>(REFINE_CHUNK, {
      chunkId: describing.id, summary: describing.summary, topics: describing.topics,
    });
    setWorking(false);
    const problem = error?.message || data?.refineDocumentChunk.errors[0]?.message;
    setMessage(problem || '');
    if (problem) return;
    setNotice('Saved. The passage is being embedded again.');
    setDescribing(null);
    await load();
    loadChunks(0);
  };

  // Through the app, not straight from storage: storage hands HTML back as plain text, which shows the markup.
  const openOriginal = () => {
    window.open(`/api/documents/${id}/file`, '_blank', 'noopener');
  };

  const templateTitle = (code: string | null) => (code ? template?.sections.find((section) => section.code === code)?.title || code : null);
  const selected = sections.find((section) => section.id === sectionId) || null;

  // Sections whose name, or whose template section's name, contains what was typed. A top heading stays when one under it matches.
  const needle = find.trim().toLowerCase();
  const nameMatches = (section: DocumentSectionRow) =>
    section.heading.toLowerCase().includes(needle) || (templateTitle(section.templateSectionCode) || '').toLowerCase().includes(needle);
  const shownSections = !needle ? sections : sections.filter((section) =>
    nameMatches(section) || sections.some((child) => child.parentSeq === section.seq && nameMatches(child)));
  const unmatched = template ? sections.filter((section) => !section.templateSectionCode) : [];
  const differing = template
    ? sections.filter((section) => section.templateSectionCode && !sameHeading(section.heading, templateTitle(section.templateSectionCode) || '')).length
    : 0;
  const tops = template ? template.sections.filter((section) => !section.parentCode) : [];

  const optionsFor = (section: DocumentSectionRow) => {
    if (!template) return [];
    if (section.level === 1 || section.parentSeq === null) return tops;
    const parent = sections.find((other) => other.seq === section.parentSeq);
    const under = template.sections.filter((candidate) => candidate.parentCode && candidate.parentCode === parent?.templateSectionCode);
    return under.length > 0 ? under : template.sections.filter((candidate) => candidate.parentCode);
  };

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/documents" className="crumb-link">Documents</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{document?.title || 'Document'}</span>
      </div>

      {message && <div role="alert" style={{ ...danger, margin: '12px 0' }}>{message}</div>}
      {notice && <div role="status" style={{ color: 'var(--ink-2)', margin: '12px 0' }}>{notice}</div>}
      {loading && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Loading the document…</div>}

      {document && (
        <>
          <div className="page-header">
            <div className="page-title-block">
              <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
              <div>
                <div className="page-title">{document.title}</div>
                <div className="page-meta">
                  {document.typeName}
                  {document.documentDate ? ` · ${shortDate(document.documentDate)}` : ''}
                  {document.pageCount ? ` · ${document.pageCount} pages` : ''}
                  {` · ${document.chunkCount} passages`}
                  {document.templateVersion ? ` · tagged with template v${document.templateVersion}` : ' · no published template for this type yet'}
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start', margin: '8px 0 4px' }}>
            <DocumentStatus document={document} explain />
            <div>
              <div style={{ ...hint, textTransform: 'uppercase', fontSize: 11 }}>Linked records</div>
              {document.entities.length === 0 ? <span style={hint}>None yet. Add them on the Details tab.</span> : document.entities.map((entity) => (
                <div key={`${entity.entityId}:${entity.role}`}><RecordName link={entity} /> <span style={hint}>{entity.role.toLowerCase()}</span></div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: 360 }}>
              {document.tags.map((tag) => <Chip key={tag}>{tag}</Chip>)}
            </div>
            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={openOriginal}>Open the original</button>
              <button type="button" className="btn" disabled={working || document.chunkCount === 0}
                onClick={async () => { if (await run(RETAG_DOCUMENT, 'retagDocument', { id }, 'Sections were tagged again.')) loadChunks(0); }}>
                Tag again
              </button>
              <button type="button" className="btn" disabled={working}
                onClick={() => run(REPROCESS_DOCUMENT, 'reprocessDocument', { id }, 'Queued to be read again from the file.')}>
                Read again
              </button>
            </div>
          </div>

          <Tabs
            label="Document"
            tabs={[
              { id: 'passages', label: 'Sections and passages' },
              { id: 'details', label: dirty ? 'Details (not saved)' : 'Details' },
            ]}
            current={tab}
            onChange={(next) => setTab(next as 'passages' | 'details')}
          />

          {tab === 'details' && draft && (
            <form onSubmit={(event) => { event.preventDefault(); save(); }} style={{ ...formBox, marginTop: 4 }}>
              <div style={formRow}>
                <label style={field}>
                  <span style={fieldLabel}>Title</span>
                  <input className="text-input" value={draft.title} onChange={(event) => edit({ title: event.target.value })} />
                </label>
                <label style={field}>
                  <span style={fieldLabel}>Document type</span>
                  <select className="text-input" value={draft.typeId} onChange={(event) => edit({ typeId: event.target.value })}>
                    {types.filter((type) => type.isActive || type.id === document.typeId).map((type) => <option key={type.id} value={type.id}>{type.typeName}</option>)}
                  </select>
                </label>
                <label style={field}>
                  <span style={fieldLabel}>Document date</span>
                  <input className="text-input" type="date" value={draft.documentDate} onChange={(event) => edit({ documentDate: event.target.value })} />
                </label>
              </div>
              {draft.typeId !== document.typeId && <div style={hint}>A different type has its own template, so the sections are tagged again and choices made by hand are cleared.</div>}
              <label style={field}>
                <span style={fieldLabel}>Tags (separated by commas). Every passage of the document carries them.</span>
                <input className="text-input" value={draft.tags} onChange={(event) => edit({ tags: event.target.value })} />
              </label>
              <EntityLinksEditor links={draft.entities} onChange={(entities) => edit({ entities })} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button type="submit" className="btn btn-primary" disabled={working || !dirty}>{working ? 'Saving…' : 'Save'}</button>
                <button type="button" className="btn" disabled={working || !dirty} onClick={() => setDirty(false)}>Undo changes</button>
                {!dirty && <span style={hint}>Nothing to save.</span>}
              </div>
              <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', margin: '8px 0 0', fontSize: 13 }}>
                <dt style={hint}>File</dt><dd style={{ margin: 0 }}>{document.fileName}</dd>
                <dt style={hint}>Added</dt><dd style={{ margin: 0 }}>{shortDate(document.createdAt)}</dd>
                <dt style={hint}>Read as</dt><dd style={{ margin: 0 }}>{[document.format ? document.format.toUpperCase() : null, document.pageCount ? `${document.pageCount} pages` : null, `${document.chunkCount} passages`].filter(Boolean).join(', ')}</dd>
                <dt style={hint}>Template</dt><dd style={{ margin: 0 }}>{document.templateVersion ? `${document.typeName}, version ${document.templateVersion}` : 'None published for this type yet'}</dd>
                <dt style={hint}>Search by meaning</dt><dd style={{ margin: 0 }}>{document.embeddingModel ? `${document.embeddedCount} of ${document.chunkCount} passages embedded with ${document.embeddingModel}` : 'Not embedded'}</dd>
              </dl>
            </form>
          )}

          {tab === 'passages' && document.chunkCount === 0 && (
            <div style={{ ...hint, margin: '12px 0' }}>This document has no passages yet. They appear once it has been read.</div>
          )}

          {tab === 'passages' && document.chunkCount > 0 && (
            <form onSubmit={(event) => { event.preventDefault(); ask(); }} style={{ display: 'grid', gap: 4, margin: '4px 0 0' }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input className="text-input" style={{ flex: '1 1 360px' }} value={find} aria-label="Search this document"
                  placeholder="Search this document: a section name, or a question about its text"
                  onChange={(event) => setFind(event.target.value)} />
                <button type="submit" className="btn btn-primary" disabled={finding || !find.trim()}>{finding ? 'Reading…' : 'Ask'}</button>
                {(find || answer !== null) && <button type="button" className="btn" onClick={() => { askTicket.current += 1; setFind(''); setAnswer(null); setFinding(false); }}>Clear</button>}
              </div>
              <div style={hint}>
                {find.trim()
                  ? `${shownSections.length} of ${sections.length} section names match as you type. Ask to have the question answered from the text.`
                  : 'Typing narrows the list of sections by name. Ask answers the question, then shows the sections it used.'}
              </div>
            </form>
          )}

          {tab === 'passages' && document.chunkCount > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 380px) minmax(0, 1fr)', gap: 24, marginTop: 8 }}>
              <div>
                <div style={sectionHead}>
                  <h2 style={sectionTitle}>Sections</h2>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {sectionId && <button type="button" className="btn btn-sm" onClick={() => setSectionId(null)}>Show all</button>}
                    {template && (
                      <button type="button" className="btn btn-sm" aria-pressed={mapping} onClick={() => setMapping(!mapping)}>
                        {mapping ? 'Done' : 'Change mapping'}
                      </button>
                    )}
                  </div>
                </div>
                {sections.length === 0 && <div style={hint}>No headings were found in this document. Its passages are still searchable.</div>}
                {template && sections.length > 0 && (
                  <div style={{ ...hint, marginBottom: 8 }}>
                    {unmatched.length === 0
                      ? `All ${sections.length} headings are matched to template version ${template.version}.`
                      : `${sections.length - unmatched.length} of ${sections.length} headings are matched to template version ${template.version}. ${unmatched.length} ${unmatched.length === 1 ? 'is' : 'are'} not, and ${unmatched.length === 1 ? 'is' : 'are'} marked below.`}
                    {differing > 0 && !mapping ? ` ${differing} matched under a different name, shown beneath the heading.` : ''}
                  </div>
                )}
                {find.trim() && shownSections.length === 0 && <div style={hint}>No section name contains &quot;{find.trim()}&quot;.</div>}
                <div style={{ maxHeight: '70vh', overflowY: 'auto', borderTop: '1px solid var(--line, #e5e5e5)' }}>
                  {shownSections.map((section) => {
                    const active = section.id === sectionId;
                    const mappedTitle = templateTitle(section.templateSectionCode);
                    // Worth saying only when the template calls the section something else, or does not have it.
                    const sameName = mappedTitle !== null && sameHeading(section.heading, mappedTitle);
                    return (
                      <div key={section.id} style={{ padding: '6px 6px 6px 0', paddingLeft: section.level > 1 ? 16 : 0, borderBottom: '1px solid var(--line, #e5e5e5)', background: active ? 'var(--surface-2, rgba(0,0,0,0.03))' : undefined }}>
                        <button type="button" onClick={() => { setSectionId(section.id); setAnswer(null); }} aria-current={active} ref={active ? activeSection : undefined}
                          style={{ display: 'flex', justifyContent: 'space-between', gap: 8, width: '100%', textAlign: 'left', background: 'transparent', border: 0, padding: 0, cursor: 'pointer', fontSize: 13, fontWeight: section.level === 1 ? 600 : 400, color: active ? 'var(--accent)' : 'inherit' }}>
                          <span>{section.heading}</span>
                          <span style={{ ...hint, fontWeight: 400, whiteSpace: 'nowrap' }} title={`${section.chunkCount} passages`}>{section.chunkCount || ''}</span>
                        </button>
                        {template && !mapping && mappedTitle === null && (
                          <div style={{ fontSize: 12, color: 'var(--amber, #9a6700)', marginTop: 2 }}>Not in the template</div>
                        )}
                        {template && !mapping && mappedTitle !== null && !sameName && (
                          <div style={{ ...hint, marginTop: 2 }}>
                            Template: {mappedTitle}{section.matchMethod === 'MANUAL' ? ' (chosen by a person)' : ''}
                          </div>
                        )}
                        {template && mapping && (
                          <select className="text-input" style={{ fontSize: 12, padding: '2px 6px', maxWidth: 300, marginTop: 4 }} value={section.templateSectionCode || ''}
                            aria-label={`Template section for ${section.heading}`} disabled={working}
                            onChange={async (event) => {
                              if (await run(ASSIGN_SECTION, 'assignDocumentSection', { sectionId: section.id, code: event.target.value || null }, 'Section saved.')) loadChunks(0);
                            }}>
                            <option value="">Not in the template</option>
                            {optionsFor(section).map((option) => <option key={option.code} value={option.code}>{option.title}</option>)}
                            {section.templateSectionCode && !optionsFor(section).some((option) => option.code === section.templateSectionCode) && (
                              <option value={section.templateSectionCode}>{mappedTitle}</option>
                            )}
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                {answer !== null ? (
                  <>
                    <div style={sectionHead}>
                      <h2 style={sectionTitle}>
                        {answer.summary ? 'Answer' : answer.sections.length === 0 ? 'Nothing in the text answered that' : 'Sections'}
                      </h2>
                      <button type="button" className="btn btn-sm" onClick={() => setAnswer(null)}>Back to the passages</button>
                    </div>
                    <AnswerView query={answer.query} answer={answer} titled={false} onOpen={jumpTo} />
                  </>
                ) : (
                  <>
                <div style={sectionHead}>
                  <h2 style={sectionTitle}>{selected ? selected.heading : 'Every passage'}</h2>
                </div>
                {chunks.map((chunk) => {
                  const isTarget = target !== null && chunk.charStart <= target && target < chunk.charEnd;
                  return (
                    <div key={chunk.id} ref={isTarget ? targetRef : undefined}
                      style={{ padding: '10px 12px', margin: '0 0 8px', border: '1px solid var(--line, #e5e5e5)', borderLeft: isTarget ? '3px solid var(--accent)' : '1px solid var(--line, #e5e5e5)', borderRadius: 6 }}>
                      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.55 }}>{chunk.text}</div>
                      {describing?.id === chunk.id ? (
                        <form onSubmit={(event) => { event.preventDefault(); saveDescription(); }} style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                          <label style={field}>
                            <span style={fieldLabel}>What this passage holds, in a sentence. It helps search find the passage and is never shown as the document&apos;s words.</span>
                            <textarea className="text-input" rows={2} value={describing.summary} onChange={(event) => setDescribing({ ...describing, summary: event.target.value })} />
                          </label>
                          {template && template.topics.length > 0 && (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              <span style={hint}>Topics</span>
                              {template.topics.map((topic) => (
                                <Chip key={topic.code} active={describing.topics.includes(topic.code)} title={topic.description}
                                  onClick={() => setDescribing({ ...describing, topics: describing.topics.includes(topic.code) ? describing.topics.filter((code) => code !== topic.code) : [...describing.topics, topic.code] })}>
                                  {topic.title}
                                </Chip>
                              ))}
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button type="submit" className="btn btn-sm btn-primary" disabled={working}>Save</button>
                            <button type="button" className="btn btn-sm" onClick={() => setDescribing(null)}>Cancel</button>
                          </div>
                        </form>
                      ) : chunk.summary ? (
                        <div style={{ ...hint, marginTop: 8 }}>
                          Described as: {chunk.summary} <span>({chunk.refinedBy === 'MANUAL' ? 'written by a person' : 'written by the model'})</span>
                        </div>
                      ) : chunk.thin ? (
                        <div style={{ ...hint, marginTop: 8 }}>Mostly names and numbers, and not described yet. Search finds it by its own words only.</div>
                      ) : null}
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
                        <span style={hint}>
                          {[chunk.page ? `Page ${chunk.page}` : null, `characters ${chunk.charStart.toLocaleString()} to ${chunk.charEnd.toLocaleString()}`].filter(Boolean).join(' · ')}
                        </span>
                        {chunk.tags.filter((tag) => !tag.startsWith('type:')).map((tag) => <Chip key={tag}>{tagLabel(tag)}</Chip>)}
                        {!chunk.embedded && <Chip title="Found by its words until it has been embedded">Words only</Chip>}
                        {describing?.id !== chunk.id && (
                          <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }}
                            onClick={() => setDescribing({ id: chunk.id, summary: chunk.summary || '', topics: chunk.topics })}>
                            {chunk.summary ? 'Change the description' : 'Describe'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {more && <button type="button" className="btn" onClick={() => loadChunks(chunks.length)}>Show more</button>}
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
