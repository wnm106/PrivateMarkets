import type { SupabaseClient } from '@supabase/supabase-js';
import { buildBorrowerFinancials, REVIEW_NOTES_CODE, REVIEW_OUTCOME_CODE, reviewOutcome, type BorrowerFinancials } from './borrower-financials';
import { mapCovenantTest, type CovenantTest } from './covenant-test';
import { asOfDate, knowledgeInstant, links, loadEntities, numeric, text, valuesFor } from './fund-surface';
import { writeGoldenValue } from './golden-write';
import { setAttributes } from './rec-actions';
import { periodEndValue, readStatementAmounts, statementAttributesFromRegister, type RegisterAttribute, type StatementPeriod } from './statement-book';

/**
 * Reads and changes a borrower's financials for the tools and the review.
 *
 * Records, links and values are read through the shared readers, so a run
 * sees what the pages see. Covenants are read through the public covenant
 * functions, which check the caller may see each one.
 */

const STATEMENT_DOMAIN = 'STATEMENT_PERIOD';
const STATEMENT_OF_BORROWER = 'STATEMENT_ISSUER';
const DEAL_OF_BORROWER = 'DEAL_ISSUER';
const COVENANT_VALUE = 'COVENANT_CURRENT';
const CERTIFICATE_SOURCE = 'BORROWER_CERTIFICATE';

interface RegisterRow extends RegisterAttribute {
  id: string;
}

async function statementRegister(supabase: SupabaseClient): Promise<RegisterRow[]> {
  const { data, error } = await supabase
    .from('attribute_register')
    .select('id, attribute_code, attribute_name, data_type, display_section, display_group, is_visible, derivation_formula, derivation_dependencies, display_format, validation_rules, period_rollup')
    .eq('domain_code', STATEMENT_DOMAIN);
  if (error) throw new Error(error.message);
  return (data || []).map((row) => ({
    id: row.id as string,
    attributeCode: row.attribute_code as string,
    attributeName: row.attribute_name as string,
    dataType: row.data_type as string | null,
    displaySection: row.display_section as string | null,
    displayGroup: row.display_group as number | null,
    isVisible: row.is_visible as boolean | null,
    derivationFormula: row.derivation_formula == null ? null : typeof row.derivation_formula === 'string' ? row.derivation_formula : JSON.stringify(row.derivation_formula),
    derivationDependencies: row.derivation_dependencies as string[] | null,
    displayFormat: row.display_format as string | null,
    validationRules: row.validation_rules,
    periodRollup: row.period_rollup as string | null,
  }));
}

export interface BorrowerLoad {
  financials: BorrowerFinancials;
  /** The deals the borrower's covenants sit on. */
  dealIds: string[];
  /** Whether review notes can be kept: the attribute for them is registered. */
  notesKept: boolean;
}

/** One borrower's financials for a quarter, as known on the caller's dates. */
export async function loadBorrowerFinancials(
  supabase: SupabaseClient,
  borrowerId: string,
  periodEnd?: string | null,
  asOfInput?: string | null,
  knowledgeInput?: string | null,
  quarters?: number,
): Promise<BorrowerLoad> {
  const asOf = asOfDate(asOfInput);
  const knowledge = knowledgeInstant(knowledgeInput);
  const [found] = await loadEntities(supabase, [borrowerId]);
  if (!found) throw new Error('The borrower was not found, or you may not see it.');
  const borrower = { id: found.id, code: found.entity_code, name: found.entity_name };

  const register = await statementRegister(supabase);
  const attributes = statementAttributesFromRegister(register);
  const statementLinks = await links(supabase, STATEMENT_OF_BORROWER, 'child_entity_id', [borrowerId], asOf, knowledge);
  const statementIds = [...new Set(statementLinks.map((row) => row.parent_entity_id))];
  const statements = await loadEntities(supabase, statementIds);

  // Only what is stored is read. The totals, margins and trailing figures are worked out by the statement book.
  const stored = new Map(register.filter((row) => !row.derivationFormula).map((row) => [row.attributeCode, { id: row.id, code: row.attributeCode }]));
  // A response holds at most 1,000 rows, and a statement has dozens of stored lines, so a few statements are read at a time.
  const values = new Map<string, Awaited<ReturnType<typeof valuesFor>> extends Map<string, infer Row> ? Row : never>();
  for (let index = 0; index < statementIds.length; index += 12) {
    for (const [key, row] of await valuesFor(supabase, statementIds.slice(index, index + 12), stored, asOf, knowledge)) values.set(key, row);
  }
  const rawOf = (entityId: string): Record<string, unknown> => {
    const raw: Record<string, unknown> = {};
    for (const def of stored.values()) {
      const row = values.get(`${entityId}|${def.id}`);
      if (row) raw[def.code] = numeric(row) ?? text(row);
    }
    return raw;
  };
  const periods: StatementPeriod[] = [];
  const notesOf = new Map<string, string>();
  for (const statement of statements) {
    const raw = rawOf(statement.id);
    const end = periodEndValue(attributes, raw, (value) => String(value ?? ''));
    if (!end) continue;
    periods.push({ end, entityId: statement.id, entityName: statement.entity_name, values: readStatementAmounts(attributes, raw, (value) => (typeof value === 'number' ? value : Number(value) || 0)) });
    if (typeof raw[REVIEW_NOTES_CODE] === 'string') notesOf.set(end.slice(0, 7), raw[REVIEW_NOTES_CODE] as string);
  }

  const dealLinks = await links(supabase, DEAL_OF_BORROWER, 'child_entity_id', [borrowerId], asOf, knowledge);
  const dealIds = [...new Set(dealLinks.map((row) => row.parent_entity_id))];
  const today = new Date().toISOString().slice(0, 10);
  const asked = periodEnd ? String(periodEnd).slice(0, 10) : null;
  // A covenant is tested at the quarter looked at: the one asked for, or the latest that has ended.
  const testAt = asked || [...periods.map((period) => period.end)].filter((end) => end <= asOf).sort().pop() || asOf;
  const covenants: CovenantTest[] = [];
  for (const dealId of dealIds) {
    const { data, error } = await supabase.rpc('deal_covenant_tests', { p_deal_id: dealId, p_as_of: testAt });
    if (error) throw new Error(error.message || "The deal's covenants could not be read.");
    for (const row of Array.isArray(data) ? data : []) {
      if (!row) continue;
      const listed = mapCovenantTest(row as Record<string, unknown>);
      // The deal's list has each covenant as it stands. Its own test adds the quarters before, to see how it has moved.
      const { data: own, error: ownError } = await supabase.rpc('covenant_test', { p_covenant_id: listed.covenantId, p_as_of: testAt, p_history: 6 });
      covenants.push(!ownError && own ? mapCovenantTest(own as Record<string, unknown>) : listed);
    }
  }

  const notesKept = register.some((row) => row.attributeCode === REVIEW_NOTES_CODE);
  const financials = buildBorrowerFinancials({ borrower, periods, register, covenants, asked, today: asOf < today ? asOf : today, quarters, reviewNotes: notesOf.get(testAt.slice(0, 7)) || null, notesKept });
  return { financials, dealIds, notesKept };
}

/** Stores each covenant of the borrower's deals again, and the borrower's statements with them. */
export async function recalculateBorrowerCovenants(supabase: SupabaseClient, borrowerId: string, periodEnd?: string | null) {
  const before = await loadBorrowerFinancials(supabase, borrowerId, periodEnd);
  const failed: Array<{ covenant: string; error: string }> = [];
  let recalculated = 0;
  for (const check of before.financials.covenants) {
    const { error } = await supabase.rpc('recalculate_covenant', { p_covenant_id: check.covenantId });
    if (error) failed.push({ covenant: check.name, error: error.message });
    else recalculated += 1;
  }
  const after = failed.length < before.financials.covenants.length ? await loadBorrowerFinancials(supabase, borrowerId, periodEnd) : before;
  return { borrower: before.financials.borrower, wereBehind: before.financials.counts.stale, recalculated, failed, financials: after.financials };
}

export interface CertificateInput {
  /** The covenant record. */
  covenantId: string;
  /** The quarter end the certificate tests. */
  testDate: string;
  value: number;
  note?: string;
}

/**
 * Records what the borrower's compliance certificate says a covenant was at a
 * quarter end. It is filed under the certificate's own source, which ranks
 * behind the calculation, so the calculation stays the golden value and the
 * two can be compared.
 */
export async function recordCovenantCertificate(supabase: SupabaseClient, input: CertificateInput) {
  const testDate = String(input.testDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(testDate)) throw new Error('testDate is required: the quarter end the certificate tests, YYYY-MM-DD.');
  if (!Number.isFinite(input.value)) throw new Error('value is required: the figure on the certificate, as a number.');
  const { data: attribute, error: attributeError } = await supabase.from('attribute_register').select('id').eq('attribute_code', COVENANT_VALUE).maybeSingle();
  if (attributeError || !attribute?.id) throw new Error(attributeError?.message || 'The covenant value attribute is not registered.');
  const { data: source, error: sourceError } = await supabase.schema('entity_instances').from('source_registry').select('id, precedence_rank').eq('source_code', CERTIFICATE_SOURCE).maybeSingle();
  if (sourceError || !source?.id) throw new Error(sourceError?.message || 'The Borrower Compliance Certificate source is not registered.');

  const read = async () => {
    const { data, error } = await supabase.rpc('covenant_test', { p_covenant_id: input.covenantId, p_as_of: testDate, p_history: 1 });
    if (error) throw new Error(error.message || 'The covenant could not be read.');
    return data ? mapCovenantTest(data as Record<string, unknown>) : null;
  };
  const before = await read();
  if (!before) throw new Error('The covenant was not found, or you may not see it.');
  if (before.isLibrary) throw new Error('A library definition has no certificate. Name the covenant on the deal.');

  await writeGoldenValue(supabase, {
    entityId: input.covenantId,
    attributeId: attribute.id as string,
    sourceId: source.id as string,
    validFrom: testDate,
    value: {
      golden_value: String(input.value),
      golden_value_numeric: input.value,
      precedence_rank: Number(source.precedence_rank) || 110,
      is_manual_override: false,
      override_reason: input.note?.trim() || null,
    },
  });
  const after = await read();
  return {
    covenant: before.name,
    deal: before.dealName,
    testDate,
    certificate: input.value,
    calculated: after?.value ?? before.value,
    certificateLessCalculated: after?.reportedDifference ?? null,
    limit: before.level,
    unit: before.unit,
    status: after?.status ?? before.status,
  };
}

/**
 * Keeps the review notes for one borrower and one quarter on that quarter's
 * statement. Beside them the platform stores a one-line outcome that it reads
 * from the figures at the moment of saving, so the two cannot disagree about
 * the facts.
 */
export async function saveBorrowerReview(supabase: SupabaseClient, input: { borrowerId: string; periodEnd?: string | null; notes: string }) {
  const notes = String(input.notes || '').trim();
  if (!notes) throw new Error('The notes are empty.');
  const { financials, notesKept } = await loadBorrowerFinancials(supabase, input.borrowerId, input.periodEnd);
  if (!notesKept) throw new Error(`Review notes cannot be kept yet: the attribute ${REVIEW_NOTES_CODE} is not registered. Apply the statement review notes migration.`);
  if (!financials.statementId || !financials.periodEnd) throw new Error(`${financials.borrower.name} has no statement on file for ${financials.periodLabel}, so there is nowhere to keep the notes.`);
  const asOf = new Date().toISOString().slice(0, 10);
  const outcome = reviewOutcome(financials, asOf);
  // The notes belong to the quarter, so they hold from its end.
  await setAttributes(supabase, financials.statementId, { [REVIEW_NOTES_CODE]: notes, [REVIEW_OUTCOME_CODE]: outcome }, financials.periodEnd);
  return { borrower: financials.borrower.name, period: financials.periodLabel, statementId: financials.statementId, outcome, replaced: Boolean(financials.reviewNotes) };
}
