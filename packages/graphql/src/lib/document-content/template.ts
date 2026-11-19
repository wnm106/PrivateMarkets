/**
 * Document templates: the sections a kind of document is expected to have.
 *
 * A template is drawn from the headings of one or more documents, refined by a
 * person, and then used to tag the headings of every document of that kind.
 * Headings are compared by their words, so "7.1 Financial Condition Covenants"
 * and "Section 6.12. Financial Covenants" land on the same section.
 */

import type { MatchMethod, Section, SectionMatch, TemplateSection } from './types';

const STOP_WORDS = new Set(['of', 'the', 'and', 'at', 'for', 'a', 'an', 'to', 'in', 'on', 'or', 'by', 'with', 'etc', 'other', 'certain']);

/** A heading without its number or label: "SECTION 7 NEGATIVE COVENANTS" is "negative covenants". */
export function headingLabel(heading: string): string {
  // "SCHEDULE 1.1B EXISTING LETTERS OF CREDIT" stays a schedule, so it is not taken for the section on letters of credit.
  const annex = /^(exhibit|schedule|annex|appendix)\s+[a-z0-9][a-z0-9.()-]*\s*[.:-]?\s*(.*)$/i.exec(heading.trim());
  if (annex) {
    const kind = annex[1].charAt(0).toUpperCase() + annex[1].slice(1).toLowerCase();
    return annex[2] ? `${kind}: ${annex[2].replace(/\s+/g, ' ').trim()}` : heading.trim();
  }
  return heading
    .replace(/^(section|article|part)\s+[a-z0-9][a-z0-9.()-]*\s*[.:-]?\s*/i, '')
    .replace(/^\d+(\.\d+)*\.?\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function headingTokens(heading: string): string[] {
  return normalize(headingLabel(heading)).split(' ').filter((token) => token && !STOP_WORDS.has(token)).map(stem);
}

/** A key that is the same for headings that differ only in number, case, plurals and small words. */
export function headingKey(heading: string): string {
  return headingTokens(heading).join(' ');
}

/** Shared words over all words, from 0 to 1. */
export function headingSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const shared = new Set(left.filter((token) => rightSet.has(token))).size;
  return shared / (new Set(left).size + rightSet.size - shared);
}

export function sectionCode(title: string): string {
  const code = normalize(title).toUpperCase().replace(/ /g, '_').slice(0, 60).replace(/_+$/, '');
  return code || 'SECTION';
}

function titleCase(value: string): string {
  if (value !== value.toUpperCase()) return value;
  return value.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, lead: string, letter: string) => lead + letter.toUpperCase())
    .replace(/\b(Of|The|And|To|In|On|Or|For|By|With|A|An)\b/g, (word, offset: number) => (offset === 0 ? word : word.toLowerCase()));
}

/** A heading that holds nothing: "[Reserved]", "Intentionally Omitted". */
export function isPlaceholder(heading: string): boolean {
  return /^\[?\s*(reserved|intentionally (omitted|deleted|left blank))\s*\]?\.?$/i.test(headingLabel(heading));
}

export interface DocumentOutline {
  documentId: string;
  sections: Array<Pick<Section, 'seq' | 'parentSeq' | 'level' | 'heading'>>;
}

function labelsOf(section: TemplateSection): string[] {
  return [section.title, ...section.aliases];
}

/** The best template section for one heading among the candidates, by its words alone. */
function matchByWords(heading: string, candidates: TemplateSection[]): { section: TemplateSection; method: MatchMethod; score: number } | null {
  const key = headingKey(heading);
  if (!key) return null;
  for (const section of candidates) {
    if (headingKey(section.title) === key) return { section, method: 'EXACT', score: 1 };
  }
  for (const section of candidates) {
    if (section.aliases.some((alias) => headingKey(alias) === key)) return { section, method: 'ALIAS', score: 1 };
  }
  const tokens = headingTokens(heading);
  let best: { section: TemplateSection; score: number } | null = null;
  for (const section of candidates) {
    const score = Math.max(...labelsOf(section).map((label) => headingSimilarity(tokens, headingTokens(label))));
    if (!best || score > best.score) best = { section, score };
  }
  return best && best.score >= 0.6 ? { section: best.section, method: 'SIMILAR', score: Math.round(best.score * 10000) / 10000 } : null;
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    a += left[i] * left[i];
    b += right[i] * right[i];
  }
  return a === 0 || b === 0 ? 0 : dot / Math.sqrt(a * b);
}

/** The text a heading or a template label is embedded as, and the key its vector is kept under. */
export function labelText(label: string): string {
  return headingLabel(label) || label;
}

export interface MatchOptions {
  /** Vectors by labelText, for headings the words did not place. Missing vectors are skipped. */
  vectors?: Map<string, number[]>;
  /** How alike two vectors must be. */
  minSimilarity?: number;
}

/**
 * Places each heading of a document on a template section. A top heading is
 * matched against the template's top sections. A heading below it is matched
 * against that section's children first, then against every child.
 */
export function matchSections(
  sections: Array<Pick<Section, 'seq' | 'parentSeq' | 'level' | 'heading'>>,
  template: TemplateSection[],
  options: MatchOptions = {},
): SectionMatch[] {
  const minSimilarity = options.minSimilarity ?? 0.8;
  const tops = template.filter((section) => !section.parentCode);
  const childrenOf = (code: string) => template.filter((section) => section.parentCode === code);
  const allChildren = template.filter((section) => section.parentCode);
  const matches = new Map<number, SectionMatch>();

  const byMeaning = (heading: string, candidates: TemplateSection[]) => {
    const vector = options.vectors?.get(labelText(heading));
    if (!vector) return null;
    let best: { section: TemplateSection; score: number } | null = null;
    for (const section of candidates) {
      for (const label of labelsOf(section)) {
        const other = options.vectors?.get(labelText(label));
        if (!other) continue;
        const score = cosine(vector, other);
        if (!best || score > best.score) best = { section, score };
      }
    }
    return best && best.score >= minSimilarity
      ? { section: best.section, method: 'EMBEDDING' as MatchMethod, score: Math.round(best.score * 10000) / 10000 }
      : null;
  };

  for (const section of sections) {
    if (isPlaceholder(section.heading)) continue;
    const parentMatch = section.parentSeq === null ? undefined : matches.get(section.parentSeq);
    const pools: TemplateSection[][] = section.level === 1 || section.parentSeq === null
      ? [tops]
      : [parentMatch ? childrenOf(parentMatch.code) : [], allChildren];
    let found: { section: TemplateSection; method: MatchMethod; score: number } | null = null;
    for (const pool of pools) {
      if (pool.length === 0) continue;
      found = matchByWords(section.heading, pool);
      if (found) break;
    }
    if (!found) {
      for (const pool of pools) {
        if (pool.length === 0) continue;
        found = byMeaning(section.heading, pool);
        if (found) break;
      }
    }
    if (found) matches.set(section.seq, { seq: section.seq, code: found.section.code, method: found.method, score: found.score });
  }
  return [...matches.values()];
}

/** The labels whose vectors matchSections can use: template labels, and the headings words did not place. */
export function labelsToEmbed(
  sections: Array<Pick<Section, 'seq' | 'parentSeq' | 'level' | 'heading'>>,
  template: TemplateSection[],
): string[] {
  const placed = new Set(matchSections(sections, template).map((match) => match.seq));
  const open = sections.filter((section) => !placed.has(section.seq) && !isPlaceholder(section.heading));
  if (open.length === 0) return [];
  const labels = new Set<string>();
  for (const section of open) labels.add(labelText(section.heading));
  for (const section of template) for (const label of labelsOf(section)) labels.add(labelText(label));
  return [...labels].filter(Boolean);
}

/**
 * Adds what the outlines have that the template does not. Headings the template
 * already covers add an alias when they are worded differently. Headings it
 * does not cover are grouped across the documents and added as new sections.
 * Nothing a person set on an existing section is changed.
 */
export function extendTemplate(base: TemplateSection[], outlines: DocumentOutline[]): TemplateSection[] {
  const result: TemplateSection[] = base.map((section) => ({ ...section, aliases: [...section.aliases], tags: [...section.tags] }));
  const codes = new Set(result.map((section) => section.code));
  const seenBy = new Map<string, Set<string>>();
  const positions = new Map<string, number[]>();

  const uniqueCode = (title: string, parentCode: string | null) => {
    let code = sectionCode(title);
    if (codes.has(code) && parentCode) code = `${parentCode}_${code}`.slice(0, 90);
    const stemCode = code;
    for (let n = 2; codes.has(code); n += 1) code = `${stemCode}_${n}`;
    codes.add(code);
    return code;
  };

  const note = (section: TemplateSection, documentId: string, heading: string, position: number) => {
    if (!seenBy.has(section.code)) seenBy.set(section.code, new Set());
    seenBy.get(section.code)!.add(documentId);
    if (!positions.has(section.code)) positions.set(section.code, []);
    positions.get(section.code)!.push(position);
    const label = titleCase(headingLabel(heading));
    if (label && headingKey(label) !== headingKey(section.title) && !section.aliases.some((alias) => headingKey(alias) === headingKey(label))) {
      section.aliases.push(label);
    }
  };

  for (const outline of outlines) {
    const placed = new Map<number, TemplateSection>();
    const claimed = new Set<string>();
    const total = Math.max(outline.sections.length, 1);
    outline.sections.forEach((section, index) => {
      if (isPlaceholder(section.heading)) return;
      const label = titleCase(headingLabel(section.heading));
      if (!headingKey(label)) return;
      const parent = section.parentSeq === null ? null : placed.get(section.parentSeq) || null;
      // A heading below a top heading that was itself left out has nowhere to go.
      if (section.parentSeq !== null && !parent) return;
      const pool = parent ? result.filter((candidate) => candidate.parentCode === parent.code) : result.filter((candidate) => !candidate.parentCode);
      // Two headings of one document are two sections, however alike their wording: "Limited Partners" and
      // "Additional Limited Partners" are different articles. Only the same wording may land on a section twice.
      const found = matchByWords(section.heading, pool);
      let target = found && !(found.method === 'SIMILAR' && claimed.has(found.section.code)) ? found.section : null;
      if (!target) {
        target = {
          code: uniqueCode(label, parent ? parent.code : null),
          title: label,
          parentCode: parent ? parent.code : null,
          aliases: [],
          tags: [],
          guidance: '',
          required: false,
          order: 0,
          seenIn: 0,
        };
        result.push(target);
      }
      placed.set(section.seq, target);
      claimed.add(target.code);
      note(target, outline.documentId, section.heading, index / total);
    });
  }

  for (const section of result) {
    const seen = seenBy.get(section.code)?.size || 0;
    section.seenIn = Math.max(section.seenIn, seen);
  }

  // New sections go where the documents had them; existing ones keep their place.
  const baseCodes = new Set(base.map((section) => section.code));
  const average = (code: string) => {
    const values = positions.get(code) || [];
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 1;
  };
  const ordered = (parentCode: string | null) => {
    const siblings = result.filter((section) => (section.parentCode || null) === parentCode);
    const kept = siblings.filter((section) => baseCodes.has(section.code)).sort((a, b) => a.order - b.order);
    const added = siblings.filter((section) => !baseCodes.has(section.code)).sort((a, b) => average(a.code) - average(b.code));
    return [...kept, ...added];
  };
  const out: TemplateSection[] = [];
  let order = 0;
  for (const top of ordered(null)) {
    order += 1;
    out.push({ ...top, order });
    for (const child of ordered(top.code)) {
      order += 1;
      out.push({ ...child, order });
    }
  }
  return out;
}

/** A first template from the headings of one or more documents. A section every document has is marked required. */
export function generateTemplate(outlines: DocumentOutline[]): TemplateSection[] {
  const sections = extendTemplate([], outlines);
  if (outlines.length < 2) return sections;
  return sections.map((section) => ({ ...section, required: section.seenIn === outlines.length }));
}

/** Makes stored sections safe to use: known fields, right types, parents that exist. */
export function cleanTemplateSections(value: unknown): TemplateSection[] {
  if (!Array.isArray(value)) return [];
  const strings = (input: unknown) => (Array.isArray(input) ? input.map((item) => String(item).trim()).filter(Boolean) : []);
  const sections: TemplateSection[] = [];
  const codes = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const title = String(row.title || '').trim();
    const code = String(row.code || '').trim() || sectionCode(title);
    if (!title || codes.has(code)) continue;
    codes.add(code);
    sections.push({
      code,
      title,
      parentCode: row.parentCode ? String(row.parentCode) : null,
      aliases: strings(row.aliases),
      tags: strings(row.tags).map((tag) => tag.toLowerCase()),
      guidance: String(row.guidance || '').trim(),
      required: row.required === true,
      order: Number(row.order) || sections.length + 1,
      seenIn: Number(row.seenIn) || 0,
    });
  }
  for (const section of sections) {
    const parent = section.parentCode ? sections.find((other) => other.code === section.parentCode) : null;
    // Two levels only: a parent that is missing, is the section itself, or has its own parent is dropped.
    if (!parent || parent.code === section.code || parent.parentCode) section.parentCode = null;
  }
  return sections.sort((a, b) => a.order - b.order);
}
