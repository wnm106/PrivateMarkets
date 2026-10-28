/**
 * Configurable match-rule engine.
 * Deterministic clauses are exact keys (tax id, LEI, CUSIP, internal id).
 * Probabilistic clauses score names with Jaro-Winkler, Levenshtein, and Jaccard.
 * Pairs are scored across entity types. A differing exact key is a veto.
 */

import {
  compactIdentifier,
  normalizeName,
  similarity,
  type MatchAlgorithm,
} from './similarity';

export interface MatchClause {
  id?: string;
  clauseCode: string;
  attributeCodes: string[];
  useEntityName: boolean;
  algorithm: MatchAlgorithm;
  threshold: number;
  weight: number;
  deterministic: boolean;
  isActive: boolean;
}

export interface MatchRule {
  id?: string;
  ruleCode: string;
  ruleName: string;
  description?: string | null;
  minScore: number;
  isActive: boolean;
  clauses: MatchClause[];
}

export interface MatchableEntity {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  clientId: string;
  createdAt?: string | null;
  attributes: Record<string, string>;
}

export interface MatchReason {
  clauseCode: string;
  algorithm: MatchAlgorithm;
  label: string;
  leftValue: string;
  rightValue: string;
  leftAttribute: string;
  rightAttribute: string;
  similarity: number;
  deterministic: boolean;
}

export interface ScoredPair {
  leftId: string;
  rightId: string;
  crossDomain: boolean;
  score: number;
  ruleCode: string;
  ruleName: string;
  reasons: MatchReason[];
}

export interface CandidateQuery {
  focusId?: string | null;
  query?: string | null;
  ruleCode?: string | null;
  crossDomainOnly?: boolean;
  sameDomainOnly?: boolean;
  limit?: number;
}

export interface CandidateSearch {
  candidates: ScoredPair[];
  scannedCount: number;
  truncated: boolean;
}

interface SourcedValue {
  attribute: string;
  value: string;
}

const COMPARISON_CAP = 100_000;
const FUZZY_MIN_LENGTH = 4;

function valuesFor(entity: MatchableEntity, clause: MatchClause): SourcedValue[] {
  const wanted = new Set(clause.attributeCodes.map((code) => code.toUpperCase()));
  const values: SourcedValue[] = [];
  for (const [code, raw] of Object.entries(entity.attributes || {})) {
    if (!wanted.has(code.toUpperCase())) continue;
    const value = String(raw ?? '').trim();
    if (value) values.push({ attribute: code.toUpperCase(), value });
  }
  if (clause.useEntityName && entity.entityName.trim()) {
    values.push({ attribute: 'ENTITY_NAME', value: entity.entityName.trim() });
  }
  return values;
}

function clauseLabel(clause: MatchClause, left: SourcedValue, right: SourcedValue): string {
  const algorithm = clause.algorithm === 'jaro_winkler'
    ? 'Jaro-Winkler'
    : clause.algorithm === 'levenshtein'
      ? 'Levenshtein'
      : clause.algorithm === 'jaccard'
        ? 'Jaccard'
        : 'Exact key';
  const same = left.attribute === right.attribute ? left.attribute : `${left.attribute} ↔ ${right.attribute}`;
  return `${algorithm} · ${same}`;
}

/**
 * Score one pair against one rule.
 * Returns null when a deterministic key conflicts, nothing clears its threshold, or the score is too low.
 */
export function scorePair(left: MatchableEntity, right: MatchableEntity, rule: MatchRule): ScoredPair | null {
  if (!rule.isActive) return null;
  if (left.clientId !== right.clientId) return null;
  const reasons: MatchReason[] = [];
  let weighted = 0;
  let weightUsed = 0;

  for (const clause of rule.clauses) {
    if (!clause.isActive || clause.weight <= 0) continue;
    const leftValues = valuesFor(left, clause);
    const rightValues = valuesFor(right, clause);
    if (leftValues.length === 0 || rightValues.length === 0) continue;

    let best: { left: SourcedValue; right: SourcedValue; score: number } | null = null;
    for (const leftValue of leftValues) {
      for (const rightValue of rightValues) {
        const score = similarity(clause.algorithm, leftValue.value, rightValue.value);
        if (!best || score > best.score) best = { left: leftValue, right: rightValue, score };
      }
    }
    if (!best) continue;

    if (clause.deterministic && best.score < clause.threshold) return null;
    if (best.score < clause.threshold) continue;
    if (clause.algorithm !== 'exact') {
      const shorter = Math.min(normalizeName(best.left.value).length, normalizeName(best.right.value).length);
      if (shorter < FUZZY_MIN_LENGTH) continue;
    }

    weighted += clause.weight * best.score;
    weightUsed += clause.weight;
    reasons.push({
      clauseCode: clause.clauseCode,
      algorithm: clause.algorithm,
      label: clauseLabel(clause, best.left, best.right),
      leftValue: best.left.value,
      rightValue: best.right.value,
      leftAttribute: best.left.attribute,
      rightAttribute: best.right.attribute,
      similarity: Math.round(best.score * 1000) / 1000,
      deterministic: clause.deterministic,
    });
  }

  if (weightUsed === 0 || reasons.length === 0) return null;
  const score = Math.round((weighted / weightUsed) * 100);
  if (score < rule.minScore) return null;

  const [first, second] = left.id < right.id ? [left, right] : [right, left];
  const orderedReasons = left.id < right.id
    ? reasons
    : reasons.map((reason) => ({
      ...reason,
      leftValue: reason.rightValue,
      rightValue: reason.leftValue,
      leftAttribute: reason.rightAttribute,
      rightAttribute: reason.leftAttribute,
    }));

  return {
    leftId: first.id,
    rightId: second.id,
    crossDomain: first.domainCode.toUpperCase() !== second.domainCode.toUpperCase(),
    score,
    ruleCode: rule.ruleCode,
    ruleName: rule.ruleName,
    reasons: orderedReasons,
  };
}

function blockKeys(entity: MatchableEntity, rules: MatchRule[]): string[] {
  const keys = new Set<string>();
  for (const rule of rules) {
    if (!rule.isActive) continue;
    for (const clause of rule.clauses) {
      if (!clause.isActive) continue;
      for (const sourced of valuesFor(entity, clause)) {
        if (clause.algorithm === 'exact') {
          const compact = compactIdentifier(sourced.value);
          if (compact.length >= 4) keys.add(`id:${compact}`);
        } else {
          const normalized = normalizeName(sourced.value);
          if (normalized.length >= 4) keys.add(`pre:${normalized.slice(0, 4)}`);
          for (const token of normalized.split(' ')) {
            if (token.length >= 4) keys.add(`tok:${token}`);
          }
        }
      }
    }
  }
  return [...keys];
}

function textMatch(entity: MatchableEntity, query: string): boolean {
  const haystack = `${entity.entityName} ${entity.entityCode} ${entity.domainCode}`.toLowerCase();
  return haystack.includes(query);
}

function better(candidate: ScoredPair, current: ScoredPair): boolean {
  if (candidate.score !== current.score) return candidate.score > current.score;
  if (candidate.reasons.length !== current.reasons.length) return candidate.reasons.length > current.reasons.length;
  return candidate.ruleCode < current.ruleCode;
}

export function findCandidates(
  entities: MatchableEntity[],
  rules: MatchRule[],
  query: CandidateQuery = {},
): CandidateSearch {
  const activeRules = rules.filter((rule) => rule.isActive && (!query.ruleCode || rule.ruleCode === query.ruleCode));
  const byClient = new Map<string, MatchableEntity[]>();
  for (const entity of entities) {
    const bucket = byClient.get(entity.clientId) || [];
    bucket.push(entity);
    byClient.set(entity.clientId, bucket);
  }

  const best = new Map<string, ScoredPair>();
  let scannedCount = 0;
  let truncated = false;
  let comparisons = 0;
  const limit = Math.max(1, Math.min(200, query.limit || 50));
  const needle = query.query?.trim().toLowerCase() || '';

  const consider = (left: MatchableEntity, right: MatchableEntity) => {
    if (left.id === right.id) return;
    if (comparisons >= COMPARISON_CAP) {
      truncated = true;
      return;
    }
    comparisons++;
    for (const rule of activeRules) {
      const scored = scorePair(left, right, rule);
      if (!scored) continue;
      if (query.crossDomainOnly && !scored.crossDomain) continue;
      if (query.sameDomainOnly && scored.crossDomain) continue;
      const key = `${scored.leftId}:${scored.rightId}`;
      const current = best.get(key);
      if (!current || better(scored, current)) best.set(key, scored);
    }
  };

  for (const group of byClient.values()) {
    scannedCount += group.length;
    const focus = query.focusId ? group.find((entity) => entity.id === query.focusId) : undefined;
    if (query.focusId && !focus) continue;

    if (focus) {
      for (const other of group) consider(focus, other);
      continue;
    }

    const blocks = new Map<string, MatchableEntity[]>();
    for (const entity of group) {
      for (const key of blockKeys(entity, activeRules)) {
        const list = blocks.get(key) || [];
        list.push(entity);
        blocks.set(key, list);
      }
    }
    const seen = new Set<string>();
    for (const list of blocks.values()) {
      if (list.length < 2 || list.length > 400) {
        if (list.length > 400) truncated = true;
        continue;
      }
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const pairKey = list[i].id < list[j].id ? `${list[i].id}:${list[j].id}` : `${list[j].id}:${list[i].id}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          consider(list[i], list[j]);
        }
      }
    }
  }

  let candidates = [...best.values()];
  if (needle) {
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    candidates = candidates.filter((pair) => {
      const left = byId.get(pair.leftId);
      const right = byId.get(pair.rightId);
      return (left && textMatch(left, needle)) || (right && textMatch(right, needle));
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.leftId.localeCompare(b.leftId));
  if (candidates.length > limit) truncated = true;

  return {
    candidates: candidates.slice(0, limit),
    scannedCount,
    truncated,
  };
}

export interface FieldComparison {
  attributeCode: string;
  survivorValue: string | null;
  retiredValue: string | null;
  status: 'same' | 'only_survivor' | 'only_retired' | 'conflict';
}

export function compareAttributes(
  survivor: MatchableEntity,
  retired: MatchableEntity,
): FieldComparison[] {
  const rows: FieldComparison[] = [];
  const nameSame = survivor.entityName.trim() === retired.entityName.trim();
  rows.push({
    attributeCode: 'entity_name',
    survivorValue: survivor.entityName,
    retiredValue: retired.entityName,
    status: nameSame ? 'same' : 'conflict',
  });

  const codes = new Map<string, string>();
  for (const code of [...Object.keys(survivor.attributes || {}), ...Object.keys(retired.attributes || {})]) {
    const key = code.toUpperCase();
    if (!codes.has(key)) codes.set(key, key);
  }
  for (const code of codes.keys()) {
    const survivorValue = readAttribute(survivor, code);
    const retiredValue = readAttribute(retired, code);
    if (!survivorValue && !retiredValue) continue;
    let status: FieldComparison['status'] = 'conflict';
    if (survivorValue && retiredValue && survivorValue.trim() === retiredValue.trim()) status = 'same';
    else if (survivorValue && !retiredValue) status = 'only_survivor';
    else if (!survivorValue && retiredValue) status = 'only_retired';
    rows.push({ attributeCode: code, survivorValue, retiredValue, status });
  }
  return rows;
}

function readAttribute(entity: MatchableEntity, code: string): string | null {
  for (const [key, value] of Object.entries(entity.attributes || {})) {
    if (key.toUpperCase() !== code) continue;
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return null;
}
