import type { SupabaseClient } from '@supabase/supabase-js';
import { MapMismatchError, createImportInstance, getReusableMap, processImportInstance } from '@tapestrai/mcp-server/src/feeds/import-instances';
import type { FileLoader, LoadOutcome } from './feeds';

/**
 * Loads a file through a saved map, the same way the Load data screen does.
 *
 * Nobody is watching an unattended load, so it only goes ahead when the file
 * is exactly the shape the map was saved for. Anything else is parked in Load
 * data (Imports) for a person.
 *
 * There are two kinds of saved map, and Load data decides which a file gets:
 *
 *   Layout maps (statements and other recognised documents) carry the file's
 *   columns. The file is read with the map forced, and must match it exactly:
 *   no missing columns, and none the map has not seen.
 *
 *   Signature maps (ordinary tables) are found by the file's exact set of
 *   column headers. The file is read with no map forced, and must come back
 *   with the feed's map. A different set of headers finds another map or none.
 */

type Instance = Awaited<ReturnType<typeof createImportInstance>>;

export function mapFileLoader(supabase: SupabaseClient, now: () => Date = () => new Date()): FileLoader {
  async function load(instance: Instance, clientId: string): Promise<LoadOutcome> {
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
  }

  return async ({ clientId, mapCode, sourceCode, fileName, mediaType, bytes }) => {
    const options = { sourceCode: sourceCode || undefined };
    const read = (forceMapCode?: string) =>
      createImportInstance(fileName, mediaType, bytes, clientId, supabase, forceMapCode ? { ...options, forceMapCode } : options);

    if (!(await getReusableMap(mapCode, clientId, supabase))) {
      // A signature map. Reading the file finds its map by its headers.
      const instance = await read();
      if (instance.mapCode !== mapCode) {
        return {
          status: 'NEEDS_REVIEW',
          importInstanceId: instance.id,
          message: `The file's columns are not the ones map ${mapCode} was saved for. It is waiting in Load data.`,
        };
      }
      return load(instance, clientId);
    }

    let instance: Instance;
    try {
      instance = await read(mapCode);
    } catch (error) {
      if (!(error instanceof MapMismatchError)) throw error;
      // Store it without the map so it shows in Load data with fresh column suggestions.
      try {
        const parked = await read();
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
    return load(instance, clientId);
  };
}
