import type { Context } from '../context';
import {
  DOCUMENT_BUCKET,
  cleanTemplateSections,
  cleanTopics,
  defaultTopics,
  embedConfigFromEnv,
  ensureTemplateRoutes,
  extendTemplate,
  generateTemplate,
  searchDocuments,
  tagDocument,
  type DocumentOutline,
  type EmbedConfig,
  type TemplateSection,
} from '../lib/document-content';
import { callerClientId } from './jobs';

/**
 * Document content: types, templates, documents, their headings and chunks, and
 * search. Everything goes through the document_* database functions, which
 * check the caller's client and document.manage. A file is added through the
 * web app's /api/documents route, because GraphQL here takes no uploads; the
 * worker in packages/worker reads it.
 */

type Row = Record<string, any>;
type FieldError = { field: string | null; message: string; code: string };

function fail(message: string, field: string | null = null, code = 'VALIDATION'): FieldError {
  return { field, message, code };
}

function failure(error: unknown, code: string): FieldError {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  if (/duplicate key/i.test(raw)) return fail('That code is already in use.', 'code', 'DUPLICATE');
  return fail(raw || 'The request failed.', null, code);
}

function embedConfig(): EmbedConfig | null {
  return typeof process !== 'undefined' && process.env ? embedConfigFromEnv(process.env) : null;
}

async function rows(context: Context, fn: string, args: Record<string, unknown> = {}): Promise<Row[]> {
  const { data, error } = await context.supabase.rpc(fn, args);
  if (error) throw error;
  return (data as Row[] | null) || [];
}

async function one(context: Context, fn: string, args: Record<string, unknown>): Promise<Row | null> {
  const { data, error } = await context.supabase.rpc(fn, args);
  if (error) throw error;
  return (data as Row | null) || null;
}

function mapType(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id || null,
    typeCode: row.type_code,
    typeName: row.type_name,
    description: row.description || null,
    isActive: row.is_active !== false,
    documentCount: Number(row.document_count) || 0,
    publishedTemplateId: row.published_template?.id || null,
    publishedTemplateVersion: row.published_template?.version ?? null,
  };
}

function mapTemplate(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id || null,
    typeId: row.type_id,
    typeCode: row.type_code || null,
    typeName: row.type_name || null,
    version: row.version,
    status: row.status,
    sections: cleanTemplateSections(row.sections),
    topics: cleanTopics(row.topics),
    sourceDocumentIds: Array.isArray(row.source_document_ids) ? row.source_document_ids : [],
    notes: row.notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at || null,
  };
}

function mapSection(row: Row) {
  return {
    id: row.id,
    seq: row.seq,
    parentSeq: row.parent_seq ?? null,
    level: row.level,
    number: row.number || null,
    heading: row.heading,
    charStart: row.char_start,
    charEnd: row.char_end,
    templateSectionCode: row.template_section_code || null,
    matchMethod: row.match_method || null,
    matchScore: row.match_score === null || row.match_score === undefined ? null : Number(row.match_score),
    chunkCount: Number(row.chunk_count) || 0,
  };
}

export function mapDocument(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id,
    typeId: row.type_id,
    typeCode: row.type_code,
    typeName: row.type_name,
    templateId: row.template_id || null,
    templateVersion: row.template_version ?? null,
    title: row.title,
    fileName: row.file_name,
    mediaType: row.media_type || null,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    status: row.status,
    stage: row.stage || null,
    message: row.message || null,
    documentDate: row.document_date || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    format: row.format || null,
    pageCount: row.page_count ?? null,
    charCount: Number(row.char_count) || 0,
    chunkCount: Number(row.chunk_count) || 0,
    embeddedCount: Number(row.embedded_count) || 0,
    embeddingModel: row.embedding_model || null,
    createdAt: row.created_at,
    processedAt: row.processed_at || null,
    entities: (Array.isArray(row.entities) ? row.entities : []).map((entity: Row) => ({
      entityId: entity.entity_id,
      entityName: entity.entity_name,
      entityCode: entity.entity_code,
      domainCode: entity.domain_code,
      role: entity.role,
    })),
    sections: (Array.isArray(row.sections) ? row.sections : []).map(mapSection),
  };
}

function mapChunk(row: Row) {
  const locator = row.locator && typeof row.locator === 'object' ? row.locator : {};
  return {
    id: row.id,
    documentId: row.document_id,
    sectionId: row.section_id || null,
    seq: row.seq,
    kind: row.kind,
    text: row.text,
    charStart: row.char_start,
    charEnd: row.char_end,
    page: typeof locator.page === 'number' ? locator.page : null,
    clause: typeof locator.clause === 'string' ? locator.clause : null,
    locator,
    tags: Array.isArray(row.tags) ? row.tags : [],
    embedded: row.embedded === true,
    thin: row.thin === true,
    summary: row.summary || null,
    topics: Array.isArray(row.topics) ? row.topics : [],
    refinedBy: row.refined_by || null,
  };
}

function entityLinks(value: unknown): Array<{ entityId: string; role: string }> | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((link) => ({ entityId: String((link as Row)?.entityId || ''), role: String((link as Row)?.role || 'SUBJECT') }))
    .filter((link) => link.entityId);
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : null;
}

async function outlinesOf(context: Context, documentIds: string[]): Promise<{ outlines: DocumentOutline[]; typeIds: Set<string> }> {
  const outlines: DocumentOutline[] = [];
  const typeIds = new Set<string>();
  for (const documentId of documentIds) {
    const document = await one(context, 'document_get', { p_id: documentId });
    if (!document) throw new Error('One of the documents was not found.');
    typeIds.add(String(document.type_id));
    const sections = (document.sections as Row[] | undefined) || [];
    if (sections.length === 0) throw new Error(`"${document.title}" has no headings to draw sections from. It may still be being read.`);
    outlines.push({
      documentId,
      sections: sections.map((section) => ({
        seq: Number(section.seq),
        parentSeq: section.parent_seq ?? null,
        level: Number(section.level),
        heading: String(section.heading),
      })),
    });
  }
  return { outlines, typeIds };
}

/** Tags every document of a type again. Returns how many were tagged and how many could not be. */
async function retagType(context: Context, typeId: string): Promise<{ tagged: number; failed: number }> {
  const documents = await rows(context, 'documents_list', { p_type_id: typeId, p_limit: 500 });
  const embed = embedConfig();
  let tagged = 0;
  let failed = 0;
  for (const document of documents) {
    if (Number(document.chunk_count) === 0) continue;
    try {
      await tagDocument(context.supabase, document.id, embed, { budgetMs: 15000 });
      tagged += 1;
      // The template's topics may be new or changed, so its tables and lists are filed again by the worker.
      await context.supabase.rpc('document_refile', { p_id: document.id });
    } catch {
      failed += 1;
    }
  }
  return { tagged, failed };
}

export const documentResolvers = {
  Query: {
    documentTypes: async (_: unknown, __: unknown, context: Context) => (await rows(context, 'document_types_list')).map(mapType),

    documentTemplates: async (_: unknown, args: { typeId?: string | null }, context: Context) =>
      (await rows(context, 'document_templates_list', { p_type_id: args.typeId || null })).map(mapTemplate),

    documents: async (_: unknown, args: { typeId?: string | null; entityId?: string | null; first?: number | null }, context: Context) =>
      (await rows(context, 'documents_list', { p_type_id: args.typeId || null, p_entity_id: args.entityId || null, p_limit: args.first ?? 100 })).map(mapDocument),

    document: async (_: unknown, args: { id: string }, context: Context) => {
      const row = await one(context, 'document_get', { p_id: args.id });
      return row ? mapDocument(row) : null;
    },

    documentChunks: async (_: unknown, args: { documentId: string; sectionId?: string | null; first?: number | null; offset?: number | null }, context: Context) =>
      (await rows(context, 'document_chunks_list', {
        p_document_id: args.documentId,
        p_section_id: args.sectionId || null,
        p_limit: args.first ?? 100,
        p_offset: args.offset ?? 0,
      })).map(mapChunk),

    documentText: async (_: unknown, args: { id: string; start: number; end: number }, context: Context) => {
      const row = await one(context, 'document_text', { p_id: args.id, p_start: args.start, p_end: args.end });
      return row ? { start: row.start, length: row.length, text: row.text || '' } : null;
    },

    documentTags: async (_: unknown, __: unknown, context: Context) =>
      (await rows(context, 'document_tags_list')).map((row) => ({ tag: row.tag, chunks: Number(row.chunks) || 0 })),

    searchDocuments: async (
      _: unknown,
      args: { query: string; tags?: string[] | null; entityIds?: string[] | null; typeCodes?: string[] | null; documentIds?: string[] | null; first?: number | null },
      context: Context,
    ) => searchDocuments(
      context.supabase,
      args.query || '',
      { tags: args.tags, entityIds: args.entityIds, typeCodes: args.typeCodes, documentIds: args.documentIds, limit: args.first ?? 10 },
      embedConfig(),
    ),

    /** A link to the original file that works for a minute. */
    documentFileUrl: async (_: unknown, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('document_get', { p_id: args.id });
      if (error) throw error;
      const path = (data as Row | null)?.storage_path;
      if (!path) return null;
      const signed = await context.supabase.storage.from(DOCUMENT_BUCKET).createSignedUrl(String(path), 60);
      return signed.data?.signedUrl || null;
    },
  },

  Mutation: {
    saveDocumentType: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      try {
        const name = String(input.typeName || '').trim();
        if (!name) return { type: null, errors: [fail('Give the document type a name.', 'typeName')] };
        const clientId = input.id ? null : await callerClientId(context);
        if (!input.id && !clientId) return { type: null, errors: [fail('Choose a client before adding a document type.', null, 'NO_CLIENT')] };
        const row = await one(context, 'document_type_save', {
          p_id: input.id || null,
          p_client_id: clientId,
          p_type_code: String(input.typeCode || name),
          p_type_name: name,
          p_description: input.description ?? null,
          p_is_active: input.isActive !== false,
        });
        return { type: row ? mapType(row) : null, errors: [] };
      } catch (error) {
        return { type: null, errors: [failure(error, 'SAVE_FAILED')] };
      }
    },

    /** Saves the sections of a draft, or starts a new draft when no id is given. */
    saveDocumentTemplate: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      try {
        const sections = cleanTemplateSections(input.sections);
        if (Array.isArray(input.sections) && sections.length !== input.sections.length) {
          return { template: null, errors: [fail('Every section needs a title, and no two may share a code.', 'sections')] };
        }
        const clientId = input.id ? null : await callerClientId(context);
        if (!input.id && !clientId) return { template: null, errors: [fail('Choose a client before changing a template.', null, 'NO_CLIENT')] };
        if (!input.id && !input.typeId) return { template: null, errors: [fail('Choose a document type.', 'typeId')] };
        const row = await one(context, 'document_template_save', {
          p_id: input.id || null,
          p_type_id: input.typeId || null,
          p_client_id: clientId,
          p_sections: sections,
          p_notes: input.notes ?? null,
          p_source_document_ids: strings(input.sourceDocumentIds),
          // Left out, the topics stay as they are.
          p_topics: Array.isArray(input.topics) ? cleanTopics(input.topics) : null,
        });
        return { template: row ? mapTemplate(row) : null, errors: [] };
      } catch (error) {
        return { template: null, errors: [failure(error, 'SAVE_FAILED')] };
      }
    },

    /**
     * Draws sections from the headings of the chosen documents. With no base
     * template the result is a new draft. With a draft as base, the draft gains
     * what it lacks. With a published base, a new draft starts from it.
     */
    generateDocumentTemplate: async (_: unknown, args: { typeId: string; documentIds: string[]; baseTemplateId?: string | null }, context: Context) => {
      try {
        const documentIds = [...new Set(args.documentIds || [])];
        if (documentIds.length === 0) return { template: null, errors: [fail('Choose at least one document.', 'documentIds')] };
        const { outlines, typeIds } = await outlinesOf(context, documentIds);
        if (typeIds.size > 1 || !typeIds.has(args.typeId)) {
          return { template: null, errors: [fail('Every document must be of this document type.', 'documentIds')] };
        }
        const base = args.baseTemplateId
          ? (await rows(context, 'document_templates_list', { p_type_id: args.typeId })).find((template) => template.id === args.baseTemplateId)
          : null;
        if (args.baseTemplateId && !base) return { template: null, errors: [fail('Template was not found.', 'baseTemplateId', 'NOT_FOUND')] };

        const sections: TemplateSection[] = base ? extendTemplate(cleanTemplateSections(base.sections), outlines) : generateTemplate(outlines);
        const sources = [...new Set([...(base?.source_document_ids || []), ...documentIds])];
        const updatesDraft = base?.status === 'DRAFT';
        const clientId = updatesDraft ? null : await callerClientId(context);
        if (!updatesDraft && !clientId) return { template: null, errors: [fail('Choose a client before changing a template.', null, 'NO_CLIENT')] };
        // A first draft starts with the usual topics for its type. A draft keeps its own; a new draft takes the published ones.
        let topics: unknown = null;
        if (!base) {
          const type = (await rows(context, 'document_types_list')).find((row) => row.id === args.typeId);
          topics = defaultTopics(type?.type_code);
        } else if (!updatesDraft) {
          topics = cleanTopics(base.topics);
        }
        const row = await one(context, 'document_template_save', {
          p_id: updatesDraft ? base!.id : null,
          p_type_id: args.typeId,
          p_client_id: clientId,
          p_sections: sections,
          p_notes: base?.notes ?? null,
          p_source_document_ids: sources,
          p_topics: topics,
        });
        return { template: row ? mapTemplate(row) : null, errors: [] };
      } catch (error) {
        return { template: null, errors: [failure(error, 'GENERATE_FAILED')] };
      }
    },

    /** Publishes a draft and tags every document of its type against it. */
    publishDocumentTemplate: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const row = await one(context, 'document_template_publish', { p_id: args.id });
        if (!row) return { template: null, tagged: 0, failed: 0, routes: 0, errors: [fail('Template was not found.', 'id', 'NOT_FOUND')] };
        const { tagged, failed } = await retagType(context, String(row.type_id));
        // Give the topics and top sections their vectors, so a search can be routed by them.
        let routes = 0;
        const embed = embedConfig();
        if (embed) {
          try {
            routes = await ensureTemplateRoutes(context.supabase, String(row.id), embed, { force: true, budgetMs: 25000 });
          } catch {
            // The worker builds them the next time it reads a document of this type.
          }
        }
        return { template: mapTemplate(row), tagged, failed, routes, errors: [] };
      } catch (error) {
        return { template: null, tagged: 0, failed: 0, routes: 0, errors: [failure(error, 'PUBLISH_FAILED')] };
      }
    },

    deleteDocumentTemplate: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('document_template_delete', { p_id: args.id });
        if (error) throw error;
        return data === true ? { success: true, errors: [] } : { success: false, errors: [fail('Template was not found.', 'id', 'NOT_FOUND')] };
      } catch (error) {
        return { success: false, errors: [failure(error, 'DELETE_FAILED')] };
      }
    },

    updateDocument: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      try {
        const row = await one(context, 'document_update', {
          p_id: input.id,
          p_title: input.title ?? null,
          p_type_id: input.typeId || null,
          p_document_date: input.documentDate || null,
          p_clear_date: input.documentDate === '',
          p_tags: strings(input.tags),
          p_entity_links: entityLinks(input.entities),
        });
        if (!row) return { document: null, errors: [fail('Document was not found.', 'id', 'NOT_FOUND')] };
        // A new type has its own template.
        if (input.typeId && !row.template_id && Number(row.chunk_count) > 0) {
          await tagDocument(context.supabase, input.id, embedConfig(), { budgetMs: 15000 });
        }
        const fresh = await one(context, 'document_get', { p_id: input.id });
        return { document: fresh ? mapDocument(fresh) : null, errors: [] };
      } catch (error) {
        return { document: null, errors: [failure(error, 'SAVE_FAILED')] };
      }
    },

    deleteDocument: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('document_delete', { p_id: args.id });
        if (error) throw error;
        if (!data) return { success: false, errors: [fail('Document was not found.', 'id', 'NOT_FOUND')] };
        // The row is gone; a file left behind is only wasted space.
        await context.supabase.storage.from(DOCUMENT_BUCKET).remove([String(data)]);
        return { success: true, errors: [] };
      } catch (error) {
        return { success: false, errors: [failure(error, 'DELETE_FAILED')] };
      }
    },

    /** Queues the file to be read again from the start. */
    reprocessDocument: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const row = await one(context, 'document_reprocess', { p_id: args.id });
        return { document: row ? mapDocument(row) : null, errors: [] };
      } catch (error) {
        return { document: null, errors: [failure(error, 'REPROCESS_FAILED')] };
      }
    },

    /** Places the document's headings on its type's published template again. A person's own choices are kept. */
    retagDocument: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        await tagDocument(context.supabase, args.id, embedConfig(), { budgetMs: 15000 });
        const row = await one(context, 'document_get', { p_id: args.id });
        return { document: row ? mapDocument(row) : null, errors: [] };
      } catch (error) {
        return { document: null, errors: [failure(error, 'TAG_FAILED')] };
      }
    },

    /** A person's description and topics for one passage. Kept from then on; the worker embeds the passage again. */
    refineDocumentChunk: async (_: unknown, args: { chunkId: string; summary?: string | null; topics?: string[] | null }, context: Context) => {
      try {
        const row = await one(context, 'document_chunk_refine', { p_chunk_id: args.chunkId, p_summary: args.summary ?? null, p_topics: args.topics || [] });
        return row ? { success: true, errors: [] } : { success: false, errors: [fail('Passage was not found.', 'chunkId', 'NOT_FOUND')] };
      } catch (error) {
        return { success: false, errors: [failure(error, 'SAVE_FAILED')] };
      }
    },

    assignDocumentSection: async (_: unknown, args: { sectionId: string; templateSectionCode?: string | null }, context: Context) => {
      try {
        const row = await one(context, 'document_section_assign', { p_section_id: args.sectionId, p_code: args.templateSectionCode || '' });
        if (!row) return { document: null, errors: [fail('Section was not found.', 'sectionId', 'NOT_FOUND')] };
        const document = await one(context, 'document_get', { p_id: row.document_id });
        return { document: document ? mapDocument(document) : null, errors: [] };
      } catch (error) {
        return { document: null, errors: [failure(error, 'SAVE_FAILED')] };
      }
    },
  },
};
