import { invokeAgent } from '../agent/harness';
import { geminiAnswerText } from '../agent/usage';
import { GEMINI_MODEL, geminiKey } from './model';
import {
  domainLabel,
  promoteNamesToIdentity,
  sampleFit,
  suggestTransform,
  type AttributeChoice,
  type ColumnAssignment,
} from './suggest';

/**
 * A second reader for the column mapping. The first pass matches names. This one
 * reads the whole table the way a person would: what the document is, what each
 * column's values are, and which record each column describes.
 *
 * It looks at every column that is not already a confirmed match (a saved map or
 * the user's own choice). Its answer is checked against the catalog and against
 * the values before it is used, and it never confirms a column on its own: two
 * independent readings must agree for a column to be confirmed without a person.
 */

export interface ReviewContext {
  fileName?: string;
  /** How the file was read, such as "LlamaParse found 1 table." */
  note?: string | null;
  rowCount?: number;
}

export interface ModelColumn {
  column: string;
  role: string;
  domainCode?: string | null;
  attributeCode?: string | null;
  confidence?: number;
  reason?: string;
}

const REVIEWED_ROLES = new Set(['identity', 'name', 'attribute', 'ignore']);
/** Roles the name pass sets from fixed rules. The model does not second-guess them. */
const FIXED_ROLES = new Set(['as_of', 'source', 'filter', 'parent']);
const CONFIRMED_METHODS = new Set(['source_map', 'manual']);

/** The most a column can claim from the model alone. Under the 0.8 confirmation threshold. */
const MODEL_ALONE = 0.78;
/** The most a column can claim when the name pass and the model agree. */
const BOTH_AGREE = 0.95;
const AGREE_FLOOR = 0.7;

/** Distinct values shown to the model for each column, at most and at least. */
const MAX_VALUES = 50;
const MIN_VALUES = 5;
/** Across all columns. A file with 30 columns shows 50 each; one with 300 shows 5. */
const VALUE_BUDGET = 1500;

export function modelValues(assignment: ColumnAssignment, limit: number): string[] {
  const source = assignment.distinctValues?.length ? assignment.distinctValues.map((item) => item.value) : assignment.samples;
  return source.slice(0, limit).map((value) => (value.length > 40 ? `${value.slice(0, 40)}...` : value));
}

export function needsReview(assignment: ColumnAssignment): boolean {
  if (CONFIRMED_METHODS.has(assignment.suggestion.method)) return false;
  if (FIXED_ROLES.has(assignment.role)) return false;
  return true;
}

export function buildPrompt(
  assignments: ColumnAssignment[],
  attributes: AttributeChoice[],
  domains: string[],
  context: ReviewContext,
): string {
  // The model reads the values to tell what a column is. Up to 50 distinct values each, most common first,
  // fewer on a wide file so the request stays a few thousand tokens.
  const perColumn = Math.min(MAX_VALUES, Math.max(MIN_VALUES, Math.floor(VALUE_BUDGET / Math.max(assignments.length, 1))));
  const columns = assignments.map((assignment) => ({
    column: assignment.sourceColumn,
    values: modelValues(assignment, perColumn),
    distinctValues: assignment.distinctCount ?? null,
    nameMatchGuess: assignment.role === 'ignore'
      ? null
      : `${assignment.role} ${assignment.domainCode || ''} ${assignment.attributeCode || ''}`.trim(),
  }));
  const fields = attributes
    .filter((attribute) => attribute.domainCode && domains.includes(attribute.domainCode))
    .slice(0, 700)
    .map((attribute) => {
      const aka = (attribute.aliasLabels || []).slice(0, 4).join(', ');
      return `${attribute.domainCode}|${attribute.attributeCode}|${attribute.attributeName}|${attribute.dataType}${aka ? `|${aka}` : ''}`;
    });
  return [
    'You map the columns of an uploaded table onto a catalog of fields for an investment data platform.',
    context.fileName ? `The file is "${context.fileName}".` : '',
    context.note ? `How it was read: ${context.note}` : '',
    context.rowCount ? `It has ${context.rowCount} rows.` : '',
    `Record types: ${domains.join(', ')}.`,
    '',
    'Rules:',
    '- Judge each column by what its values mean, not only by its header. A column of loan names is the name of a loan, not an amount.',
    '- A record type needs one identity column: the one whose value tells one record of that type from another (a name or a code).',
    '- A field belongs to the record type it is listed under. Pick a field only from the list, using its exact code.',
    '- A column of numbers needs a numeric field. A column of dates needs a date field. Text needs a text field.',
    '- Use role "ignore" when no listed field fits. Do not invent fields.',
    '- Give a confidence from 0 to 1 and a reason of at most 20 plain words.',
    '',
    `Columns (JSON): ${JSON.stringify(columns)}`,
    '',
    'Fields (record type|code|name|data type):',
    fields.join('\n'),
    '',
    'Answer with JSON only, in this shape:',
    '{"columns":[{"column":"exact column name","role":"identity|name|attribute|ignore","domainCode":"RECORD_TYPE","attributeCode":"CODE or null","confidence":0.0,"reason":"..."}]}',
  ].filter((line) => line !== '').join('\n');
}

export function parseModelAnswer(text: string): Map<string, ModelColumn> {
  const answers = new Map<string, ModelColumn>();
  // Take whichever of an object or an array opens first, so a bare list is not mistaken for its first item.
  const open = text.search(/[\[{]/);
  if (open < 0) return answers;
  const close = text.lastIndexOf(text[open] === '[' ? ']' : '}');
  if (close < open) return answers;
  try {
    const parsed = JSON.parse(text.slice(open, close + 1));
    const list: unknown = Array.isArray(parsed) ? parsed : parsed?.columns;
    if (!Array.isArray(list)) return answers;
    for (const item of list) {
      if (!item || typeof item !== 'object' || typeof (item as ModelColumn).column !== 'string') continue;
      answers.set((item as ModelColumn).column, item as ModelColumn);
    }
  } catch {
    // An answer that is not JSON is ignored. The name pass stands.
  }
  return answers;
}

function valuesOf(assignment: ColumnAssignment): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const value of [...assignment.samples, ...(assignment.distinctValues || []).map((item) => item.value)]) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    values.push(trimmed);
    if (values.length >= 50) break;
  }
  return values;
}

function clamp(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, 0), 1) : fallback;
}

function sameReading(assignment: ColumnAssignment, pick: { role: string; domainCode: string | null; attributeCode: string | null }): boolean {
  return assignment.role === pick.role
    && (assignment.domainCode || null) === pick.domainCode
    && (assignment.attributeCode || null) === pick.attributeCode;
}

/**
 * Combine the model's reading with the name pass. Anything the model says that is
 * not in the catalog, or does not fit the column's values, is dropped.
 */
export function mergeSemanticAnswer(
  assignments: ColumnAssignment[],
  answers: Map<string, ModelColumn>,
  attributes: AttributeChoice[],
  domains: string[],
): ColumnAssignment[] {
  const identified = new Set(assignments.filter((assignment) => assignment.role === 'identity' && assignment.domainCode).map((assignment) => assignment.domainCode as string));
  const merged = assignments.map((assignment) => {
    if (!needsReview(assignment)) return assignment;
    const answer = answers.get(assignment.sourceColumn);
    if (!answer || !REVIEWED_ROLES.has(answer.role)) return assignment;

    const modelConfidence = clamp(answer.confidence, 0.6);
    const said = String(answer.reason || '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim().slice(0, 220);

    if (answer.role === 'ignore') {
      if (assignment.role === 'ignore') return assignment;
      return {
        ...assignment,
        suggestion: {
          method: 'ai' as const,
          confidence: Math.min(assignment.suggestion.confidence, 0.7),
          reason: `${assignment.suggestion.reason} The AI review found no field that fits these values${said ? `: ${said}` : '.'}`,
        },
      };
    }

    const domainCode = answer.domainCode && domains.includes(answer.domainCode) ? answer.domainCode : null;
    if (!domainCode) return assignment;
    const attribute = answer.role === 'attribute'
      ? attributes.find((item) => item.attributeCode === answer.attributeCode && (!item.domainCode || item.domainCode === domainCode))
      : null;
    if (answer.role === 'attribute' && !attribute) return assignment;
    if (attribute && sampleFit(valuesOf(assignment), attribute.dataType) < 0.5) return assignment;

    const pick = { role: answer.role, domainCode, attributeCode: attribute ? attribute.attributeCode : null };
    if (sameReading(assignment, pick)) {
      // Agreement does not make a field on an unidentified record safe. The load would still have no record to put it on.
      if (modelConfidence < AGREE_FLOOR || (identified.size > 0 && pick.role === 'attribute' && !identified.has(domainCode))) return assignment;
      return {
        ...assignment,
        suggestion: {
          method: 'ai' as const,
          confidence: Math.max(assignment.suggestion.confidence, Math.min(modelConfidence, BOTH_AGREE)),
          reason: `${assignment.suggestion.reason} The AI review reads it the same way.`,
        },
      };
    }

    const guess = assignment.role === 'ignore'
      ? 'The name match found nothing'
      : `The name match suggested ${assignment.role === 'attribute' ? assignment.attributeCode : assignment.role} on the ${domainLabel(assignment.domainCode).toLowerCase()}`;
    return {
      ...assignment,
      role: pick.role as ColumnAssignment['role'],
      domainCode,
      attributeCode: pick.attributeCode,
      transform: attribute ? suggestTransform(assignment.samples, attribute.dataType, attribute.referenceListCode) : { kind: 'trim' as const },
      suggestion: {
        method: 'ai' as const,
        confidence: Math.min(modelConfidence, MODEL_ALONE),
        reason: `AI review: ${said || 'this reading fits the values'}. ${guess}. Confirm which is right.`,
      },
    };
  });
  return promoteNamesToIdentity(demoteExtraIdentities(merged));
}

/** One identity column per record type. The most confident keeps it. The rest become names. */
function demoteExtraIdentities(assignments: ColumnAssignment[]): ColumnAssignment[] {
  const best = new Map<string, ColumnAssignment>();
  for (const assignment of assignments) {
    if (assignment.role !== 'identity' || !assignment.domainCode) continue;
    const current = best.get(assignment.domainCode);
    if (!current || assignment.suggestion.confidence > current.suggestion.confidence) best.set(assignment.domainCode, assignment);
  }
  return assignments.map((assignment) => {
    if (assignment.role !== 'identity' || !assignment.domainCode || best.get(assignment.domainCode) === assignment) return assignment;
    return { ...assignment, role: 'name' as const, suggestion: { ...assignment.suggestion, confidence: Math.min(assignment.suggestion.confidence, 0.7) } };
  });
}

/** Ask the model and merge its answer. Without a key, or if the call fails, the name pass stands. */
export async function reviewColumns(
  assignments: ColumnAssignment[],
  attributes: AttributeChoice[],
  domains: string[],
  context: ReviewContext = {},
  fetchImpl: typeof fetch = fetch,
  key: string = geminiKey(),
): Promise<ColumnAssignment[]> {
  if (!key) return assignments;
  const reviewable = assignments.filter(needsReview);
  if (reviewable.length === 0) return assignments;
  try {
    const { response } = await invokeAgent({
      provider: 'gemini',
      model: GEMINI_MODEL,
      feature: 'feed-intake',
      activity: 'feed.semantic-review',
      apiKey: key,
      fetchImpl,
      signal: AbortSignal.timeout(40000),
      body: {
        contents: [{ parts: [{ text: buildPrompt(reviewable, attributes, domains, context) }] }],
        // A little thinking helps with meaning. Unbounded thinking took 11 seconds on a 700-field catalog; 512 tokens keeps it to a few.
        generationConfig: { responseMimeType: 'application/json', temperature: 0, thinkingConfig: { thinkingBudget: 512 } },
      },
    });
    const text = geminiAnswerText(response);
    return mergeSemanticAnswer(assignments, parseModelAnswer(text), attributes, domains);
  } catch {
    return assignments;
  }
}
