import { labelsEquivalent, normalizeLabel, titleCaseLabel, toAttributeCode, toSectionCode, tokensOf, jaccard } from './normalize';
import { parseStatementSource } from './parse';
import { SECTION_GROUPS, SYNONYM_GROUPS, type SynonymGroup } from './synonyms';
import type {
  CatalogAttribute,
  ParsedLine,
  ParsedStatement,
  StatementCatalogEntry,
  StatementLineDraft,
  StatementMatchKind,
  StatementSectionDraft,
  StatementSource,
  StatementTemplateDraft,
} from './types';

export interface BuildOptions {
  statementKind?: string;
}

interface ResolvedLine {
  sourceName: string;
  sectionName: string;
  sectionKey: string;
  sectionRank: number;
  lineRank: number;
  label: string;
  value?: string;
  dataType: string;
  attributeCode: string;
  attributeName: string;
  matchKind: StatementMatchKind;
  confidence: number;
  isNew: boolean;
}

export function buildStatementTemplate(
  sources: StatementSource[],
  catalog: CatalogAttribute[],
  options: BuildOptions = {},
): StatementTemplateDraft {
  const warnings: string[] = [];
  const statements = sources.map((source) => {
    const parsed = parseStatementSource(source);
    const lineCount = parsed.sections.reduce((sum, section) => sum + section.lines.length, 0);
    if (!source.text.trim()) warnings.push(`${source.sourceName} is empty.`);
    else if (lineCount === 0) {
      warnings.push(`${source.sourceName} did not contain any statement lines. Use a table, a spreadsheet, or one label and value per line.`);
    }
    return parsed;
  });

  const productiveSources = statements.filter((statement) => statement.sections.some((section) => section.lines.length > 0)).length;
  const resolved = statements.flatMap((statement) => resolveStatement(statement, catalog, options.statementKind));
  const sections = aggregate(resolved, productiveSources);
  if (sections.length === 0 && warnings.length === 0) {
    warnings.push('No sections were found in the supplied statements.');
  }
  const lowConfidence = sections.flatMap((section) => section.lines.filter((line) => line.matchKind === 'alias' && line.confidence < 0.8));
  if (lowConfidence.length > 0) {
    warnings.push(`${lowConfidence.length} alias ${lowConfidence.length === 1 ? 'match needs' : 'matches need'} a look before you save.`);
  }

  return {
    sections,
    warnings,
    catalog: catalog.map(toCatalogEntry),
  };
}

function toCatalogEntry(attribute: CatalogAttribute): StatementCatalogEntry {
  return {
    attributeCode: attribute.attributeCode,
    attributeName: attribute.attributeName,
    dataType: attribute.dataType,
  };
}

function resolveStatement(statement: ParsedStatement, catalog: CatalogAttribute[], statementKind?: string): ResolvedLine[] {
  const used = new Set<string>();
  const resolved: ResolvedLine[] = [];
  statement.sections.forEach((section, sectionIndex) => {
    const sectionKey = canonicalSectionKey(section.name);
    section.lines.forEach((line, lineIndex) => {
      const match = matchLine(line, catalog, used, statementKind);
      used.add(match.attributeCode);
      resolved.push({
        sourceName: statement.sourceName,
        sectionName: displaySectionName(section.name, sectionKey),
        sectionKey,
        sectionRank: sectionIndex + 1,
        lineRank: lineIndex + 1,
        label: line.label.trim(),
        value: line.value,
        dataType: match.dataType,
        attributeCode: match.attributeCode,
        attributeName: match.attributeName,
        matchKind: match.matchKind,
        confidence: match.confidence,
        isNew: match.isNew,
      });
    });
  });
  return resolved;
}

interface LineMatch {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  matchKind: StatementMatchKind;
  confidence: number;
  isNew: boolean;
}

function matchLine(line: ParsedLine, catalog: CatalogAttribute[], used: Set<string>, statementKind?: string): LineMatch {
  const available = (code: string) => !used.has(code);
  const label = line.label.trim();

  const aliasHit = catalog.find((attribute) => available(attribute.attributeCode) && (attribute.aliases || []).some((alias) => labelsEquivalent(alias, label)));
  if (aliasHit) return fromCatalog(aliasHit, line, 'alias', 0.98);

  const exactCode = catalog.find((attribute) => available(attribute.attributeCode) && labelsEquivalent(attribute.attributeCode.replace(/_/g, ' '), label));
  if (exactCode) return fromCatalog(exactCode, line, 'exact', 1);

  const exactName = catalog.find((attribute) => available(attribute.attributeCode) && labelsEquivalent(attribute.attributeName, label));
  if (exactName) return fromCatalog(exactName, line, 'exact', 1);

  const synonym = findSynonym(label, statementKind);
  if (synonym) {
    const existing = catalog.find((attribute) => attribute.attributeCode === synonym.code);
    if (existing && available(existing.attributeCode)) {
      const same = labelsEquivalent(existing.attributeName, label) || labelsEquivalent(existing.attributeCode.replace(/_/g, ' '), label);
      return fromCatalog(existing, line, same ? 'exact' : 'alias', same ? 1 : 0.96);
    }
    if (!existing && available(synonym.code) && kindAllows(synonym, statementKind)) {
      return {
        attributeCode: synonym.code,
        attributeName: synonym.name,
        dataType: preferType(synonym.dataType, line.dataType),
        matchKind: 'new',
        confidence: 0.9,
        isNew: true,
      };
    }
  }

  let best: { attribute: CatalogAttribute; score: number } | null = null;
  for (const attribute of catalog) {
    if (!available(attribute.attributeCode)) continue;
    const score = fuzzyScore(label, attribute);
    if (!best || score > best.score) best = { attribute, score };
  }
  if (best && best.score >= 0.72) {
    return fromCatalog(best.attribute, line, 'alias', roundConfidence(best.score));
  }

  const code = uniqueCode(toAttributeCode(label), used);
  return {
    attributeCode: code,
    attributeName: titleCaseLabel(label),
    dataType: line.dataType || 'STRING',
    matchKind: 'new',
    confidence: 1,
    isNew: true,
  };
}

function fromCatalog(attribute: CatalogAttribute, line: ParsedLine, matchKind: StatementMatchKind, confidence: number): LineMatch {
  const same = labelsEquivalent(attribute.attributeName, line.label) || labelsEquivalent(attribute.attributeCode.replace(/_/g, ' '), line.label);
  return {
    attributeCode: attribute.attributeCode,
    attributeName: attribute.attributeName,
    dataType: attribute.dataType || line.dataType,
    matchKind: same ? 'exact' : matchKind,
    confidence: same ? 1 : confidence,
    isNew: false,
  };
}

function sameTokenSet(left: string, right: string): boolean {
  const a = tokensOf(left).slice().sort().join(' ');
  const b = tokensOf(right).slice().sort().join(' ');
  return a.length > 0 && a === b;
}

function findSynonym(label: string, statementKind?: string): SynonymGroup | undefined {
  const normalized = normalizeLabel(label);
  const matches = SYNONYM_GROUPS.filter((group) => group.phrases.some((phrase) => (
    normalizeLabel(phrase) === normalized || sameTokenSet(phrase, label)
  )));
  if (matches.length === 0) return undefined;
  return matches.find((group) => kindAllows(group, statementKind)) || matches[0];
}

function kindAllows(group: SynonymGroup, statementKind?: string): boolean {
  const kind = (statementKind || '').toUpperCase();
  if (group.kinds.includes('ANY')) return true;
  if (kind === 'NAV') return group.kinds.includes('NAV');
  if (kind === 'FINANCIAL') return group.kinds.includes('FINANCIAL');
  return true;
}

function fuzzyScore(label: string, attribute: CatalogAttribute): number {
  const labelTokens = tokensOf(label);
  const candidates = [attribute.attributeName, attribute.attributeCode.replace(/_/g, ' '), ...(attribute.aliases || [])];
  let best = 0;
  for (const candidate of candidates) {
    const score = jaccard(labelTokens, tokensOf(candidate));
    if (score > best) best = score;
  }
  return best;
}

function preferType(synonymType: string, sampleType: string): string {
  if (sampleType && sampleType !== 'STRING') return sampleType;
  return synonymType;
}

function uniqueCode(code: string, used: Set<string>): string {
  if (!used.has(code)) return code;
  let index = 2;
  while (used.has(`${code}_${index}`)) index += 1;
  return `${code}_${index}`.slice(0, 100);
}

function canonicalSectionKey(name: string): string {
  const normalized = normalizeLabel(name);
  const group = SECTION_GROUPS.find((names) => names.some((item) => normalizeLabel(item) === normalized));
  return group ? normalizeLabel(group[0]) : normalized || 'statement';
}

function displaySectionName(name: string, key: string): string {
  const group = SECTION_GROUPS.find((names) => normalizeLabel(names[0]) === key);
  if (group && normalizeLabel(name) !== key && group.some((item) => normalizeLabel(item) === normalizeLabel(name))) {
    return titleCaseLabel(group[0]);
  }
  return titleCaseLabel(name);
}

function aggregate(lines: ResolvedLine[], sourceCount: number): StatementSectionDraft[] {
  const sections = new Map<string, ResolvedLine[]>();
  for (const line of lines) {
    const bucket = sections.get(line.sectionKey) || [];
    bucket.push(line);
    sections.set(line.sectionKey, bucket);
  }

  const sectionDrafts = [...sections.entries()].map(([key, sectionLines]) => {
    const byAttribute = new Map<string, ResolvedLine[]>();
    for (const line of sectionLines) {
      const bucket = byAttribute.get(line.attributeCode) || [];
      bucket.push(line);
      byAttribute.set(line.attributeCode, bucket);
    }
    const draftedLines = [...byAttribute.entries()].map(([code, occurrences]) => draftLine(code, occurrences, sourceCount));
    draftedLines.sort((left, right) => left.displayOrder - right.displayOrder || left.displayLabel.localeCompare(right.displayLabel));
    draftedLines.forEach((line, index) => {
      line.displayOrder = index + 1;
    });
    return {
      sectionCode: toSectionCode(key),
      sectionName: preferredLabel(sectionLines.map((line) => line.sectionName), titleCaseLabel(key), key) || titleCaseLabel(key),
      displayOrder: average(sectionLines.map((line) => line.sectionRank)),
      firstSeen: Math.min(...sectionLines.map((line) => line.sectionRank)),
      lines: draftedLines,
    };
  });

  sectionDrafts.sort((left, right) => left.displayOrder - right.displayOrder || left.firstSeen - right.firstSeen || left.sectionName.localeCompare(right.sectionName));
  return collapseDuplicateAttributes(sectionDrafts.map((section, index) => ({
    sectionCode: section.sectionCode,
    sectionName: section.sectionName,
    displayOrder: index + 1,
    lines: section.lines,
  })));
}

function collapseDuplicateAttributes(sections: StatementSectionDraft[]): StatementSectionDraft[] {
  const winner = new Map<string, { section: number; line: number }>();
  sections.forEach((section, sectionIndex) => {
    section.lines.forEach((line, lineIndex) => {
      const current = winner.get(line.attributeCode);
      if (!current) {
        winner.set(line.attributeCode, { section: sectionIndex, line: lineIndex });
        return;
      }
      const kept = sections[current.section].lines[current.line];
      const useChallenger = line.sources.length > kept.sources.length;
      const target = useChallenger ? line : kept;
      const other = useChallenger ? kept : line;
      target.aliases = unique([
        ...target.aliases,
        ...other.aliases,
        other.displayLabel,
      ].filter((label) => !labelsEquivalent(label, target.attributeName) && !labelsEquivalent(label, target.attributeCode.replace(/_/g, ' '))));
      target.sources = unique([...target.sources, ...other.sources]);
      target.required = target.required || other.required;
      if (useChallenger) winner.set(line.attributeCode, { section: sectionIndex, line: lineIndex });
    });
  });

  return sections
    .map((section, sectionIndex) => ({
      ...section,
      lines: section.lines
        .filter((line, lineIndex) => {
          const keep = winner.get(line.attributeCode);
          return keep?.section === sectionIndex && keep.line === lineIndex;
        })
        .map((line, lineIndex) => ({ ...line, displayOrder: lineIndex + 1 })),
    }))
    .filter((section) => section.lines.length > 0)
    .map((section, index) => ({ ...section, displayOrder: index + 1 }));
}

function draftLine(code: string, occurrences: ResolvedLine[], sourceCount: number): StatementLineDraft {
  const first = occurrences[0];
  const labels = occurrences.map((line) => line.label);
  const displayLabel = preferredLabel(labels, first.attributeName, first.attributeCode);
  const aliases = unique(labels.filter((label) => !labelsEquivalent(label, first.attributeName) && !labelsEquivalent(label, first.attributeCode.replace(/_/g, ' '))));
  const sources = unique(occurrences.map((line) => line.sourceName));
  const matchKind = first.isNew ? 'new' : aliases.length > 0 ? 'alias' : 'exact';
  const sample = occurrences.find((line) => line.value)?.value || null;
  return {
    attributeCode: code,
    attributeName: first.attributeName,
    dataType: first.dataType,
    displayOrder: average(occurrences.map((line) => line.lineRank)),
    displayLabel,
    matchKind,
    confidence: roundConfidence(Math.min(...occurrences.map((line) => line.confidence))),
    isNew: first.isNew,
    required: sourceCount > 0 && sources.length === sourceCount,
    aliases,
    sampleValue: sample,
    sources,
  };
}

function preferredLabel(labels: string[], canonicalName: string, canonicalCode: string): string {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const topCount = ranked[0]?.[1] || 0;
  const tied = ranked.filter((entry) => entry[1] === topCount).map((entry) => entry[0]);
  const canonical = tied.find((label) => labelsEquivalent(label, canonicalName) || labelsEquivalent(label, canonicalCode.replace(/_/g, ' ')));
  return canonical || tied[0] || canonicalName;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = normalizeLabel(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function roundConfidence(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function retargetLine(
  line: StatementLineDraft,
  attribute: CatalogAttribute | null,
): StatementLineDraft {
  if (!attribute) {
    const code = toAttributeCode(line.displayLabel);
    return {
      ...line,
      attributeCode: code,
      attributeName: titleCaseLabel(line.displayLabel),
      matchKind: 'new',
      isNew: true,
      confidence: 1,
      aliases: [],
    };
  }
  const same = labelsEquivalent(attribute.attributeName, line.displayLabel) || labelsEquivalent(attribute.attributeCode.replace(/_/g, ' '), line.displayLabel);
  const aliases = same ? [] : unique([line.displayLabel, ...line.aliases]);
  return {
    ...line,
    attributeCode: attribute.attributeCode,
    attributeName: attribute.attributeName,
    dataType: attribute.dataType || line.dataType,
    matchKind: same ? 'exact' : 'manual',
    isNew: false,
    confidence: 1,
    aliases,
  };
}
