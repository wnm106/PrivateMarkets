import type { SupabaseClient } from '@supabase/supabase-js';
import type { Context } from '../context';
import { walkEntityGraph, type GraphEdge } from '../lib/entity-resolution/graph';
import {
  compareAttributes,
  findCandidates,
  scorePair,
  type MatchableEntity,
  type MatchClause,
  type MatchRule,
} from '../lib/entity-resolution/match';
import { MATCH_ALGORITHMS, type MatchAlgorithm } from '../lib/entity-resolution/similarity';

const ALGORITHMS = new Set<string>(MATCH_ALGORITHMS);
const POPULATION_CAP = 8000;

function asAttributes(value: unknown): Record<string, string> {
  const source = typeof value === 'string' ? safeParse(value) : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const attributes: Record<string, string> = {};
  for (const [key, raw] of Object.entries(source as Record<string, unknown>)) {
    if (raw == null) continue;
    const text = typeof raw === 'object' && raw && 'value' in raw ? (raw as { value: unknown }).value : raw;
    if (text == null) continue;
    const printed = String(text).trim();
    if (printed) attributes[key] = printed;
  }
  return attributes;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function mapClause(row: any): MatchClause & { id: string } {
  return {
    id: row.id,
    clauseCode: row.clause_code,
    attributeCodes: row.attribute_codes || [],
    useEntityName: Boolean(row.use_entity_name),
    algorithm: row.algorithm,
    threshold: Number(row.threshold),
    weight: Number(row.weight),
    deterministic: Boolean(row.deterministic),
    isActive: row.is_active !== false,
  };
}

function mapRule(row: any, clauses: any[]): MatchRule & { id: string } {
  return {
    id: row.id,
    ruleCode: row.rule_code,
    ruleName: row.rule_name,
    description: row.description || null,
    minScore: Number(row.min_score),
    isActive: row.is_active !== false,
    clauses: clauses.filter((clause) => clause.rule_id === row.id).map(mapClause),
  };
}

async function loadRules(supabase: SupabaseClient): Promise<Array<MatchRule & { id: string }>> {
  const { data: rules, error } = await supabase.from('match_rules').select('*').order('rule_code');
  if (error) throw error;
  const { data: clauses, error: clauseError } = await supabase.from('match_rule_clauses').select('*').order('clause_code');
  if (clauseError) throw clauseError;
  return (rules || []).map((rule) => mapRule(rule, clauses || []));
}

async function loadPopulation(supabase: SupabaseClient): Promise<{ entities: MatchableEntity[]; truncated: boolean }> {
  const { data, error } = await supabase.rpc('entity_resolution_population');
  if (error) {
    throw new Error(error.message || 'Entity resolution is not available until migration 00061 is applied.');
  }
  const rows = data || [];
  return {
    truncated: rows.length >= POPULATION_CAP,
    entities: rows.map((row: any) => ({
      id: row.id,
      entityCode: row.entity_code,
      entityName: row.entity_name,
      domainCode: row.domain_code,
      clientId: row.client_id,
      attributes: asAttributes(row.attributes),
    })),
  };
}

function entityRef(entity: MatchableEntity | undefined, id: string) {
  return {
    id,
    entityCode: entity?.entityCode || id,
    entityName: entity?.entityName || 'Unknown entity',
    domainCode: entity?.domainCode || '',
  };
}

function presentPair(pair: ReturnType<typeof scorePair>, byId: Map<string, MatchableEntity>) {
  if (!pair) return null;
  return {
    score: pair.score,
    crossDomain: pair.crossDomain,
    ruleCode: pair.ruleCode,
    ruleName: pair.ruleName,
    reasons: pair.reasons,
    left: entityRef(byId.get(pair.leftId), pair.leftId),
    right: entityRef(byId.get(pair.rightId), pair.rightId),
  };
}

function assertClause(clause: any) {
  const algorithm = String(clause.algorithm || '');
  if (!ALGORITHMS.has(algorithm)) {
    throw new Error(`Unknown match algorithm "${algorithm}". Use exact, jaro_winkler, levenshtein, or jaccard.`);
  }
  const threshold = Number(clause.threshold);
  const weight = Number(clause.weight);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Threshold must be between 0 and 1.');
  if (!Number.isFinite(weight) || weight <= 0) throw new Error('Weight must be greater than 0.');
  if (!String(clause.clauseCode || '').trim()) throw new Error('Each clause needs a code.');
  return {
    clause_code: String(clause.clauseCode).trim().toUpperCase(),
    attribute_codes: (clause.attributeCodes || []).map((code: string) => String(code).trim().toUpperCase()).filter(Boolean),
    use_entity_name: Boolean(clause.useEntityName),
    algorithm: algorithm as MatchAlgorithm,
    threshold,
    weight,
    deterministic: Boolean(clause.deterministic),
    is_active: clause.isActive !== false,
  };
}

async function replaceClauses(supabase: SupabaseClient, ruleId: string, clauses: any[]) {
  const prepared = (clauses || []).map(assertClause);
  const codes = new Set(prepared.map((clause) => clause.clause_code));
  if (codes.size !== prepared.length) throw new Error('Clause codes must be unique within a rule.');
  const { data: existing, error } = await supabase.from('match_rule_clauses').select('id, clause_code').eq('rule_id', ruleId);
  if (error) throw error;
  const byCode = new Map((existing || []).map((row: any) => [row.clause_code, row.id]));
  const remove = (existing || []).filter((row: any) => !codes.has(row.clause_code)).map((row: any) => row.id);
  if (remove.length > 0) {
    const { error: deleteError } = await supabase.from('match_rule_clauses').delete().in('id', remove);
    if (deleteError) throw deleteError;
  }
  for (const clause of prepared) {
    const id = byCode.get(clause.clause_code);
    const write = id
      ? supabase.from('match_rule_clauses').update({ ...clause, updated_at: new Date().toISOString() }).eq('id', id)
      : supabase.from('match_rule_clauses').insert({ ...clause, rule_id: ruleId });
    const { error: writeError } = await write;
    if (writeError) throw writeError;
  }
}

async function loadEdges(supabase: SupabaseClient): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  const pageSize = 1000;
  const now = new Date().toISOString();
  const asOf = now.slice(0, 10);
  for (let from = 0; from < 20000; from += pageSize) {
    const { data, error } = await supabase
      .from('entity_relationships')
      .select('id, parent_entity_id, child_entity_id, relationship_code, relationship_type, is_primary, metadata')
      .lte('valid_from', asOf)
      .gte('valid_to', asOf)
      .lte('system_from', now)
      .gte('system_to', now)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    for (const row of data || []) {
      edges.push({
        id: row.id,
        parentEntityId: row.parent_entity_id,
        childEntityId: row.child_entity_id,
        relationshipCode: row.relationship_code,
        relationshipType: row.relationship_type,
        isPrimary: row.is_primary,
        metadata: row.metadata || null,
      });
    }
    if (!data || data.length < pageSize) break;
  }
  return edges;
}

async function countEdges(supabase: SupabaseClient, entityId: string): Promise<number> {
  const now = new Date().toISOString();
  const asOf = now.slice(0, 10);
  const { count, error } = await supabase
    .from('entity_relationships')
    .select('id', { count: 'exact', head: true })
    .or(`parent_entity_id.eq.${entityId},child_entity_id.eq.${entityId}`)
    .lte('valid_from', asOf)
    .gte('valid_to', asOf)
    .lte('system_from', now)
    .gte('system_to', now);
  if (error) return 0;
  return count || 0;
}

export const entityResolutionResolvers = {
  Query: {
    matchRules: async (_: unknown, __: unknown, context: Context) => loadRules(context.supabase),

    mergeCandidates: async (_: unknown, args: { filter?: any }, context: Context) => {
      const filter = args.filter || {};
      const [{ entities, truncated: populationTruncated }, rules] = await Promise.all([
        loadPopulation(context.supabase),
        loadRules(context.supabase),
      ]);
      const result = findCandidates(entities, rules, {
        focusId: filter.entityId || null,
        query: filter.query || null,
        ruleCode: filter.ruleCode || null,
        crossDomainOnly: Boolean(filter.crossDomainOnly),
        sameDomainOnly: Boolean(filter.sameDomainOnly),
        limit: filter.limit || 50,
      });
      if (filter.entityId && !entities.some((entity) => entity.id === filter.entityId)) {
        throw new Error('That entity is not an active record you can match.');
      }
      const byId = new Map(entities.map((entity) => [entity.id, entity]));
      return {
        candidates: result.candidates.map((pair) => presentPair(pair, byId)),
        scannedCount: result.scannedCount,
        truncated: result.truncated || populationTruncated,
      };
    },

    mergePreview: async (
      _: unknown,
      args: { survivorId: string; retiredId: string; ruleCode?: string | null },
      context: Context,
    ) => {
      const [{ entities }, rules] = await Promise.all([
        loadPopulation(context.supabase),
        loadRules(context.supabase),
      ]);
      const survivor = entities.find((entity) => entity.id === args.survivorId);
      const retired = entities.find((entity) => entity.id === args.retiredId);
      if (!survivor || !retired) throw new Error('Both entities must be active records you can read.');
      const active = rules.filter((rule) => rule.isActive && (!args.ruleCode || rule.ruleCode === args.ruleCode));
      let best = null as ReturnType<typeof scorePair>;
      for (const rule of active) {
        const scored = scorePair(survivor, retired, rule);
        if (scored && (!best || scored.score > best.score)) best = scored;
      }
      const relationshipsToMove = await countEdges(context.supabase, retired.id);
      return {
        survivor: entityRef(survivor, survivor.id),
        retired: entityRef(retired, retired.id),
        crossDomain: survivor.domainCode.toUpperCase() !== retired.domainCode.toUpperCase(),
        score: best?.score || 0,
        ruleName: best?.ruleName || null,
        reasons: best?.reasons || [],
        fields: compareAttributes(survivor, retired),
        relationshipsToMove,
      };
    },

    entityGraph: async (
      _: unknown,
      args: { entityId: string; depth?: number | null; relationshipCodes?: string[] | null },
      context: Context,
    ) => {
      const edges = await loadEdges(context.supabase);
      const walked = walkEntityGraph(args.entityId, edges, args.depth ?? 3, args.relationshipCodes);
      const ids = walked.nodes.map((node) => node.id);
      const details = new Map<string, { entity_code: string; entity_name: string; domain_code: string }>();
      for (let offset = 0; offset < ids.length; offset += 100) {
        const slice = ids.slice(offset, offset + 100);
        if (slice.length === 0) continue;
        const { data, error } = await context.supabase
          .from('entity_master')
          .select('entity_id, entity_code, entity_name, domain_code')
          .in('entity_id', slice);
        if (error) throw error;
        for (const row of data || []) details.set(row.entity_id, row);
      }
      return {
        rootId: args.entityId,
        nodes: walked.nodes.map((node) => {
          const detail = details.get(node.id);
          return {
            id: node.id,
            entityCode: detail?.entity_code || node.id.slice(0, 8),
            entityName: detail?.entity_name || 'Linked record',
            domainCode: detail?.domain_code || '',
            depth: node.depth,
            direction: node.direction,
          };
        }),
        edges: walked.edges.map((edge) => ({
          id: edge.id,
          parentEntityId: edge.parentEntityId,
          childEntityId: edge.childEntityId,
          relationshipCode: edge.relationshipCode,
          relationshipType: edge.relationshipType,
          isPrimary: Boolean(edge.isPrimary),
          metadata: edge.metadata || null,
        })),
      };
    },
  },

  Mutation: {
    mergeEntities: async (_: unknown, args: any, context: Context) => {
      try {
        const choices = (args.fieldChoices || []).map((choice: any) => ({
          attributeCode: choice.attributeCode,
          takeFrom: choice.takeFrom === 'retired' ? 'retired' : 'survivor',
        }));
        const { data, error } = await context.supabase.rpc('merge_entities', {
          p_survivor_id: args.survivorId,
          p_retired_id: args.retiredId,
          p_field_choices: choices,
          p_match_score: args.matchScore ?? null,
          p_match_reasons: args.matchReasons || [],
        });
        if (error) throw error;
        const result = data || {};
        return {
          success: true,
          survivorId: result.survivorId || args.survivorId,
          retiredId: result.retiredId || args.retiredId,
          attributesCopied: result.attributesCopied || 0,
          relationshipsMoved: result.relationshipsMoved || 0,
          intersectionsMoved: result.intersectionsMoved || 0,
          positionsMoved: result.positionsMoved || 0,
          errors: [],
        };
      } catch (error: any) {
        return {
          success: false,
          survivorId: null,
          retiredId: null,
          attributesCopied: 0,
          relationshipsMoved: 0,
          intersectionsMoved: 0,
          positionsMoved: 0,
          errors: [{ field: '', message: error.message || 'Merge failed', code: 'MERGE_FAILED' }],
        };
      }
    },

    updateMatchRule: async (_: unknown, args: { input: any }, context: Context) => {
      try {
        const input = args.input;
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (input.ruleName != null) patch.rule_name = input.ruleName;
        if (input.description != null) patch.description = input.description;
        if (input.minScore != null) {
          const minScore = Number(input.minScore);
          if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) throw new Error('Minimum score must be between 0 and 100.');
          patch.min_score = minScore;
        }
        if (input.isActive != null) patch.is_active = input.isActive;
        const { error } = await context.supabase.from('match_rules').update(patch).eq('id', input.id);
        if (error) throw error;
        if (input.clauses) await replaceClauses(context.supabase, input.id, input.clauses);
        const rules = await loadRules(context.supabase);
        return { rule: rules.find((rule) => rule.id === input.id) || null, errors: [] };
      } catch (error: any) {
        return { rule: null, errors: [{ field: '', message: error.message || 'Could not save the match rule', code: 'MATCH_RULE_FAILED' }] };
      }
    },

    createMatchRule: async (_: unknown, args: { input: any }, context: Context) => {
      try {
        const input = args.input;
        const minScore = Number(input.minScore);
        if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) throw new Error('Minimum score must be between 0 and 100.');
        const { data, error } = await context.supabase
          .from('match_rules')
          .insert({
            rule_code: String(input.ruleCode || '').trim().toUpperCase(),
            rule_name: input.ruleName,
            description: input.description || null,
            min_score: minScore,
            is_active: true,
          })
          .select('id')
          .single();
        if (error) throw error;
        await replaceClauses(context.supabase, data.id, input.clauses || []);
        const rules = await loadRules(context.supabase);
        return { rule: rules.find((rule) => rule.id === data.id) || null, errors: [] };
      } catch (error: any) {
        return { rule: null, errors: [{ field: '', message: error.message || 'Could not create the match rule', code: 'MATCH_RULE_FAILED' }] };
      }
    },
  },
};
