'use client';

import { useEffect, useMemo, useState } from 'react';
import { ATTRIBUTE_REGISTER_QUERY, graphqlQuery } from '@/lib/graphql';
import { TypeaheadSelect } from './TypeaheadSelect';

export interface AttributePathHop {
  relationshipCode: string;
  direction: 'UP' | 'DOWN';
}

interface RelationshipTypeOpt {
  relationshipCode: string;
  relationshipName: string;
  parentDomainCode: string;
  childDomainCode: string;
}

interface DomainOpt {
  domainCode: string;
  domainName: string;
}

interface AttributeOpt {
  attributeCode: string;
  attributeName: string;
  dataType: string;
}

export interface TreeAttributeOption {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  path: AttributePathHop[];
  domainCode: string;
  groupLabel: string;
  valueKey: string;
}

const attributeCache = new Map<string, AttributeOpt[]>();

export function attributePathKey(path?: AttributePathHop[] | null): string {
  return (path || []).map((h) => `${h.direction}:${h.relationshipCode}`).join('|');
}

export function attributeValueKey(path: AttributePathHop[] | null | undefined, attributeCode: string): string {
  const prefix = attributePathKey(path);
  return prefix ? `${prefix}\u001f${attributeCode}` : attributeCode;
}

function domainLabel(code: string, domains: DomainOpt[]): string {
  return domains.find((d) => d.domainCode === code)?.domainName || code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function edgeScore(rel: RelationshipTypeOpt, from: string, to: string): number {
  const code = rel.relationshipCode || '';
  let score = 0;
  if (code.includes(from) && code.includes(to)) score += 4;
  // Prefer the relationship named from this entity (SECURITY_ISSUER from a security)
  // over the reverse type (ISSUER_SECURITY), which may not be the one rows are stored under.
  if (code.startsWith(from + '_') || code.startsWith(from)) score += 3;
  return score;
}

interface TreeGroup {
  domainCode: string;
  path: AttributePathHop[];
  label: string;
}

function buildGroups(rootDomainCode: string, relationshipTypes: RelationshipTypeOpt[], domains: DomainOpt[]): TreeGroup[] {
  const groups: TreeGroup[] = [{ domainCode: rootDomainCode, path: [], label: domainLabel(rootDomainCode, domains) }];
  const seen = new Set<string>([rootDomainCode]);
  const queue = [groups[0]];
  while (queue.length) {
    const node = queue.shift()!;
    if (node.path.length >= 4) continue;
    const candidates: Array<{ rel: RelationshipTypeOpt; direction: 'UP' | 'DOWN'; target: string }> = [];
    for (const rel of relationshipTypes) {
      if (rel.parentDomainCode === node.domainCode && rel.childDomainCode && rel.childDomainCode !== node.domainCode) {
        candidates.push({ rel, direction: 'DOWN', target: rel.childDomainCode });
      } else if (rel.childDomainCode === node.domainCode && rel.parentDomainCode && rel.parentDomainCode !== node.domainCode) {
        candidates.push({ rel, direction: 'UP', target: rel.parentDomainCode });
      }
    }
    const bestByTarget = new Map<string, { rel: RelationshipTypeOpt; direction: 'UP' | 'DOWN'; target: string }>();
    for (const candidate of candidates) {
      const current = bestByTarget.get(candidate.target);
      if (!current || edgeScore(candidate.rel, node.domainCode, candidate.target) > edgeScore(current.rel, node.domainCode, candidate.target)) {
        bestByTarget.set(candidate.target, candidate);
      }
    }
    for (const candidate of bestByTarget.values()) {
      if (seen.has(candidate.target)) continue;
      seen.add(candidate.target);
      const next: TreeGroup = {
        domainCode: candidate.target,
        path: [...node.path, { relationshipCode: candidate.rel.relationshipCode, direction: candidate.direction }],
        label: `${node.label} › ${domainLabel(candidate.target, domains)}`,
      };
      groups.push(next);
      queue.push(next);
    }
  }
  return groups;
}

export function useRelationshipAttributes(
  rootDomainCode: string,
  relationshipTypes: RelationshipTypeOpt[],
  domains: DomainOpt[],
) {
  const [options, setOptions] = useState<TreeAttributeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const relKey = relationshipTypes.map((r) => `${r.relationshipCode}:${r.parentDomainCode}:${r.childDomainCode}`).join(',');
  const domainKey = domains.map((d) => d.domainCode).join(',');

  useEffect(() => {
    let cancelled = false;
    if (!rootDomainCode) {
      setOptions([]);
      return;
    }
    setLoading(true);
    const groups = buildGroups(rootDomainCode, relationshipTypes, domains);
    Promise.all(
      groups.map(async (group) => {
        let attributes = attributeCache.get(group.domainCode);
        if (!attributes) {
          const result = await graphqlQuery<{ attributeRegister: AttributeOpt[] }, { domainCode: string }>(
            ATTRIBUTE_REGISTER_QUERY,
            { domainCode: group.domainCode },
          );
          attributes = result.data?.attributeRegister || [];
          attributeCache.set(group.domainCode, attributes);
        }
        return attributes.map((attribute) => ({
          attributeCode: attribute.attributeCode,
          attributeName: attribute.attributeName,
          dataType: attribute.dataType,
          path: group.path,
          domainCode: group.domainCode,
          groupLabel: group.label,
          valueKey: attributeValueKey(group.path, attribute.attributeCode),
        }));
      }),
    )
      .then((lists) => {
        if (!cancelled) setOptions(lists.flat());
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // relKey/domainKey capture the lists without retriggering on every render identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootDomainCode, relKey, domainKey]);

  return { options, loading };
}

export function ComplianceAttributeSelect({
  rootDomainCode,
  relationshipTypes,
  domains,
  attributeCode,
  path,
  onChange,
  placeholder = 'Select attribute...',
}: {
  rootDomainCode: string;
  relationshipTypes: RelationshipTypeOpt[];
  domains: DomainOpt[];
  attributeCode: string;
  path?: AttributePathHop[] | null;
  onChange: (attributeCode: string, path: AttributePathHop[]) => void;
  placeholder?: string;
}) {
  const { options, loading } = useRelationshipAttributes(rootDomainCode, relationshipTypes, domains);
  const selectedKey = attributeCode ? attributeValueKey(path, attributeCode) : '';
  const items = useMemo(
    () =>
      options.map((o) => ({
        value: o.valueKey,
        label: o.attributeName,
        selectedLabel: o.path.length ? `${o.groupLabel} · ${o.attributeName}` : o.attributeName,
        group: o.groupLabel,
        hint: o.dataType?.toLowerCase(),
        search: o.attributeCode,
      })),
    [options],
  );

  return (
    <TypeaheadSelect
      options={items}
      value={selectedKey}
      loading={loading}
      disabled={!rootDomainCode}
      placeholder={rootDomainCode ? placeholder : 'Choose an entity type first'}
      onChange={(key) => {
        const option = options.find((item) => item.valueKey === key);
        if (!option) onChange('', []);
        else onChange(option.attributeCode, option.path);
      }}
    />
  );
}

// Type-ahead over an entity's own attributes and those of every related entity,
// grouped by entity. Reports the full option (attribute, owning entity, path).
export function RelatedAttributePicker({
  label,
  rootDomainCode,
  relationshipTypes,
  domains,
  isSelected,
  onSelect,
  placeholder = 'Select value...',
  error,
  clearable,
  bare,
  ownerLabel,
}: {
  label: string;
  rootDomainCode: string;
  relationshipTypes: RelationshipTypeOpt[];
  domains: DomainOpt[];
  isSelected: (option: TreeAttributeOption) => boolean;
  onSelect: (option: TreeAttributeOption | null) => void;
  placeholder?: string;
  error?: boolean;
  clearable?: boolean;
  /** Sit in a sentence row. The surrounding label names the control. */
  bare?: boolean;
  /** Closed box reads "Issuer · Industry" rather than the full path. */
  ownerLabel?: boolean;
}) {
  const { options, loading } = useRelationshipAttributes(rootDomainCode, relationshipTypes, domains);
  const items = useMemo(
    () =>
      options.map((o) => ({
        value: o.valueKey,
        label: o.attributeName,
        selectedLabel: ownerLabel
          ? `${o.groupLabel.split(' › ').pop() || o.groupLabel} · ${o.attributeName}`
          : o.path.length
          ? `${o.groupLabel} · ${o.attributeName}`
          : o.attributeName,
        group: o.groupLabel,
        hint: o.dataType?.toLowerCase(),
        search: o.attributeCode,
      })),
    [options, ownerLabel],
  );
  const selected = options.find(isSelected);
  return (
    <div className="field">
      {!bare && <label>{label}</label>}
      <TypeaheadSelect
        options={items}
        value={selected?.valueKey || ''}
        loading={loading}
        disabled={!rootDomainCode}
        placeholder={rootDomainCode ? placeholder : 'Choose an entity type first'}
        error={error}
        clearable={clearable}
        onChange={(key) => onSelect(options.find((o) => o.valueKey === key) || null)}
      />
      {error && <span className="field-error">Required</span>}
    </div>
  );
}
