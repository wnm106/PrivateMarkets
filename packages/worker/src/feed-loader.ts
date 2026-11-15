import type { SupabaseClient } from '@supabase/supabase-js';
import { MapMismatchError, createImportInstance, processImportInstance } from '@tapestrai/mcp-server/src/feeds/import-instances';
import type { FileLoader } from './feeds';

/**
 * Loads a file through a saved map, the same way the Load data screen does.
 *
 * Nobody is watching an unattended load, so it only goes ahead when the file
 * is exactly the shape the map was saved for. Anything else is parked in Load
 * data (Imports) for a person:
 *   - the file is missing columns the map needs
 *   - the file has columns the map has not seen (they would be mapped by guesswork)
 */
export function mapFileLoader(supabase: SupabaseClient, now: () => Date = () => new Date()): FileLoader {
  return async ({ clientId, mapCode, sourceCode, fileName, mediaType, bytes }) => {
    const options = { sourceCode: sourceCode || undefined };
    let instance;
    try {
      instance = await createImportInstance(fileName, mediaType, bytes, clientId, supabase, { ...options, forceMapCode: mapCode });
    } catch (error) {
      if (!(error instanceof MapMismatchError)) throw error;
      // Store it without the map so it shows in Load data with fresh column suggestions.
      try {
        const parked = await createImportInstance(fileName, mediaType, bytes, clientId, supabase, options);
        return { status: 'NEEDS_REVIEW', importInstanceId: parked.id, message: `${error.message} It is waiting in Load data.` };
      } catch (parkError) {
        const detail = parkError instanceof Error ? parkError.message : 'it could not be stored';
        return { status: 'FAILED', message: `${error.message} It could not be parked for review: ${detail}` };
      }
    }

    if (instance.mapReuse !== 'exact') {
      return {
        status: 'NEEDS_REVIEW',
        importInstanceId: instance.id,
        message: `The file has columns that map ${mapCode} has not seen. It is waiting in Load data.`,
      };
    }

    const asOf = instance.asOfDate || now().toISOString().slice(0, 10);
    const loaded = await processImportInstance(instance.id, clientId, instance.columnMappings, asOf, supabase);
    if (loaded.status !== 'SUCCEEDED') {
      return { status: 'FAILED', importInstanceId: loaded.id, message: loaded.errorMessage || 'Some rows could not be loaded.' };
    }
    return {
      status: 'LOADED',
      importInstanceId: loaded.id,
      created: loaded.resultSummary?.created ?? 0,
      matched: loaded.resultSummary?.matched ?? 0,
    };
  };
}
