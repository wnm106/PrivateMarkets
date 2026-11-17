/**
 * The fields of a workflow form, and checking answers before they are sent.
 * The database checks the same rules again (ops.workflow_form_check).
 */

export type FieldType = 'text' | 'longtext' | 'number' | 'date' | 'choice' | 'yesno';

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  help?: string;
}

export const FIELD_TYPES: Array<{ type: FieldType; label: string }> = [
  { type: 'text', label: 'Short text' },
  { type: 'longtext', label: 'Long text' },
  { type: 'number', label: 'Number' },
  { type: 'date', label: 'Date' },
  { type: 'choice', label: 'Choice' },
  { type: 'yesno', label: 'Yes or no' },
];

export function asFields(value: unknown): FormField[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((field): field is Record<string, unknown> => Boolean(field) && typeof field === 'object')
    .map((field) => ({
      key: String(field.key ?? ''),
      label: String(field.label || field.key || ''),
      type: (FIELD_TYPES.some((entry) => entry.type === field.type) ? field.type : 'text') as FieldType,
      required: field.required === true,
      options: Array.isArray(field.options) ? field.options.map(String) : undefined,
      help: typeof field.help === 'string' ? field.help : undefined,
    }))
    .filter((field) => field.key);
}

/** The answers as they are sent: numbers as numbers, yes or no as true or false, blanks left out. */
export function normalizeAnswers(fields: FormField[], raw: Record<string, string>): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const field of fields) {
    const text = (raw[field.key] ?? '').trim();
    if (!text) continue;
    if (field.type === 'number') answers[field.key] = Number(text);
    else if (field.type === 'yesno') answers[field.key] = text === 'yes' || text === 'true';
    else answers[field.key] = text;
  }
  return answers;
}

/** What is wrong with the answers, field by field. Empty when they can be sent. */
export function answerProblems(fields: FormField[], raw: Record<string, string>): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const field of fields) {
    const text = (raw[field.key] ?? '').trim();
    if (!text) {
      if (field.required) problems[field.key] = 'Required.';
      continue;
    }
    if (field.type === 'number' && !/^-?\d+(\.\d+)?$/.test(text.replace(/,/g, ''))) problems[field.key] = 'Enter a number.';
    if (field.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`)))) problems[field.key] = 'Enter a date, YYYY-MM-DD.';
    if (field.type === 'choice' && !(field.options || []).includes(text)) problems[field.key] = 'Choose one of the options.';
    if (field.type === 'yesno' && !['yes', 'no', 'true', 'false'].includes(text)) problems[field.key] = 'Choose yes or no.';
  }
  return problems;
}

/** Numbers may be typed with thousands separators; they are sent without. */
export function cleanRaw(fields: FormField[], raw: Record<string, string>): Record<string, string> {
  const out = { ...raw };
  for (const field of fields) if (field.type === 'number' && out[field.key]) out[field.key] = out[field.key].replace(/,/g, '');
  return out;
}
