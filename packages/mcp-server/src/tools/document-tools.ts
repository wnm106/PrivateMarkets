import { embedConfigFromEnv, searchDocuments } from '@tapestrai/graphql/src/lib/document-content';
import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

/**
 * The words of stored documents: agreements, side letters, memoranda. Load data
 * keeps a file's values; these tools read its clauses. Every result carries the
 * document's exact words and where they sit, so an answer can quote and cite.
 */

type Row = Record<string, any>;

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

/** "Credit Agreement, 7.1 Financial Condition Covenants (a), page 91" */
function citation(title: string, heading: string | null, clause: string | null, page: number | null): string {
  return [title, [heading, clause].filter(Boolean).join(' '), page ? `page ${page}` : null].filter(Boolean).join(', ');
}

/**
 * Where a passage sits in the app: the document page opens at that passage.
 * The chat writes a citation as [citation](href) so the reader can check it.
 */
export function passageHref(documentId: string, charStart?: number | null): string {
  return charStart == null || !Number.isFinite(Number(charStart))
    ? `/documents/${documentId}`
    : `/documents/${documentId}?at=${Number(charStart)}`;
}

const CITE_AS_LINK = ' Write each citation as a markdown link to its href, [citation](href), so the reader can open the passage. Never make up an href.';

const searchDocumentsTool: ToolDefinition = {
  name: 'search_documents',
  description:
    'Find passages in stored documents (credit agreements, fund agreements, side letters) by meaning and by words. Ask in plain language: "financial covenants", "how is Applicable Margin defined", "what triggers an event of default". Each result has quote, the exact words of the document, and citation, where they sit. Quote the words and give the citation in the answer; do not restate a clause from memory.' + CITE_AS_LINK + ' A table or list may also have description, a sentence written to say what it holds: use it to understand the passage, never quote it as the document. Narrow with entityIds (documents about a record), typeCodes, documentIds, or tags from list_documents (for example "kind:definition" for defined terms, "section:NEGATIVE_COVENANTS" for one template section). All tags given must be on a passage.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for, in plain language' },
      entityIds: { type: 'array', items: { type: 'string' }, description: 'Only documents linked to these records' },
      typeCodes: { type: 'array', items: { type: 'string' }, description: 'Only these document types, such as CREDIT_AGREEMENT' },
      documentIds: { type: 'array', items: { type: 'string' }, description: 'Only these documents' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags a passage must carry, such as kind:definition' },
      limit: { type: 'number', description: 'How many passages to return (default 6, at most 15)' },
    },
    required: ['query'],
  },
  execute: async (args, supabase) => {
    const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 15);
    const { hits, byMeaning, reranked, note } = await searchDocuments(
      supabase,
      String(args.query || ''),
      { tags: list(args.tags), entityIds: list(args.entityIds), typeCodes: list(args.typeCodes), documentIds: list(args.documentIds), limit },
      embedConfigFromEnv(),
    );
    return {
      searchedBy: byMeaning ? 'meaning and words' : 'words only',
      order: reranked ? 'best answer to the question first' : 'best match first',
      note,
      count: hits.length,
      passages: hits.map((hit) => ({
        quote: hit.text,
        citation: citation(hit.documentTitle, hit.sectionHeading || hit.parentHeading, hit.clause, hit.page),
        href: passageHref(hit.documentId, hit.charStart),
        ...(hit.summary ? { description: hit.summary } : {}),
        documentId: hit.documentId,
        documentTitle: hit.documentTitle,
        documentType: hit.typeCode,
        documentDate: hit.documentDate,
        section: hit.sectionHeading,
        within: hit.parentHeading,
        sectionId: hit.sectionId,
        kind: hit.kind,
        page: hit.page,
        tags: hit.tags.filter((tag) => !tag.startsWith('type:')),
        about: hit.entities.map((entity) => `${entity.entityName} (${entity.role})`),
        foundBy: hit.foundBy,
      })),
    };
  },
};

const listDocumentsTool: ToolDefinition = {
  name: 'list_documents',
  description:
    'The stored documents the user can read: title, type, date, the records each is about, and whether it has been read. Pass entityId for the documents about one record. Pass documentId for one document with its headings (number, heading, sectionId), which get_document_section reads in full. Also returns the tags that search_documents can filter on.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      entityId: { type: 'string', description: 'Only documents linked to this record' },
      documentId: { type: 'string', description: 'One document, with its headings' },
    },
  },
  execute: async (args, supabase) => {
    if (args.documentId) {
      const { data, error } = await supabase.rpc('document_get', { p_id: args.documentId });
      if (error) throw error;
      if (!data) throw new Error(`Document not found: ${args.documentId}`);
      const document = data as Row;
      return {
        documentId: document.id,
        title: document.title,
        href: passageHref(String(document.id)),
        type: document.type_code,
        date: document.document_date,
        status: document.status,
        pages: document.page_count,
        about: (document.entities || []).map((entity: Row) => ({ entityId: entity.entity_id, name: entity.entity_name, role: entity.role })),
        headings: (document.sections || []).map((section: Row) => ({
          sectionId: section.id,
          level: section.level,
          heading: section.heading,
          templateSection: section.template_section_code,
          passages: section.chunk_count,
        })),
      };
    }
    const [documents, tags] = await Promise.all([
      supabase.rpc('documents_list', { p_entity_id: args.entityId || null, p_limit: 100 }),
      supabase.rpc('document_tags_list'),
    ]);
    if (documents.error) throw documents.error;
    return {
      documents: ((documents.data as Row[] | null) || []).map((document) => ({
        documentId: document.id,
        title: document.title,
        href: passageHref(String(document.id)),
        type: document.type_code,
        date: document.document_date,
        status: document.status,
        passages: document.chunk_count,
        about: (document.entities || []).map((entity: Row) => ({ entityId: entity.entity_id, name: entity.entity_name, role: entity.role })),
      })),
      tags: ((tags.data as Row[] | null) || []).slice(0, 80).map((row) => row.tag),
    };
  },
};

const getDocumentSectionTool: ToolDefinition = {
  name: 'get_document_section',
  description:
    'The full text of one heading of a document, in order, as passages with their exact words. Use after search_documents or list_documents when a whole section is needed, such as every negative covenant. sectionId comes from those tools. A top heading returns everything under it. Long sections come in pages: pass offset to read on.' + CITE_AS_LINK,
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      documentId: { type: 'string', description: 'The document' },
      sectionId: { type: 'string', description: 'The heading to read' },
      offset: { type: 'number', description: 'Passages to skip (default 0)' },
    },
    required: ['documentId', 'sectionId'],
  },
  execute: async (args, supabase) => {
    const offset = Math.max(Number(args.offset) || 0, 0);
    const pageSize = 12;
    const [document, chunks] = await Promise.all([
      supabase.rpc('document_get', { p_id: args.documentId }),
      supabase.rpc('document_chunks_list', { p_document_id: args.documentId, p_section_id: args.sectionId, p_limit: pageSize + 1, p_offset: offset }),
    ]);
    if (document.error) throw document.error;
    if (chunks.error) throw chunks.error;
    if (!document.data) throw new Error(`Document not found: ${args.documentId}`);
    const section = ((document.data as Row).sections || []).find((row: Row) => row.id === args.sectionId);
    if (!section) throw new Error(`That heading is not in this document: ${args.sectionId}`);
    const rows = (chunks.data as Row[] | null) || [];
    const title = String((document.data as Row).title);
    return {
      documentTitle: title,
      heading: section.heading,
      passages: rows.slice(0, pageSize).map((row) => ({
        quote: row.text,
        citation: citation(title, (row.locator?.path || []).slice(-1)[0] || section.heading, row.locator?.clause || null, row.locator?.page ?? null),
        href: passageHref(String(args.documentId), row.char_start ?? null),
        ...(row.summary ? { description: row.summary } : {}),
        kind: row.kind,
      })),
      more: rows.length > pageSize ? `There is more. Call again with offset ${offset + pageSize}.` : null,
    };
  },
};

export function registerDocumentTools(registry: ToolRegistry): void {
  registry.registerTool(searchDocumentsTool);
  registry.registerTool(listDocumentsTool);
  registry.registerTool(getDocumentSectionTool);
}
