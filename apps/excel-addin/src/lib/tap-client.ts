import { SignedOutError } from './auth';
import { Batcher } from './batcher';
import { parseAsOf } from './excel-date';
import type { GraphQLClient } from './graphql';

/** What the server answers for one TAP request (the TapValue GraphQL type). */
export interface TapValue {
  attribute: string;
  entity: string;
  asOfDate: string | null;
  attributeCode: string | null;
  attributeName: string | null;
  dataType: string | null;
  entityCode: string | null;
  entityName: string | null;
  domainCode: string | null;
  value: number | string | boolean | null;
  valueType: 'NUMBER' | 'TEXT' | 'BOOLEAN' | 'DATE' | null;
  validFrom: string | null;
  error: string | null;
  message: string | null;
  candidates: string[];
}

export interface TapRequest {
  attribute: string;
  entity: string;
  asOfDate: string | null;
}

/** A cell's result: a value, or an Excel error with a message (#VALUE! or #N/A). */
export type CellResult =
  | { ok: true; value: number | string | boolean }
  | { ok: false; error: 'value' | 'na'; message: string };

export const TAP_VALUES_QUERY = `query TapValues($requests: [TapRequestInput!]!) {
  tapValues(requests: $requests) {
    attribute entity asOfDate attributeCode attributeName dataType entityCode entityName domainCode
    value valueType validFrom error message candidates
  }
}`;

/** The server takes at most 500 at once. */
const MAX_BATCH = 200;

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Turn the function's arguments into a request, or the cell's error. */
export function tapRequestFromArguments(attribute: unknown, entity: unknown, asOf: unknown): { ok: true; request: TapRequest } | { ok: false; result: CellResult } {
  const attributeText = text(attribute);
  const entityText = text(entity);
  if (!attributeText) return { ok: false, result: { ok: false, error: 'value', message: 'An attribute code is required, such as "NAV".' } };
  if (!entityText) return { ok: false, result: { ok: false, error: 'value', message: 'A record code or name is required.' } };
  const date = parseAsOf(asOf);
  if (!date.ok) return { ok: false, result: { ok: false, error: 'value', message: date.message } };
  return { ok: true, request: { attribute: attributeText, entity: entityText, asOfDate: date.date } };
}

export function cellResult(answer: TapValue): CellResult {
  if (answer.error) {
    const candidates = answer.candidates?.length ? ` ${answer.candidates.slice(0, 3).join('; ')}${answer.candidates.length > 3 ? '; …' : ''}` : '';
    const message = `${answer.message || answer.error}${candidates}`;
    return { ok: false, error: answer.error === 'INVALID_REQUEST' ? 'value' : 'na', message };
  }
  if (answer.value === null || answer.value === undefined) {
    return { ok: false, error: 'na', message: 'No value.' };
  }
  return { ok: true, value: answer.value };
}

export function errorResult(error: unknown): CellResult {
  if (error instanceof SignedOutError) return { ok: false, error: 'na', message: error.message };
  const message = error instanceof Error ? error.message : 'Tapestry could not answer.';
  return { ok: false, error: 'na', message };
}

export function requestKey(request: TapRequest): string {
  return `${request.attribute.toLowerCase()}\u0000${request.entity.toLowerCase()}\u0000${request.asOfDate || ''}`;
}

/** Batches TAP calls from every cell into tapValues requests. */
export class TapClient {
  private readonly batcher: Batcher<TapRequest, TapValue>;

  constructor(private readonly graphql: Pick<GraphQLClient, 'request'>) {
    this.batcher = new Batcher(
      async (requests) => {
        const data = await this.graphql.request<{ tapValues: TapValue[] }>(TAP_VALUES_QUERY, { requests });
        return data.tapValues;
      },
      { key: requestKey, maxBatch: MAX_BATCH, delayMs: 40 },
    );
  }

  value(request: TapRequest): Promise<TapValue> {
    return this.batcher.request(request);
  }

  async cell(attribute: unknown, entity: unknown, asOf: unknown): Promise<CellResult> {
    const parsed = tapRequestFromArguments(attribute, entity, asOf);
    if (!parsed.ok) return parsed.result;
    try {
      return cellResult(await this.value(parsed.request));
    } catch (error) {
      return errorResult(error);
    }
  }
}
