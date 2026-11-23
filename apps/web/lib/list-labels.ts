'use client';

import { useEffect, useState } from 'react';
import { REFERENCE_LIST_DETAIL_QUERY, graphqlQuery } from '@/lib/graphql';

/**
 * Labels for attributes that store a reference-list code.
 *
 * A list attribute (attribute_register.reference_list_code) stores the value
 * code, such as GICS 601010, and the list gives its label. Grids show the
 * label. Each list is fetched once per page load and shared by every grid.
 */

export type ListLabels = ReadonlyMap<string, string>;

interface ListValue {
  valueCode: string;
  valueLabel?: string | null;
}

const cache = new Map<string, Promise<ListLabels>>();

/** Code to label for one reference list, including retired values so old records still read. */
export function labelsFromValues(values: ListValue[] | null | undefined): ListLabels {
  const labels = new Map<string, string>();
  for (const value of values || []) {
    const code = String(value.valueCode ?? '').trim();
    if (!code) continue;
    const label = String(value.valueLabel ?? '').trim();
    labels.set(code, label || code);
  }
  return labels;
}

export function loadListLabels(listCode: string): Promise<ListLabels> {
  const existing = cache.get(listCode);
  if (existing) return existing;
  const request = graphqlQuery<{ referenceList: { values: ListValue[] } | null }, { listCode: string }>(
    REFERENCE_LIST_DETAIL_QUERY, { listCode }, 'cache-first',
  ).then((result) => {
    if (result.error) {
      cache.delete(listCode);
      return new Map<string, string>() as ListLabels;
    }
    return labelsFromValues(result.data?.referenceList?.values);
  }).catch(() => {
    cache.delete(listCode);
    return new Map<string, string>() as ListLabels;
  });
  cache.set(listCode, request);
  return request;
}

/** The label for a stored value: a code, or several codes in an array. Unknown codes show as stored. */
export function listLabel(labels: ListLabels | undefined, value: unknown): string {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) return value.map((item) => listLabel(labels, item)).filter(Boolean).join(', ');
  const text = String(value).trim();
  return labels?.get(text) ?? text;
}

/** Labels for each list code given, keyed by list code. Lists not yet loaded are missing. */
export function useListLabels(listCodes: readonly string[]): Record<string, ListLabels> {
  const key = [...new Set(listCodes.filter(Boolean))].sort().join('|');
  const [labels, setLabels] = useState<Record<string, ListLabels>>({});
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    for (const code of key.split('|')) {
      void loadListLabels(code).then((map) => {
        if (cancelled) return;
        setLabels((current) => (current[code] === map ? current : { ...current, [code]: map }));
      });
    }
    return () => { cancelled = true; };
  }, [key]);
  return labels;
}

export interface GridFilter {
  field: string;
  op: string;
  value?: unknown;
}

/** Matches no stored code, so an "in" filter with nothing to match returns no rows. */
export const NO_LIST_MATCH = '__no_list_value_matches__';

/**
 * A text filter typed against a list column, turned into the codes it means.
 *
 * Grids that filter in the database compare the stored code, but the column
 * shows the label. "contains REIT" becomes "in [the codes whose label or code
 * contains REIT]". Filters other than text matches pass through unchanged.
 */
export function listFilterToCodes(filter: GridFilter, labels: ListLabels | undefined): GridFilter {
  const ops: Record<string, (text: string, needle: string) => boolean> = {
    contains: (text, needle) => text.includes(needle),
    startsWith: (text, needle) => text.startsWith(needle),
    eq: (text, needle) => text === needle,
    neq: (text, needle) => text === needle,
  };
  const test = ops[filter.op];
  if (!test || !labels || labels.size === 0 || typeof filter.value !== 'string') return filter;
  const needle = filter.value.trim().toLowerCase();
  if (!needle) return filter;
  const codes = [...labels.entries()]
    .filter(([code, label]) => test(label.toLowerCase(), needle) || test(code.toLowerCase(), needle))
    .map(([code]) => code);
  if (filter.op === 'neq') return { field: filter.field, op: 'nin', value: codes.length ? codes : [NO_LIST_MATCH] };
  return { field: filter.field, op: 'in', value: codes.length ? codes : [NO_LIST_MATCH] };
}
