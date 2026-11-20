import { domainHref } from '@/lib/domain-routes';

/** A record that belongs to one entity type. */
export interface TypedRecord {
  id: string;
  entityName: string;
  domainCode: string;
  domainName?: string | null;
}

export interface EntityTypeGroup<T extends TypedRecord> {
  code: string;
  name: string;
  href: string;
  records: Array<T & { href: string }>;
}

/** The name a person uses for a type. A raw code becomes words. */
export function entityTypeName(code: string, registered?: string | null, fromRecord?: string | null): string {
  const named = [registered, fromRecord]
    .map((value) => (value || '').trim())
    .find((value) => value && value !== code);
  if (named) return named;
  const words = code.toLowerCase().split('_').filter(Boolean);
  if (words.length === 0) return 'Record';
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * Group records under their entity type, in name order.
 * The type links to that type's home page. Each record links to its own page.
 */
export function groupRecordsByType<T extends TypedRecord>(
  records: readonly T[],
  nameFor: (record: T) => string = (record) => entityTypeName(record.domainCode, null, record.domainName),
): EntityTypeGroup<T>[] {
  const groups = new Map<string, EntityTypeGroup<T>>();
  for (const record of records) {
    const code = record.domainCode || '';
    let group = groups.get(code);
    if (!group) {
      group = {
        code,
        name: nameFor(record) || entityTypeName(code, null, record.domainName),
        href: domainHref(code),
        records: [],
      };
      groups.set(code, group);
    }
    if (group.records.some((existing) => existing.id === record.id)) continue;
    group.records.push({ ...record, href: `${domainHref(record.domainCode)}/${record.id}` });
  }
  const ordered = [...groups.values()].sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.code.localeCompare(b.code),
  );
  for (const group of ordered) {
    group.records.sort(
      (a, b) => a.entityName.localeCompare(b.entityName, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id),
    );
  }
  return ordered;
}
