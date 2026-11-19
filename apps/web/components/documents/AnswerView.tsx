'use client';

import Link from 'next/link';
import { hint } from './shared';

/**
 * A question's answer: the summary, then the sections it rests on.
 * The section text is the document's own words.
 */

export interface AnswerPassage {
  chunkId: string;
  text: string;
  charStart: number;
  page: number | null;
  clause: string | null;
  summary: string | null;
}

export interface AnswerSection {
  documentId: string;
  documentTitle: string;
  sectionId: string | null;
  heading: string;
  parentHeading: string | null;
  passages: AnswerPassage[];
  more: boolean;
}

export interface DocumentAnswer {
  summary: string | null;
  note: string | null;
  sections: AnswerSection[];
}

export async function askDocuments(input: {
  query: string;
  documentIds?: string[];
  entityIds?: string[];
  typeCodes?: string[];
  tags?: string[];
}): Promise<{ answer?: DocumentAnswer; error?: string }> {
  try {
    const response = await fetch('/api/documents/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { error: typeof body.error === 'string' ? body.error : 'The question could not be answered.' };
    return { answer: body as DocumentAnswer };
  } catch {
    return { error: 'The question could not be sent. Check the connection and try again.' };
  }
}

function place(section: AnswerSection): string {
  return section.parentHeading ? `${section.parentHeading} › ${section.heading}` : section.heading;
}

export function AnswerView({
  query,
  answer,
  showTitle = false,
  titled = true,
  onOpen,
  href,
}: {
  query: string;
  answer: DocumentAnswer;
  /** Show which document a section comes from. Used when the question covers more than one. */
  showTitle?: boolean;
  /** False when the surrounding page already titles the answer. */
  titled?: boolean;
  onOpen?: (charStart: number) => void;
  href?: (documentId: string, charStart: number) => string;
}) {
  const open = (section: AnswerSection) => {
    const start = section.passages[0]?.charStart;
    if (start === undefined) return null;
    if (onOpen) return <button type="button" className="btn btn-sm" onClick={() => onOpen(start)}>Show in the document</button>;
    if (href) return <Link href={href(section.documentId, start)} className="btn btn-sm">Show in the document</Link>;
    return null;
  };

  return (
    <div>
      {answer.summary ? (
        <>
          {titled && <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 4px' }}>Answer</h2>}
          <div style={{ ...hint, marginBottom: 8 }}>&ldquo;{query}&rdquo;</div>
          <p style={{ margin: '0 0 8px', fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{answer.summary}</p>
        </>
      ) : titled ? (
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 8px' }}>
          {answer.sections.length === 0 ? 'Nothing in the text answered that' : 'Sections'}
        </h2>
      ) : null}
      {answer.note && <div style={{ ...hint, marginBottom: 12 }}>{answer.note}</div>}
      {answer.summary && answer.sections.length > 0 && (
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: '16px 0 8px' }}>Sections</h2>
      )}
      {answer.sections.map((section) => (
        <article key={`${section.documentId}:${section.sectionId || 'front'}`} style={{ border: '1px solid var(--line, #e5e5e5)', borderRadius: 6, padding: '10px 12px', marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{place(section)}</div>
              {(showTitle || section.passages[0]?.page) && (
                <div style={hint}>
                  {[showTitle ? section.documentTitle : null, section.passages[0]?.page ? `page ${section.passages[0].page}` : null].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
            {open(section)}
          </div>
          {section.passages.map((passage) => (
            <div key={passage.chunkId} style={{ marginTop: 8 }}>
              {(passage.clause || (passage.page && passage.page !== section.passages[0]?.page)) && (
                <div style={hint}>{[passage.clause, passage.page ? `page ${passage.page}` : null].filter(Boolean).join(' · ')}</div>
              )}
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5 }}>{passage.text}</div>
              {passage.summary && <div style={{ ...hint, marginTop: 4 }}>Described as: {passage.summary}</div>}
            </div>
          ))}
          {section.more && <div style={{ ...hint, marginTop: 8 }}>This section continues after these passages.</div>}
        </article>
      ))}
    </div>
  );
}
