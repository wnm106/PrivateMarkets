/**
 * Manual overrides from Excel (docs/EXCEL_ADDIN.md).
 *
 * The pane names each value the way a TAP cell does (attribute, record, date), so
 * every row is matched by resolveTapRequests, the same matching =TAP uses, and its
 * current value is read the same way. A save writes through writeManualOverride, the
 * same writer as the record screen, chat and workflows. Nothing here runs from a
 * formula: the pane previews, the person confirms, then it saves.
 */

import { ManualOverrideError, manualOverrideMessage, refreshCalculations, storedOverrideValue, writeManualOverride } from './source-write';
import { normalizeTapDate, resolveTapRequests, tapCellValue, type TapResult } from './tap';

export type TapOverrideStatus =
  | 'READY'
  | 'SAVED'
  | 'PENDING_APPROVAL'
  | 'UNCHANGED'
  | 'STALE'
  | 'DUPLICATE'
  | 'INVALID_REQUEST'
  | 'INVALID_VALUE'
  | 'NOT_EDITABLE'
  | 'NO_ACCESS'
  | 'UNKNOWN_ATTRIBUTE'
  | 'AMBIGUOUS_ATTRIBUTE'
  | 'UNKNOWN_ENTITY'
  | 'AMBIGUOUS_ENTITY'
  | 'FAILED';

export interface TapOverrideRequest {
  attribute: string;
  entity: string;
  /** First day the value holds, YYYY-MM-DD. Blank means today. */
  validFrom?: string | null;
  value: unknown;
  /** currentText from the preview. When the value has changed since, the row is not written. */
  expected?: string | null;
  /** This row's reason. The submission's reason is used when blank. */
  reason?: string | null;
}

export interface TapOverridePlan {
  attribute: string;
  entity: string;
  validFrom: string | null;
  attributeCode: string | null;
  attributeName: string | null;
  dataType: string | null;
  entityId: string | null;
  entityCode: string | null;
  entityName: string | null;
  domainCode: string | null;
  currentValue: number | string | boolean | null;
  /** The current value as text, to send back as `expected`. Empty when there is none. */
  currentText: string;
  newValue: number | string | boolean | null;
  newText: string | null;
  status: TapOverrideStatus;
  message: string | null;
  candidates: string[];
}

export const TAP_MAX_OVERRIDES = 200;

type OverrideClient = any;

/** A value as text, so a preview and a save compare the same thing. */
export function comparableText(value: number | string | boolean | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function planFromResult(request: TapOverrideRequest, result: TapResult, validFrom: string | null): TapOverridePlan {
  return {
    attribute: String(request.attribute ?? ''),
    entity: String(request.entity ?? ''),
    validFrom,
    attributeCode: result.attributeCode,
    attributeName: result.attributeName,
    dataType: result.dataType,
    entityId: result.entityId,
    entityCode: result.entityCode,
    entityName: result.entityName,
    domainCode: result.domainCode,
    currentValue: result.error ? null : result.value,
    currentText: result.error ? '' : comparableText(result.value),
    newValue: null,
    newText: null,
    status: 'READY',
    message: null,
    candidates: result.candidates || [],
  };
}

function refuse(plan: TapOverridePlan, status: TapOverrideStatus, message: string): void {
  plan.status = status;
  plan.message = message;
}

/** What a save would do, row by row. Writes nothing. */
export async function planTapOverrides(supabase: OverrideClient, requests: readonly TapOverrideRequest[]): Promise<TapOverridePlan[]> {
  return (await planWithMatches(supabase, requests)).plans;
}

async function planWithMatches(supabase: OverrideClient, requests: readonly TapOverrideRequest[]): Promise<{ plans: TapOverridePlan[]; results: TapResult[] }> {
  if (requests.length > TAP_MAX_OVERRIDES) throw new Error(`At most ${TAP_MAX_OVERRIDES} overrides can be sent at once.`);
  const dates = requests.map((request) => {
    const date = normalizeTapDate(request.validFrom);
    return date.ok ? (date.date || today()) : String(request.validFrom ?? '');
  });
  const results = await resolveTapRequests(
    supabase,
    requests.map((request, index) => ({ attribute: request.attribute, entity: request.entity, asOfDate: dates[index] })),
  );
  const plans = requests.map((request, index) => planFromResult(request, results[index], results[index].asOfDate));

  plans.forEach((plan, index) => {
    const result = results[index];
    if (result.error && result.error !== 'NO_VALUE') {
      refuse(plan, result.error as TapOverrideStatus, result.message || result.error);
      plan.validFrom = normalizeTapDate(requests[index].validFrom).ok ? plan.validFrom : null;
      return;
    }
    if (!result.attributeId) {
      refuse(plan, 'NOT_EDITABLE', 'A record’s code and name are changed in Tapestry, not with a manual entry.');
    }
  });

  // The record screen offers no edit for an attribute marked not editable. Neither does Excel.
  const attributeIds = [...new Set(results.map((result) => result.attributeId).filter((id): id is string => Boolean(id)))];
  if (attributeIds.length) {
    const { data, error } = await supabase.from('attribute_register').select('id, is_editable').in('id', attributeIds);
    if (error) throw new Error(error.message);
    const locked = new Set(((data || []) as Array<{ id: string; is_editable?: boolean | null }>).filter((row) => row.is_editable === false).map((row) => row.id));
    plans.forEach((plan, index) => {
      if (plan.status === 'READY' && locked.has(results[index].attributeId as string)) {
        refuse(plan, 'NOT_EDITABLE', `${plan.attributeCode} is not editable.`);
      }
    });
  }

  const seen = new Set<string>();
  plans.forEach((plan, index) => {
    if (plan.status !== 'READY') return;
    const request = requests[index];
    const value = storedOverrideValue(request.value, plan.dataType);
    if (!value.ok) {
      refuse(plan, 'INVALID_VALUE', value.message);
      return;
    }
    const typed = tapCellValue(plan.dataType, {
      text: value.stored.golden_value,
      numeric: value.stored.golden_value_numeric,
      date: value.stored.golden_value_date,
    });
    plan.newValue = typed ? typed.value : value.stored.golden_value;
    plan.newText = comparableText(plan.newValue);

    const key = `${plan.entityId}|${results[index].attributeId}|${plan.validFrom}`;
    if (seen.has(key)) {
      refuse(plan, 'DUPLICATE', 'The same attribute, record and date is listed more than once.');
      return;
    }
    seen.add(key);

    const expected = request.expected;
    if (expected !== null && expected !== undefined && String(expected) !== plan.currentText) {
      refuse(plan, 'STALE', `The value changed since it was checked. It is now ${plan.currentText || 'blank'}.`);
      return;
    }
    if (plan.newText === plan.currentText) {
      // Saving it would pin a value another source supplies today. Leave it to the record screen.
      refuse(plan, 'UNCHANGED', 'Already this value.');
    }
  });

  // A manual entry holds from its date onward, so an earlier one saved in this list would
  // carry over to a later date the person left at today's value. Save that later row too.
  const earliestReady = new Map<string, string>();
  plans.forEach((plan, index) => {
    if (plan.status !== 'READY' || !plan.validFrom) return;
    const key = `${plan.entityId}|${results[index].attributeId}`;
    const earliest = earliestReady.get(key);
    if (!earliest || plan.validFrom < earliest) earliestReady.set(key, plan.validFrom);
  });
  plans.forEach((plan, index) => {
    if (plan.status !== 'UNCHANGED' || !plan.validFrom) return;
    const earliest = earliestReady.get(`${plan.entityId}|${results[index].attributeId}`);
    if (earliest && earliest < plan.validFrom) {
      plan.status = 'READY';
      plan.message = `Saved too, so the entry from ${earliest} does not carry over to this date.`;
    }
  });

  // Write access, per record. Row security refuses the write anyway; this says so before.
  const entityIds = [...new Set(plans.filter((plan) => plan.status === 'READY').map((plan) => plan.entityId as string))];
  const writable = new Map<string, boolean>();
  await Promise.all(entityIds.map(async (entityId) => {
    const { data, error } = await supabase.schema('tenancy').rpc('has_entity_access', { p_entity_id: entityId, p_level: 'WRITE' });
    writable.set(entityId, error ? true : data !== false);
  }));
  for (const plan of plans) {
    if (plan.status === 'READY' && writable.get(plan.entityId as string) === false) {
      refuse(plan, 'NO_ACCESS', 'You cannot change this record.');
    }
  }
  return { plans, results };
}

/** The organization's sign-in rules, as middleware applies them to the app. Writes need them met. */
export async function assertSignInAllowsWrites(supabase: OverrideClient): Promise<void> {
  const { data, error } = await supabase.schema('tenancy').rpc('current_sign_in_decision');
  if (error) {
    if (/current_sign_in_decision|PGRST202|schema cache/i.test(error.message || '')) return;
    throw new Error('Your sign-in could not be checked. Try again.');
  }
  const decision = (data && typeof data === 'object' ? data : {}) as { allowed?: boolean; reason?: string | null; mfa_required?: boolean; mfa_satisfied?: boolean };
  if (decision.allowed === false) throw new Error(decision.reason || 'This sign-in method is not allowed for this organization.');
  if (decision.mfa_required && decision.mfa_satisfied === false) {
    throw new Error('Your organization requires an authenticator. Sign in to Tapestry again from the pane.');
  }
}

/** Write the rows a preview finds READY, as Manual Entry values. Returns every row's outcome. */
export async function submitTapOverrides(
  supabase: OverrideClient,
  requests: readonly TapOverrideRequest[],
  reason: string,
  userId: string | null,
): Promise<TapOverridePlan[]> {
  const batchReason = String(reason ?? '').trim();
  if (!batchReason && requests.some((request) => !String(request.reason ?? '').trim())) {
    throw new Error('A reason is required for a manual entry.');
  }
  await assertSignInAllowsWrites(supabase);
  const { plans, results } = await planWithMatches(supabase, requests);
  const ready = plans.map((plan, index) => ({ plan, index })).filter(({ plan }) => plan.status === 'READY');

  const saved = new Set<string>();
  for (const { plan, index } of ready) {
    try {
      const written = await writeManualOverride(supabase, {
        entityId: plan.entityId as string,
        attribute: { id: results[index].attributeId as string, data_type: plan.dataType },
        value: requests[index].value,
        validFrom: plan.validFrom,
        reason: String(requests[index].reason ?? '').trim() || batchReason,
        userId,
      });
      if (written.pending) {
        plan.status = 'PENDING_APPROVAL';
        plan.message = manualOverrideMessage(written);
      } else {
        plan.status = 'SAVED';
        plan.message = null;
        saved.add(plan.entityId as string);
      }
    } catch (error) {
      if (error instanceof ManualOverrideError && (error.code === 'NO_ACCESS' || error.code === 'INVALID_VALUE')) {
        refuse(plan, error.code, error.message);
      } else {
        refuse(plan, 'FAILED', error instanceof Error ? error.message : 'The value could not be saved.');
      }
    }
  }
  for (const entityId of saved) await refreshCalculations(supabase, entityId);
  return plans;
}
