'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { AnswerView, askDocuments, type DocumentAnswer } from './AnswerView';
import {
  DOCUMENT_FIELDS, DocumentStatus, bodyRow, cell, danger, headRow, hint, shortDate, table, type DocumentRow,
} from './shared';

/**
 * The documents linked to one record, shown as a tab on the record's page:
 * what they are, what the record is to each, and a question across just these
 * documents. Adding one here opens the Add a document form with this record
 * already linked.
 */

const DOCUMENTS_QUERY = `query($entityId: ID) { documents(entityId: $entityId, first: 100) { ${DOCUMENT_FIELDS} } }`;
function roleText(role: string): string {
  const words = role.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function RecordDocuments({ entityId, entityName }: { entityId: string; entityName: string }) {
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [message, setMessage] = useState('');
  const [question, setQuestion] = useState('');
  const [searching, setSearching] = useState(false);
  const [answer, setAnswer] = useState<{ query: string } & DocumentAnswer | null>(null);

  const load = useCallback(async () => {
    const response = await graphqlQuery<{ documents: DocumentRow[] }, { entityId: string }>(DOCUMENTS_QUERY, { entityId }, 'network-only');
    if (response.aborted) return;
    if (response.error) setMessage(response.error.message);
    else setDocuments(response.data?.documents || []);
  }, [entityId]);

  useEffect(() => {
    setDocuments(null);
    setAnswer(null);
    load();
  }, [load]);

  const search = async () => {
    const asked = question.trim();
    if (!asked) return;
    setSearching(true);
    const response = await askDocuments({ query: asked, entityIds: [entityId] });
    setSearching(false);
    if (response.error) {
      setMessage(response.error);
      return;
    }
    setMessage('');
    setAnswer(response.answer ? { query: asked, ...response.answer } : null);
  };

  const addHref = `/documents?link=${encodeURIComponent(entityId)}`;

  return (
    <div className="field-section" style={{ padding: '16px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Documents</div>
          <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>Agreements and other documents linked to {entityName}.</div>
        </div>
        <Link href={addHref} className="btn btn-primary">Add a document</Link>
      </div>

      {message && <div role="alert" style={{ ...danger, margin: '8px 0' }}>{message}</div>}
      {documents === null && !message && <div style={hint} aria-busy="true">Loading…</div>}

      {documents !== null && documents.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
          No document is linked to this record yet. Add one here, or open a document you have already loaded and link this record on its Details tab.
        </div>
      )}

      {documents !== null && documents.length > 0 && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr style={headRow}>
                  <th style={cell}>Document</th>
                  <th style={cell}>Type</th>
                  <th style={cell}>This record is the</th>
                  <th style={cell}>Document date</th>
                  <th style={cell}>Status</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id} style={bodyRow}>
                    <td style={{ ...cell, fontWeight: 500 }}>
                      <Link href={`/documents/${document.id}`} className="crumb-link">{document.title}</Link>
                      <div style={hint}>
                        {[document.pageCount ? `${document.pageCount} pages` : null, document.chunkCount ? `${document.chunkCount} passages` : null].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td style={cell}>{document.typeName}</td>
                    <td style={cell}>{document.entities.filter((link) => link.entityId === entityId).map((link) => roleText(link.role)).join(', ')}</td>
                    <td style={cell}>{document.documentDate ? shortDate(document.documentDate) : <span style={hint}>Not set</span>}</td>
                    <td style={cell}><DocumentStatus document={document} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form onSubmit={(event) => { event.preventDefault(); search(); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
            <input className="text-input" style={{ flex: '1 1 320px' }} value={question} aria-label={`Search the documents linked to ${entityName}`}
              placeholder={`Ask about ${documents.length === 1 ? 'this document' : 'these documents'}: what is the management fee?`}
              onChange={(event) => setQuestion(event.target.value)} />
            <button type="submit" className="btn" disabled={searching}>{searching ? 'Reading…' : 'Ask'}</button>
          </form>

          {answer !== null && (
            <div style={{ marginTop: 12 }}>
              <AnswerView query={answer.query} answer={answer} showTitle href={(documentId, charStart) => `/documents/${documentId}?at=${charStart}`} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
