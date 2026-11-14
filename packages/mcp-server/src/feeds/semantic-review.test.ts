import { describe, expect, it } from 'vitest';
import { buildPrompt, mergeSemanticAnswer, modelValues, parseModelAnswer, reviewColumns } from './semantic-review';
import { suggestAssignments, type AttributeChoice } from './suggest';

const attr = (attributeCode: string, attributeName: string, dataType: string, domainCode: string): AttributeChoice => ({
  attributeCode, attributeName, dataType, domainCode, referenceListCode: null,
});

const catalog: AttributeChoice[] = [
  attr('ISSUER_INDUSTRY_SECTOR', 'Issuer Industry', 'STRING', 'ISSUER'),
  attr('FACILITY_DRAWN', 'Drawn', 'CURRENCY', 'CREDIT_FACILITY'),
  attr('FACILITY_MATURITY', 'Maturity', 'DATE', 'CREDIT_FACILITY'),
  attr('FUNDED_PAR_AMOUNT', 'Funded Par Amount', 'CURRENCY', 'POSITION'),
  attr('SPREAD_BPS', 'Spread (bps)', 'NUMBER', 'SECURITY'),
];
const domains = ['ISSUER', 'CREDIT_FACILITY', 'POSITION', 'SECURITY'];
const headers = ['Issuer', 'Facility', 'Par Amount', 'Spread (bps)', 'Maturity'];
const rows = [
  { Issuer: 'Acme Corp', Facility: 'Term Loan B', 'Par Amount': '12,500,000', 'Spread (bps)': '425', Maturity: '2030-06-30' },
  { Issuer: 'Beta LLC', Facility: 'Revolver', 'Par Amount': '(3,000,000)', 'Spread (bps)': '375', Maturity: '2029-03-31' },
  { Issuer: 'Gamma Inc', Facility: 'Term Loan A', 'Par Amount': '8,250,000.50', 'Spread (bps)': '350', Maturity: '2031-09-15' },
];

const answer = (columns: object[]) => parseModelAnswer(JSON.stringify({ columns }));
const find = (list: ReturnType<typeof suggestAssignments>, column: string) => list.find((item) => item.sourceColumn === column)!;

describe('parseModelAnswer', () => {
  it('reads JSON, with or without wrapping text', () => {
    expect(parseModelAnswer('```json\n{"columns":[{"column":"A","role":"ignore"}]}\n```').get('A')?.role).toBe('ignore');
    expect(parseModelAnswer('[{"column":"B","role":"identity"}]').get('B')?.role).toBe('identity');
    expect(parseModelAnswer('not json').size).toBe(0);
  });
});

describe('mergeSemanticAnswer', () => {
  const base = () => suggestAssignments(headers, rows, catalog);

  it('confirms a column when the name pass and the model agree', () => {
    const merged = mergeSemanticAnswer(base(), answer([
      { column: 'Maturity', role: 'attribute', domainCode: 'CREDIT_FACILITY', attributeCode: 'FACILITY_MATURITY', confidence: 0.9, reason: 'Dates of maturity' },
    ]), catalog, domains);
    expect(find(merged, 'Maturity').suggestion.method).toBe('ai');
    expect(find(merged, 'Maturity').suggestion.reason).toMatch(/reads it the same way/);
    expect(find(merged, 'Maturity').suggestion.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('never confirms a column on the model alone', () => {
    const wrong = base().map((item) => (item.sourceColumn === 'Issuer'
      ? { ...item, role: 'attribute' as const, domainCode: 'ISSUER', attributeCode: 'ISSUER_INDUSTRY_SECTOR', suggestion: { method: 'name' as const, confidence: 0.88, reason: 'name match' } }
      : item));
    const merged = mergeSemanticAnswer(wrong, answer([
      { column: 'Issuer', role: 'identity', domainCode: 'ISSUER', confidence: 0.99, reason: 'Company names' },
    ]), catalog, domains);
    const issuer = find(merged, 'Issuer');
    expect(issuer.role).toBe('identity');
    expect(issuer.suggestion.confidence).toBeLessThan(0.8);
    expect(issuer.suggestion.reason).toMatch(/Confirm which is right/);
  });

  it('drops an answer whose field does not exist, is on another record, or does not fit the values', () => {
    const merged = mergeSemanticAnswer(base(), answer([
      { column: 'Facility', role: 'attribute', domainCode: 'CREDIT_FACILITY', attributeCode: 'FACILITY_DRAWN', confidence: 0.99 },
      { column: 'Par Amount', role: 'attribute', domainCode: 'POSITION', attributeCode: 'MADE_UP', confidence: 0.99 },
      { column: 'Spread (bps)', role: 'attribute', domainCode: 'ISSUER', attributeCode: 'SPREAD_BPS', confidence: 0.99 },
      { column: 'Maturity', role: 'identity', domainCode: 'NOT_A_RECORD', confidence: 0.99 },
    ]), catalog, domains);
    expect(find(merged, 'Facility').attributeCode).not.toBe('FACILITY_DRAWN');
    expect(find(merged, 'Par Amount').attributeCode).toBe('FUNDED_PAR_AMOUNT');
    expect(find(merged, 'Spread (bps)').domainCode).toBe('SECURITY');
    expect(find(merged, 'Maturity').attributeCode).toBe('FACILITY_MATURITY');
  });

  it('does not raise a field on an unidentified record just because the model agrees', () => {
    const merged = mergeSemanticAnswer(base(), answer([
      { column: 'Par Amount', role: 'attribute', domainCode: 'POSITION', attributeCode: 'FUNDED_PAR_AMOUNT', confidence: 0.95 },
    ]), catalog, domains);
    expect(find(merged, 'Par Amount').suggestion.confidence).toBeLessThan(0.8);
  });

  it('leaves confirmed matches alone', () => {
    const confirmed = base().map((item) => (item.sourceColumn === 'Maturity'
      ? { ...item, suggestion: { method: 'source_map' as const, confidence: 0.99, reason: 'Saved map' } }
      : item));
    const merged = mergeSemanticAnswer(confirmed, answer([{ column: 'Maturity', role: 'ignore', confidence: 0.9 }]), catalog, domains);
    expect(find(merged, 'Maturity').suggestion.method).toBe('source_map');
  });

  it('keeps one identity per record type', () => {
    const merged = mergeSemanticAnswer(base(), answer([
      { column: 'Facility', role: 'identity', domainCode: 'ISSUER', confidence: 0.7 },
    ]), catalog, domains);
    expect(merged.filter((item) => item.role === 'identity' && item.domainCode === 'ISSUER')).toHaveLength(1);
  });
});

describe('buildPrompt and reviewColumns', () => {
  it('shows the model the whole table and the catalog', () => {
    const prompt = buildPrompt(suggestAssignments(headers, rows, catalog), catalog, domains, { fileName: 'schedule.pdf', note: 'LlamaParse found 1 table.', rowCount: 3 });
    expect(prompt).toContain('schedule.pdf');
    expect(prompt).toContain('LlamaParse found 1 table.');
    expect(prompt).toContain('Term Loan B');
    expect(prompt).toContain('CREDIT_FACILITY|FACILITY_MATURITY|Maturity|DATE');
  });

  it('falls back to the name pass without a key or when the call fails', async () => {
    const start = suggestAssignments(headers, rows, catalog);
    expect(await reviewColumns(start, catalog, domains, {}, fetch, '')).toBe(start);
    const failing = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    expect(await reviewColumns(start, catalog, domains, {}, failing, 'k')).toBe(start);
    const throwing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await reviewColumns(start, catalog, domains, {}, throwing, 'k')).toBe(start);
  });

  it('applies the answer the model returns', async () => {
    const start = suggestAssignments(headers, rows, catalog);
    const fake = (async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ columns: [{ column: 'Maturity', role: 'attribute', domainCode: 'CREDIT_FACILITY', attributeCode: 'FACILITY_MATURITY', confidence: 0.92, reason: 'Maturity dates' }] }) }] } }] }),
    })) as unknown as typeof fetch;
    const reviewed = await reviewColumns(start, catalog, domains, {}, fake, 'k');
    expect(find(reviewed, 'Maturity').suggestion.method).toBe('ai');
  });
});

describe('how many values the model sees', () => {
  const wide = (count: number, distinct: number) => {
    const headers = Array.from({ length: count }, (_, index) => `Column ${index}`);
    const rows = Array.from({ length: distinct }, (_, row) => Object.fromEntries(headers.map((header) => [header, `value-${row}`])));
    return suggestAssignments(headers, rows, catalog);
  };
  const valuesInPrompt = (assignments: ReturnType<typeof suggestAssignments>) => {
    const prompt = buildPrompt(assignments, catalog, domains, {});
    const json = prompt.split('Columns (JSON): ')[1].split('\n')[0];
    return (JSON.parse(json) as { values: string[] }[]).map((item) => item.values.length);
  };

  it('shows up to 50 distinct values per column on a narrow file', () => {
    expect(Math.max(...valuesInPrompt(wide(5, 200)))).toBe(50);
  });

  it('shows fewer on a wide file, but never fewer than 5', () => {
    const counts = valuesInPrompt(wide(300, 100));
    expect(Math.max(...counts)).toBeLessThanOrEqual(5);
    expect(Math.min(...counts)).toBe(5);
  });

  it('cuts a long value short', () => {
    const [item] = suggestAssignments(['Notes'], [{ Notes: 'x'.repeat(200) }], catalog);
    expect(modelValues(item, 10)[0].length).toBeLessThanOrEqual(43);
  });
});
