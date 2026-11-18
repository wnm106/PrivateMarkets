/**
 * Refinement: what is done for a passage whose own words say little.
 *
 * A table of lenders and amounts, a signature block or a list of addresses has
 * no sentence in it. Its vector means little and a question shares few words
 * with it. Such a passage is marked thin, and a model writes one sentence
 * saying what it holds and picks its topics from the template's list. Both go
 * into the search index beside the passage. Neither is ever the citation.
 *
 * Topics are the subjects a kind of document covers. They cut across sections,
 * and each has a vector, as each top section has, that a search question is
 * compared with (see document_search).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { batchesOf, embedPatiently, vectorLiteral, type EmbedConfig, type EmbedPacing } from './embed';
import type { ChunkKind, TemplateSection, TemplateTopic } from './types';

const FUNCTION_WORDS = new Set([
  'the', 'of', 'and', 'to', 'in', 'a', 'an', 'or', 'by', 'for', 'with', 'as', 'at', 'on', 'be', 'is', 'are', 'was', 'were', 'been',
  'shall', 'will', 'may', 'any', 'such', 'that', 'this', 'which', 'not', 'no', 'its', 'it', 'if', 'from', 'under', 'has', 'have',
  'each', 'all', 'other', 'than', 'then', 'so', 'but', 'upon', 'into', 'their', 'there', 'who', 'whose', 'when', 'where',
]);

/**
 * True for a passage that is mostly names, numbers and labels. Ordinary legal
 * prose is about four function words in ten; a table or a signature block is
 * well under two.
 */
export function isThin(text: string, kind: ChunkKind): boolean {
  if (kind === 'TABLE') return true;
  if (text.length < 40) return false;
  // "By:", "Name:", "Title:": when half the lines are a label and a value, it is a form, whatever sentence introduces it.
  const lines = text.split('\n');
  const labelled = lines.filter((line) => line.length < 120 && /^[A-Z][A-Za-z /&.'-]{0,30}:\s/.test(line)).length;
  if (lines.length >= 3 && labelled / lines.length >= 0.5) return true;
  const words = text.toLowerCase().match(/[a-z][a-z']*/g) || [];
  if (words.length < 6) return true;
  const share = words.filter((word) => FUNCTION_WORDS.has(word)).length / words.length;
  return share < 0.18;
}

const CREDIT_AGREEMENT_TOPICS: Array<[string, string, string]> = [
  ['PARTIES', 'Parties', 'Who the borrower, guarantors, agents and arrangers are, and the capacity each acts in.'],
  ['LENDERS', 'Lenders', 'Who the lenders are, the lender group or club, and how much each has committed.'],
  ['FACILITY_SIZE', 'Facility size and commitments', 'The amount of the facility, each commitment and sublimit, and how the facility can be increased or reduced.'],
  ['PRICING', 'Pricing', 'Interest rates, applicable margins, benchmark rates and the pricing grid.'],
  ['FEES', 'Fees', 'Commitment, upfront, agency and letter of credit fees.'],
  ['MATURITY_AND_REPAYMENT', 'Maturity and repayment', 'When the loans fall due, scheduled repayment, and voluntary and mandatory prepayment.'],
  ['FINANCIAL_COVENANTS', 'Financial covenants', 'Leverage, interest coverage and other ratios the borrower must keep, and their levels.'],
  ['RESTRICTIONS', 'Restrictions on the borrower', 'Limits on debt, liens, investments, asset sales, dividends and other restricted payments.'],
  ['COLLATERAL_AND_GUARANTEES', 'Collateral and guarantees', 'What secures the loans, who guarantees them, and when security is released.'],
  ['LETTERS_OF_CREDIT', 'Letters of credit', 'Letters of credit issued or outstanding, their amounts, beneficiaries and expiry.'],
  ['REPORTING', 'Reporting', 'Financial statements, certificates and notices the borrower must deliver, and when.'],
  ['CONDITIONS', 'Conditions', 'What must be delivered or true before closing and before each borrowing.'],
  ['DEFAULTS_AND_REMEDIES', 'Defaults and remedies', 'Events of default, grace periods, and what the lenders may do after one.'],
  ['TRANSFERS', 'Assignments and transfers', 'How a lender may assign or sell down its position, and the consents needed.'],
  ['NOTICES_AND_CONTACTS', 'Notices and contacts', 'Addresses and contacts for notices to each party.'],
  ['SIGNATURES', 'Signatures', 'Who signed for each party, and in what capacity.'],
];

const GENERAL_TOPICS: Array<[string, string, string]> = [
  ['PARTIES', 'Parties', 'Who the parties to the document are, and the capacity each acts in.'],
  ['AMOUNTS', 'Amounts and commitments', 'Sums committed, invested, owed or allocated, and who each belongs to.'],
  ['FEES_AND_ECONOMICS', 'Fees and economics', 'Fees, rates, carried interest and other economic terms.'],
  ['KEY_DATES', 'Key dates', 'Effective dates, terms, deadlines and expiry.'],
  ['NOTICES_AND_CONTACTS', 'Notices and contacts', 'Addresses and contacts for notices to each party.'],
  ['SIGNATURES', 'Signatures', 'Who signed for each party, and in what capacity.'],
];

/** The topics a new template for this type starts with. A person changes them from there. */
export function defaultTopics(typeCode: string | null | undefined): TemplateTopic[] {
  const rows = typeCode === 'CREDIT_AGREEMENT' ? CREDIT_AGREEMENT_TOPICS : GENERAL_TOPICS;
  return rows.map(([code, title, description]) => ({ code, title, description }));
}

/** Makes stored topics safe to use: a code and a title each, no code twice. */
export function cleanTopics(value: unknown): TemplateTopic[] {
  if (!Array.isArray(value)) return [];
  const topics: TemplateTopic[] = [];
  const codes = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const title = String(row.title || '').trim();
    const code = (String(row.code || '').trim() || title).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    if (!title || !code || codes.has(code)) continue;
    codes.add(code);
    topics.push({ code, title, description: String(row.description || '').trim() });
  }
  return topics;
}

/** One thin passage, with what a reader would see around it. */
export interface RefineRequest {
  id: string;
  kind: string;
  text: string;
  /** The headings above the passage. */
  path: string;
  /** The end of the passage before it, which often introduces a table. */
  before: string | null;
}

export interface RefineContext {
  documentTitle: string;
  typeName: string;
  topics: TemplateTopic[];
}

export interface RefineResult {
  id: string;
  summary: string;
  topics: string[];
}

/**
 * Describes thin passages. Supplied by whoever runs the pipeline (the worker
 * uses Claude), so this library calls no model itself. A passage it cannot
 * describe is left out of the result and tried again on the next run.
 */
export type Refiner = (requests: RefineRequest[], context: RefineContext) => Promise<RefineResult[]>;

/** Keeps a model's answer within bounds: one short description, and only topics the template has. */
export function cleanRefineResult(result: RefineResult, topics: TemplateTopic[]): RefineResult {
  const known = new Set(topics.map((topic) => topic.code));
  return {
    id: result.id,
    summary: String(result.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    topics: [...new Set((result.topics || []).map((code) => String(code).toUpperCase()))].filter((code) => known.has(code)).slice(0, 4),
  };
}

/** What a route is embedded as: the label and what it covers. */
export function routeTexts(topics: TemplateTopic[], sections: TemplateSection[]): Array<{ kind: 'TOPIC' | 'SECTION'; code: string; text: string }> {
  return [
    ...topics.map((topic) => ({ kind: 'TOPIC' as const, code: topic.code, text: `${topic.title}. ${topic.description}`.trim() })),
    ...sections.filter((section) => !section.parentCode).map((section) => ({
      kind: 'SECTION' as const,
      code: section.code,
      text: [section.title, ...section.aliases, section.guidance].filter(Boolean).join('. '),
    })),
  ];
}

/**
 * Gives a template's topics and top sections their vectors, which search
 * compares a question with. Does nothing when they are already there, unless
 * forced. Returns how many routes the template now has.
 */
export async function ensureTemplateRoutes(
  supabase: SupabaseClient,
  templateId: string,
  embed: EmbedConfig,
  options: EmbedPacing & { force?: boolean } = {},
): Promise<number> {
  const { data, error } = await supabase.rpc('document_template_route_labels', { p_template_id: templateId });
  if (error) throw new Error(error.message);
  const labels = data as { topics: unknown; sections: TemplateSection[]; route_count: number } | null;
  if (!labels) return 0;
  if (!options.force && Number(labels.route_count) > 0) return Number(labels.route_count);
  const routes = routeTexts(cleanTopics(labels.topics), labels.sections || []).filter((route) => route.text);
  if (routes.length === 0) return 0;
  const rows: Array<{ kind: string; code: string; embedding: string }> = [];
  for (const batch of batchesOf(routes)) {
    const vectors = await embedPatiently(batch.map((route) => route.text), 'document', embed, options);
    batch.forEach((route, index) => rows.push({ kind: route.kind, code: route.code, embedding: vectorLiteral(vectors[index]) }));
  }
  const saved = await supabase.rpc('document_template_routes_save', { p_template_id: templateId, p_rows: rows });
  if (saved.error) throw new Error(saved.error.message);
  return Number(saved.data) || 0;
}
