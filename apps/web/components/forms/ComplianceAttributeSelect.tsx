'use client';

import { useEffect, useMemo, useState } from 'react';
import { ATTRIBUTE_REGISTER_QUERY, graphqlQuery } from '@/lib/graphql';

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
  if (code.startsWith(from) || code.endsWith(to) || code.startsWith(to)) score += 1;
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
  const [query, setQuery] = useState('');
  const selectedKey = attributeCode ? attributeValueKey(path, attributeCode) : '';

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((option) => {
      if (option.valueKey === selectedKey) return true;
      if (!q) return true;
      return (
        option.attributeName.toLowerCase().includes(q) ||
        option.attributeCode.toLowerCase().includes(q) ||
        option.groupLabel.toLowerCase().includes(q)
      );
    });
  }, [options, query, selectedKey]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const byLabel = new Map<string, TreeAttributeOption[]>();
    for (const option of visible) {
      if (!byLabel.has(option.groupLabel)) {
        order.push(option.groupLabel);
        byLabel.set(option.groupLabel, []);
      }
      byLabel.get(option.groupLabel)!.push(option);
    }
    return order.map((label) => ({ label, options: byLabel.get(label)! }));
  }, [visible]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      <input
        className="text-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={loading ? 'Loading related attributes…' : 'Search position, security, issuer, cash flow…'}
        style={{ height: '28px', fontSize: '11px' }}
      />
      <select
        className="select"
        value={selectedKey}
        onChange={(e) => {
          const option = options.find((item) => item.valueKey === e.target.value);
          if (!option) onChange('', []);
          else onChange(option.attributeCode, option.path);
        }}
        disabled={!rootDomainCode}
      >
        <option value="">{rootDomainCode ? placeholder : 'Choose an entity type first'}</option>
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.valueKey} value={option.valueKey}>
                {option.path.length ? `${option.groupLabel} · ${option.attributeName}` : option.attributeName}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
