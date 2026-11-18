import { config } from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DOCUMENT_BUCKET, embedConfigFromEnv, processDocument, searchDocuments } from '@tapestrai/graphql/src/lib/document-content';
import { refinerFromEnv } from './document-refiner';

/**
 * Documents from the command line, without a running worker.
 *
 *   npm run documents --workspace @tapestrai/worker -- add <file> --type CREDIT_AGREEMENT [--client <code>] [--title "..."] [--entity <entity code>:<ROLE>]
 *   npm run documents --workspace @tapestrai/worker -- process <document id> [--reread]
 *   npm run documents --workspace @tapestrai/worker -- pending
 *   npm run documents --workspace @tapestrai/worker -- search "<question>" [--tag kind:definition] [--limit 5]
 *
 * Uses the service role from the repository .env, so it sees every client. A
 * run the embedding service slows down is carried on by running `process` again.
 */

config({ path: resolve(__dirname, '../../../.env') });
config();

const MEDIA_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain', '.md': 'text/markdown',
};

function flag(args: string[], name: string): string | null {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
}

function flags(args: string[], name: string): string[] {
  return args.flatMap((arg, index) => (arg === `--${name}` && index + 1 < args.length ? [args[index + 1]] : []));
}

async function clientIdFor(supabase: SupabaseClient, code: string | null): Promise<string> {
  const { data, error } = await supabase.schema('tenancy').from('clients').select('id, client_code, client_name');
  if (error) throw new Error(error.message);
  const clients = data || [];
  const found = code ? clients.filter((client) => client.client_code === code || client.id === code) : clients;
  if (found.length === 1) return String(found[0].id);
  throw new Error(`Name one client with --client. Clients: ${clients.map((client) => client.client_code).join(', ') || 'none'}.`);
}

async function runUntilDone(supabase: SupabaseClient, documentId: string, reread: boolean) {
  const embed = embedConfigFromEnv();
  if (!embed) console.log('VOYAGE_API_KEY is not set: the document will be searchable by words only.');
  const refiner = refinerFromEnv();
  if (!refiner) console.log('ANTHROPIC_API_KEY is not set: tables and lists will not be described.');
  let again = reread;
  for (;;) {
    const result = await processDocument(supabase, documentId, {
      embed,
      refiner,
      reread: again,
      budgetMs: 10 * 60 * 1000,
      sleep: (ms) => {
        console.log(`  the embedding service asked to wait ${Math.round(ms / 1000)}s`);
        return new Promise((done) => setTimeout(done, ms));
      },
    });
    console.log(`${result.status}: ${result.chunks} chunks, ${result.embedded} embedded, ${result.refined} described${result.message ? `. ${result.message}` : ''}`);
    if (result.status !== 'PROCESSING') return result;
    again = false;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  if (command === 'add') {
    const file = args[0];
    if (!file || file.startsWith('--')) throw new Error('Give the file to add.');
    const typeCode = flag(args, 'type') || 'OTHER';
    const clientId = await clientIdFor(supabase, flag(args, 'client'));
    const bytes = readFileSync(file);
    const fileName = basename(file);

    const { data: types, error: typeError } = await supabase.rpc('document_types_list');
    if (typeError) throw new Error(typeError.message);
    const type = ((types as Array<Record<string, any>>) || []).find((row) => row.type_code === typeCode && (row.client_id === null || row.client_id === clientId));
    if (!type) throw new Error(`No document type has the code ${typeCode}.`);

    const links: Array<{ entityId: string; role: string }> = [];
    for (const spec of flags(args, 'entity')) {
      const [code, role] = spec.split(':');
      const { data: entity } = await supabase.schema('entity_instances').from('master_entities')
        .select('id').eq('entity_code', code).eq('client_id', clientId).maybeSingle();
      if (!entity) throw new Error(`No record has the code ${code} for this client.`);
      links.push({ entityId: String(entity.id), role: role || 'SUBJECT' });
    }

    const id = randomUUID();
    const path = `${clientId}/${id}/${fileName.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    const mediaType = MEDIA_TYPES[extname(fileName).toLowerCase()] || 'application/octet-stream';
    const { error: uploadError } = await supabase.storage.from(DOCUMENT_BUCKET).upload(path, bytes, { contentType: mediaType, upsert: false });
    if (uploadError) throw new Error(`The file could not be stored. ${uploadError.message}`);
    const { data: created, error: createError } = await supabase.rpc('document_create', {
      p_id: id,
      p_client_id: clientId,
      p_type_id: type.id,
      p_title: flag(args, 'title'),
      p_file_name: fileName,
      p_media_type: mediaType,
      p_size_bytes: bytes.length,
      p_sha256: createHash('sha256').update(bytes).digest('hex'),
      p_storage_path: path,
      p_document_date: flag(args, 'date'),
      p_tags: flags(args, 'tag'),
      p_entity_links: links,
    });
    if (createError) {
      await supabase.storage.from(DOCUMENT_BUCKET).remove([path]);
      throw new Error(createError.message);
    }
    const document = created as Record<string, any>;
    if (document.duplicate) {
      await supabase.storage.from(DOCUMENT_BUCKET).remove([path]);
      console.log(`This file is already held as "${document.title}" (${document.id}), status ${document.status}.`);
      if (document.status === 'READY') return;
    } else {
      console.log(`Added ${document.id}`);
    }
    await runUntilDone(supabase, String(document.id), false);
    return;
  }

  if (command === 'process') {
    if (!args[0]) throw new Error('Give the document id.');
    await runUntilDone(supabase, args[0], args.includes('--reread'));
    return;
  }

  if (command === 'pending') {
    const { data, error } = await supabase.rpc('documents_list', { p_limit: 500 });
    if (error) throw new Error(error.message);
    const waiting = ((data as Array<Record<string, any>>) || []).filter((row) => row.status === 'RECEIVED' || row.status === 'PROCESSING');
    if (waiting.length === 0) console.log('No document is waiting.');
    for (const row of waiting) {
      console.log(`${row.title} (${row.id})`);
      await runUntilDone(supabase, String(row.id), false);
    }
    return;
  }

  if (command === 'search') {
    if (!args[0]) throw new Error('Give the question.');
    const { hits, byMeaning, reranked, note } = await searchDocuments(
      supabase,
      args[0],
      { tags: flags(args, 'tag'), typeCodes: flags(args, 'type'), limit: Number(flag(args, 'limit')) || 5 },
      embedConfigFromEnv(),
    );
    console.log(`${byMeaning ? 'Searched by meaning and words' : 'Searched by words'}${reranked ? ', then ranked again' : ''}.${note ? ` ${note}` : ''}`);
    hits.forEach((hit, index) => {
      const where = [hit.sectionHeading || hit.parentHeading, hit.clause, hit.page ? `p.${hit.page}` : null].filter(Boolean).join(', ');
      console.log(`\n${index + 1}. ${hit.documentTitle} | ${where} | ${hit.foundBy} ${hit.relevance !== null ? `relevance ${hit.relevance}` : hit.similarity ?? ''}${hit.routedBy ? ` | routed by ${hit.routedBy}` : ''}`);
      if (hit.summary) console.log(`   [described as] ${hit.summary}`);
      console.log(`   ${hit.text.replace(/\s+/g, ' ').slice(0, 320)}`);
    });
    return;
  }

  throw new Error('Use one of: add <file>, process <document id>, pending, search "<question>".');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
