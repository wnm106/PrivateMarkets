'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { AnswerView, askDocuments, type DocumentAnswer } from '@/components/documents/AnswerView';
import {
  Chip, DOCUMENT_FIELDS, DocumentStatus, EntityLinksEditor, RecordName, TYPE_FIELDS, bodyRow, cell, danger, field, fieldLabel, formBox, formRow,
  headRow, hint, sectionHead, sectionTitle, shortDate, table, tagLabel,
  type DocumentRow, type DocumentTypeRow, type EntityLink,
} from '@/components/documents/shared';

const PAGE_QUERY = `
  query Documents {
    documents(first: 200) { ${DOCUMENT_FIELDS} }
    documentTypes { ${TYPE_FIELDS} }
    documentTags { tag chunks }
  }
`;
const SEARCH_QUERY = `
  query Search($query: String!, $tags: [String!], $typeCodes: [String!]) {
    searchDocuments(query: $query, tags: $tags, typeCodes: $typeCodes, first: 12) {
      byMeaning reranked note
      hits {
        chunkId documentId documentTitle typeName sectionHeading parentHeading kind text summary routedBy charStart page clause tags foundBy
        entities { entityName role }
      }
    }
  }
`;
const DELETE_DOCUMENT = `mutation($id: ID!) { deleteDocument(id: $id) { success errors { message } } }`;
const REPROCESS_DOCUMENT = `mutation($id: ID!) { reprocessDocument(id: $id) { document { id } errors { message } } }`;

interface SearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  typeName: string;
  sectionHeading: string | null;
  parentHeading: string | null;
  kind: string;
  text: string;
  summary: string | null;
  routedBy: string | null;
  charStart: number;
  page: number | null;
  clause: string | null;
  tags: string[];
  foundBy: 'MEANING' | 'WORDS' | 'BOTH' | 'TOPIC';
  entities: Array<{ entityName: string; role: string }>;
}

interface SearchResult {
  byMeaning: boolean;
  reranked: boolean;
  note: string | null;
  hits: SearchHit[];
}

interface Draft {
  file: File | null;
  typeId: string;
  title: string;
  documentDate: string;
  tags: string;
  entities: EntityLink[];
}

const FOUND_BY: Record<SearchHit['foundBy'], string> = { MEANING: 'By meaning', WORDS: 'By words', BOTH: 'By meaning and words', TOPIC: 'By topic' };

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [types, setTypes] = useState<DocumentTypeRow[]>([]);
  const [tags, setTags] = useState<Array<{ tag: string; chunks: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');

  const [question, setQuestion] = useState('');
  const [typeCode, setTypeCode] = useState('');
  const [chosenTags, setChosenTags] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [answer, setAnswer] = useState<{ query: string } & DocumentAnswer | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [saving, setSaving] = useState(false);

  usePublishViewContext({ activity: 'viewing', kind: 'documents', label: 'Documents', summary: 'Stored documents and search across their text' });

  const load = useCallback(async () => {
    const response = await graphqlQuery<{ documents: DocumentRow[]; documentTypes: DocumentTypeRow[]; documentTags: Array<{ tag: string; chunks: number }> }, Record<string, never>>(PAGE_QUERY, {}, 'network-only');
    if (response.aborted) return;
    if (response.error) {
      setMessage(response.error.message);
    } else if (response.data) {
      setDocuments(response.data.documents);
      setTypes(response.data.documentTypes);
      setTags(response.data.documentTags);
      setMessage('');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // While a document is being read, keep its progress current.
  const busy = documents.some((document) => document.status === 'RECEIVED' || document.status === 'PROCESSING');
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [busy, load]);

  const search = async () => {
    const asked = question.trim();
    if (!asked && chosenTags.length === 0) return;
    setSearching(true);
    if (asked) {
      const response = await askDocuments({
        query: asked,
        tags: chosenTags.length > 0 ? chosenTags : undefined,
        typeCodes: typeCode ? [typeCode] : undefined,
      });
      setSearching(false);
      if (response.error) {
        setMessage(response.error);
        return;
      }
      setMessage('');
      setResult(null);
      setAnswer(response.answer ? { query: asked, ...response.answer } : null);
      return;
    }
    const response = await graphqlQuery<{ searchDocuments: SearchResult }, { query: string; tags: string[] | null; typeCodes: string[] | null }>(
      SEARCH_QUERY,
      { query: '', tags: chosenTags.length > 0 ? chosenTags : null, typeCodes: typeCode ? [typeCode] : null },
      'network-only',
    );
    setSearching(false);
    if (response.aborted) return;
    if (response.error) {
      setMessage(response.error.message);
      return;
    }
    setMessage('');
    setAnswer(null);
    setResult(response.data?.searchDocuments || null);
  };

  const startDraft = () => {
    setDraftError('');
    setDraft({ file: null, typeId: types.find((type) => type.isActive)?.id || '', title: '', documentDate: '', tags: '', entities: [] });
  };

  // Arriving from a record's Documents tab (/documents?link=<record id>): open the form with that record already linked.
  const [linkRequest, setLinkRequest] = useState<string | null>(null);
  useEffect(() => {
    setLinkRequest(new URLSearchParams(window.location.search).get('link'));
  }, []);
  useEffect(() => {
    if (!linkRequest || types.length === 0) return;
    let cancelled = false;
    graphqlQuery<{ entity: { id: string; entityName: string; entityCode: string; domainCode: string; domainName: string } | null }, { id: string }>(
      `query($id: ID) { entity(id: $id) { id entityName entityCode domainCode domainName } }`, { id: linkRequest }, 'network-only',
    ).then(({ data }) => {
      if (cancelled) return;
      const record = data?.entity;
      setLinkRequest(null);
      setDraftError(record ? '' : 'The record to link was not found. You can still add the document and link a record below.');
      setDraft({
        file: null, typeId: types.find((type) => type.isActive)?.id || '', title: '', documentDate: '', tags: '',
        entities: record ? [{ entityId: record.id, entityName: record.entityName, entityCode: record.entityCode, domainCode: record.domainCode, typeName: record.domainName, role: 'SUBJECT' }] : [],
      });
    });
    return () => {
      cancelled = true;
    };
  }, [linkRequest, types]);

  const upload = async () => {
    if (!draft) return;
    if (!draft.file) return setDraftError('Choose a file to add.');
    if (!draft.typeId) return setDraftError('Choose a document type.');
    setSaving(true);
    setDraftError('');
    const form = new FormData();
    form.set('file', draft.file);
    form.set('typeId', draft.typeId);
    form.set('title', draft.title);
    form.set('documentDate', draft.documentDate);
    form.set('tags', draft.tags);
    form.set('entities', JSON.stringify(draft.entities.map((link) => ({ entityId: link.entityId, role: link.role }))));
    try {
      const response = await fetch('/api/documents', { method: 'POST', body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDraftError(body.error || 'The document could not be added.');
      } else {
        setNotice(body.duplicate ? `That file is already here as "${body.title}".` : `"${body.title}" was added and is waiting to be read.`);
        setDraft(null);
        load();
      }
    } catch {
      setDraftError('The document could not be sent. Check the connection and try again.');
    }
    setSaving(false);
  };

  const act = async (mutation: string, name: string, id: string, done: string) => {
    const { data, error } = await graphqlMutation<Record<string, { errors: Array<{ message: string }> }>>(mutation, { id });
    const problem = error?.message || data?.[name]?.errors[0]?.message;
    setMessage(problem || '');
    setNotice(problem ? '' : done);
    load();
  };

  const remove = (document: DocumentRow) => {
    if (!window.confirm(`Delete "${document.title}"? Its file, sections and passages are deleted. This cannot be undone.`)) return;
    act(DELETE_DOCUMENT, 'deleteDocument', document.id, `"${document.title}" was deleted.`);
  };

  // The tags worth offering as filters: what a passage is, and the template sections.
  // Topics first, since they say what a passage is about wherever it sits. Then tags people added, the kinds of passage, and the largest sections.
  const withPrefix = (prefix: string) => tags.filter((row) => row.tag.startsWith(prefix));
  const filterTags = [
    ...withPrefix('topic:'),
    ...tags.filter((row) => !row.tag.includes(':')),
    ...withPrefix('kind:'),
    ...withPrefix('section:').slice(0, 10),
  ];

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Documents</span>
      </div>
      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
          <div>
            <div className="page-title">Documents</div>
            <div className="page-meta">
              Agreements and other documents, kept as tagged sections you can search by meaning. A question is answered in a short summary, then the sections it rests on.
            </div>
          </div>
        </div>
      </div>

      {message && <div role="alert" style={{ ...danger, margin: '12px 0' }}>{message}</div>}
      {notice && <div role="status" style={{ color: 'var(--ink-2)', margin: '12px 0' }}>{notice}</div>}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          search();
        }}
        style={{ display: 'grid', gap: 10, margin: '16px 0 8px', maxWidth: 980 }}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="text-input" style={{ flex: '1 1 380px' }} value={question} aria-label="Search documents"
            placeholder="Ask about the documents: what are the financial covenants?"
            onChange={(event) => setQuestion(event.target.value)} />
          <select className="text-input" style={{ width: 220 }} value={typeCode} aria-label="Document type" onChange={(event) => setTypeCode(event.target.value)}>
            <option value="">Every document type</option>
            {types.map((type) => <option key={type.id} value={type.typeCode}>{type.typeName}</option>)}
          </select>
          <button type="submit" className="btn btn-primary" disabled={searching}>{searching ? (question.trim() ? 'Reading…' : 'Searching…') : (question.trim() ? 'Ask' : 'Search')}</button>
        </div>
        {filterTags.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={hint}>Only passages tagged</span>
            {filterTags.map((row) => (
              <Chip key={row.tag} active={chosenTags.includes(row.tag)} title={`${tagLabel(row.tag)}: ${row.chunks} passages`}
                onClick={() => setChosenTags(chosenTags.includes(row.tag) ? chosenTags.filter((tag) => tag !== row.tag) : [...chosenTags, row.tag])}>
                {tagLabel(row.tag)}
              </Chip>
            ))}
          </div>
        )}
      </form>

      {answer && (
        <div style={{ maxWidth: 980, marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '8px 0' }}>
            <button type="button" className="btn btn-sm" onClick={() => setAnswer(null)}>Clear</button>
          </div>
          <AnswerView query={answer.query} answer={answer} showTitle href={(documentId, charStart) => `/documents/${documentId}?at=${charStart}`} />
        </div>
      )}

      {result && (
        <div style={{ maxWidth: 980, marginBottom: 24 }}>
          <div style={{ ...hint, margin: '8px 0' }}>
            {result.hits.length === 0 ? 'Nothing matched.' : `${result.hits.length} passages.`}{' '}
            {result.byMeaning ? `Searched by meaning and by words${result.reranked ? ', then ranked by how well each answers the question' : ''}.` : ''} {result.note}{' '}
            <button type="button" className="btn btn-sm" onClick={() => setResult(null)}>Clear</button>
          </div>
          {result.hits.map((hit) => (
            <div key={hit.chunkId} style={{ borderTop: '1px solid var(--line, #e5e5e5)', padding: '12px 0' }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <Link href={`/documents/${hit.documentId}?at=${hit.charStart}`} className="crumb-link" style={{ fontWeight: 600 }}>
                  {[hit.sectionHeading || hit.parentHeading || hit.documentTitle, hit.clause].filter(Boolean).join(' ')}
                </Link>
                <span style={hint}>
                  {hit.documentTitle}{hit.page ? `, page ${hit.page}` : ''}
                  {hit.entities.length > 0 ? ` · ${hit.entities.map((entity) => entity.entityName).join(', ')}` : ''}
                </span>
              </div>
              <blockquote style={{ margin: '6px 0', padding: '0 0 0 12px', borderLeft: '3px solid var(--line, #e5e5e5)', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5 }}>
                {hit.text.length > 900 ? `${hit.text.slice(0, 900)}…` : hit.text}
              </blockquote>
              {hit.summary && <div style={{ ...hint, margin: '0 0 6px' }}>Described as: {hit.summary}</div>}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Chip>{FOUND_BY[hit.foundBy]}</Chip>
                {hit.routedBy && <Chip title="The question was closest to this part of the template, so its passages were brought forward">About: {tagLabel(hit.routedBy)}</Chip>}
                {hit.tags.filter((tag) => !tag.startsWith('type:') && !tag.startsWith('term:')).map((tag) => <Chip key={tag}>{tagLabel(tag)}</Chip>)}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={sectionHead}>
        <h2 style={sectionTitle}>Stored documents</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href="/admin/document-templates" className="btn">Types and templates</Link>
          <button type="button" className="btn btn-primary" onClick={startDraft}>Add a document</button>
        </div>
      </div>

      {draft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            upload();
          }}
          style={formBox}
        >
          <div style={{ fontWeight: 600 }}>Add a document</div>
          <label style={field}>
            <span style={fieldLabel}>File</span>
            <input type="file" accept=".pdf,.html,.htm,.txt,.md,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.docx,.doc" onChange={(event) => setDraft({ ...draft, file: event.target.files?.[0] || null })} />
            <span style={hint}>A PDF, an HTML file or a text file, up to 50 MB. A scan, a picture of a page or a Word file is read by the outside reader when one is set up.</span>
          </label>
          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Document type</span>
              <select className="text-input" value={draft.typeId} onChange={(event) => setDraft({ ...draft, typeId: event.target.value })}>
                {types.filter((type) => type.isActive).map((type) => <option key={type.id} value={type.id}>{type.typeName}</option>)}
              </select>
            </label>
            <label style={field}>
              <span style={fieldLabel}>Title (optional)</span>
              <input className="text-input" value={draft.title} placeholder="Taken from the document when left blank"
                onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <label style={field}>
              <span style={fieldLabel}>Document date (optional)</span>
              <input className="text-input" type="date" value={draft.documentDate} onChange={(event) => setDraft({ ...draft, documentDate: event.target.value })} />
            </label>
          </div>
          <label style={field}>
            <span style={fieldLabel}>Tags (optional, separated by commas)</span>
            <input className="text-input" value={draft.tags} placeholder="revolver, 2022 vintage" onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
          </label>
          <EntityLinksEditor links={draft.entities} saveLabel="Add document" onChange={(entities) => setDraft({ ...draft, entities })} />
          {draftError && <div role="alert" style={danger}>{draftError}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Adding…' : 'Add document'}</button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </form>
      )}

      {loading && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Loading documents…</div>}
      {!loading && documents.length === 0 && !draft && (
        <div style={{ ...hint, margin: '12px 0' }}>No documents yet. Add one to search its text and tag its sections.</div>
      )}

      {documents.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell}>Document</th>
                <th style={cell}>Type</th>
                <th style={cell}>About</th>
                <th style={cell}>Status</th>
                <th style={cell}>Added</th>
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => (
                <tr key={document.id} style={bodyRow}>
                  <td style={{ ...cell, fontWeight: 500 }}>
                    <Link href={`/documents/${document.id}`} className="crumb-link">{document.title}</Link>
                    <div style={hint}>
                      {document.fileName}
                      {document.pageCount ? ` · ${document.pageCount} pages` : ''}
                      {document.chunkCount ? ` · ${document.chunkCount} passages` : ''}
                    </div>
                  </td>
                  <td style={cell}>
                    {document.typeName}
                    <div style={hint}>{document.templateVersion ? `Template v${document.templateVersion}` : 'No template yet'}</div>
                  </td>
                  <td style={cell}>
                    {document.entities.length === 0 ? <span style={hint}>Not linked</span> : document.entities.map((entity) => (
                      <div key={`${entity.entityId}:${entity.role}`}><RecordName link={entity} /> <span style={hint}>{entity.role.toLowerCase()}</span></div>
                    ))}
                  </td>
                  <td style={cell}><DocumentStatus document={document} /></td>
                  <td style={cell}>{shortDate(document.createdAt)}</td>
                  <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button type="button" className="btn btn-sm" onClick={() => act(REPROCESS_DOCUMENT, 'reprocessDocument', document.id, `"${document.title}" is queued to be read again.`)}>
                      Read again
                    </button>{' '}
                    <button type="button" className="btn btn-sm" onClick={() => remove(document)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
