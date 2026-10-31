/**
 * Data specialist tools.
 * The same interview the load screen runs: read a file, ask what cannot be
 * decided, recommend new entities or attributes, save a reusable map, and load.
 */

import type { JSONSchema7 } from 'json-schema';
import {
  answerLoadSession,
  getLoadSession,
  listLoadSessions,
  listSourceMaps,
  refreshLoadSession,
  runLoadSession,
  saveSourceMap,
  startLoadSession,
} from '../feeds/load-sessions';
import { ToolRegistry } from '../lib/tool-registry.js';
import { ToolDefinition } from '../lib/types.js';

const listSourceMapsTool: ToolDefinition = {
  name: 'list_source_maps',
  description: 'List reusable source maps, including the Position File map. A map can load one entity or several, with parents before dependents.',
  category: 'import',
  inputSchema: { type: 'object', properties: {} },
  execute: async (_args, supabase) => ({ maps: await listSourceMaps(supabase) }),
};

const listLoadSessionsTool: ToolDefinition = {
  name: 'list_load_sessions',
  description: 'List guided data loads. Each session keeps the original file, the specialist\'s questions, and the map it produced.',
  category: 'import',
  inputSchema: { type: 'object', properties: {} },
  execute: async (_args, supabase) => ({ sessions: await listLoadSessions(supabase) }),
};

const startLoadSessionTool: ToolDefinition = {
  name: 'start_load_session',
  description: 'Read any CSV, Excel, JSON, or document and start a data-specialist interview. Returns the briefing, the questions that still need an answer, recommended new attributes or entities, and the map so far. Does not load until run_load_session.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      fileName: { type: 'string' },
      contentBase64: { type: 'string', description: 'Base64 file bytes. Use this for Excel, PDF, and JSON.' },
      csvText: { type: 'string', description: 'Raw CSV or JSON text when contentBase64 is omitted.' },
      mediaType: { type: 'string' },
    },
    required: ['fileName'],
  } as JSONSchema7,
  execute: async (args, supabase) => {
    if (!args.contentBase64 && !args.csvText) throw new Error('Provide contentBase64 or csvText');
    const bytes = args.contentBase64
      ? Buffer.from(String(args.contentBase64), 'base64')
      : Buffer.from(String(args.csvText), 'utf8');
    return startLoadSession(String(args.fileName), String(args.mediaType || 'text/csv'), bytes, supabase);
  },
};

const readLoadSessionTool: ToolDefinition = {
  name: 'read_load_session',
  description: 'Read one load session, including the specialist briefing, open questions, recommendations, column assignments, and load order.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: { sessionId: { type: 'string' } },
    required: ['sessionId'],
  } as JSONSchema7,
  execute: async (args, supabase) => getLoadSession(String(args.sessionId), supabase),
};

const answerLoadSessionTool: ToolDefinition = {
  name: 'answer_load_session',
  description: 'Answer the specialist. answers is a map of question id to option id (for example source, as_of, reuse_map, identity:FUND). Pass acceptedRecommendationIds to add an attribute, entity, or relationship. Pass dismissedRecommendationIds to leave a recommendation out. Re-reads the file with those decisions.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      answers: { type: 'object', additionalProperties: { type: 'string' } },
      acceptedRecommendationIds: { type: 'array', items: { type: 'string' } },
      dismissedRecommendationIds: { type: 'array', items: { type: 'string' } },
    },
    required: ['sessionId'],
  } as JSONSchema7,
  execute: async (args, supabase) => answerLoadSession(
    String(args.sessionId),
    (args.answers || {}) as Record<string, string>,
    Array.isArray(args.acceptedRecommendationIds) ? args.acceptedRecommendationIds.map(String) : undefined,
    Array.isArray(args.dismissedRecommendationIds) ? args.dismissedRecommendationIds.map(String) : undefined,
    supabase
  ),
};

const refreshLoadSessionTool: ToolDefinition = {
  name: 'refresh_load_session',
  description: 'Re-read a stored file and run the current mapping on it. Use this when an older upload should be compared with saved maps again, including fields added since that map was written. Keeps the source, as-of date, and other answers already given. Does not load entities.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: { sessionId: { type: 'string' } },
    required: ['sessionId'],
  } as JSONSchema7,
  execute: async (args, supabase) => refreshLoadSession(String(args.sessionId), supabase),
};

const saveSourceMapTool: ToolDefinition = {
  name: 'save_source_map',
  description: 'Save the session\'s map so a later file with the same columns can reuse it. Does not load entities.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      name: { type: 'string', description: 'Optional display name for the map.' },
    },
    required: ['sessionId'],
  } as JSONSchema7,
  execute: async (args, supabase) => saveSourceMap(String(args.sessionId), args.name ? String(args.name) : undefined, supabase),
};

const runLoadSessionTool: ToolDefinition = {
  name: 'run_load_session',
  description: 'Load the session. Creates any accepted entities, attributes, and relationships, then writes values as of the chosen date. Parents load before dependents. Refuses while a required question is still open.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: { sessionId: { type: 'string' } },
    required: ['sessionId'],
  } as JSONSchema7,
  execute: async (args, supabase) => runLoadSession(String(args.sessionId), supabase),
};

export function registerSpecialistTools(registry: ToolRegistry): void {
  registry.registerTool(listSourceMapsTool);
  registry.registerTool(listLoadSessionsTool);
  registry.registerTool(startLoadSessionTool);
  registry.registerTool(readLoadSessionTool);
  registry.registerTool(answerLoadSessionTool);
  registry.registerTool(refreshLoadSessionTool);
  registry.registerTool(saveSourceMapTool);
  registry.registerTool(runLoadSessionTool);
}
