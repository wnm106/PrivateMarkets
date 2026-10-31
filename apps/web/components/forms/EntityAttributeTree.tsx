'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { graphqlQuery, ATTRIBUTE_REGISTER_QUERY, RELATIONSHIP_TYPES_QUERY } from '@/lib/graphql';

export interface AttributeInfo {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  domainCode: string;
  description?: string;
}

export interface RelationshipHop {
  relationshipCode: string;
  direction: 'UP' | 'DOWN';
}

export interface SelectedAttribute {
  attribute: AttributeInfo;
  path: RelationshipHop[];
  pathLabel: string;
}

interface TreeNode {
  domainCode: string;
  attributes: AttributeInfo[];
  children: Array<{ relationshipCode: string; relationshipName: string; direction: 'UP' | 'DOWN'; targetDomainCode: string }>;
  expanded: boolean;
}

interface RelationshipType {
  relationshipCode: string;
  relationshipName: string;
  parentDomainCode: string;
  childDomainCode: string;
}

const domainCache = new Map<string, AttributeInfo[]>();

const getPathKey = (domainCode: string, path: RelationshipHop[]): string => {
  if (path.length === 0) return domainCode;
  return domainCode + ':' + path.map((h) => `${h.direction}:${h.relationshipCode}`).join('|');
};

const getPathFromKey = (pathKey: string): RelationshipHop[] => {
  if (!pathKey.includes(':')) return [];
  const pathStr = pathKey.split(':').slice(1).join(':');
  return pathStr.split('|').map((h) => {
    const parts = h.split(':');
    return { relationshipCode: parts.slice(1).join(':'), direction: parts[0] as 'UP' | 'DOWN' };
  });
};

export function EntityAttributeTree({
  rootDomainCode,
  onSelect,
  selectedCode,
  maxHeight = '500px',
}: {
  rootDomainCode: string;
  onSelect: (selection: SelectedAttribute) => void;
  selectedCode?: string;
  maxHeight?: string;
}) {
  const [tree, setTree] = useState<Map<string, TreeNode>>(new Map());
  const [loading, setLoading] = useState(true);
  const [searchFilter, setSearchFilter] = useState('');
  const [allRelationships, setAllRelationships] = useState<RelationshipType[]>([]);
  const relsLoaded = useRef(false);

  useEffect(() => {
    if (relsLoaded.current) return;
    relsLoaded.current = true;
    graphqlQuery<{ relationshipTypes: RelationshipType[] }, {}>(RELATIONSHIP_TYPES_QUERY, {}).then((r) => {
      if (r.data?.relationshipTypes) setAllRelationships(r.data.relationshipTypes);
    });
  }, []);

  const addNodeToTree = useCallback((domainCode: string, attributes: AttributeInfo[], path: RelationshipHop[], rels: RelationshipType[]) => {
    const pathKey = getPathKey(domainCode, path);
    const children = rels
      .filter((rt) => rt.parentDomainCode === domainCode || rt.childDomainCode === domainCode)
      .map((rt) => {
        const isParent = rt.parentDomainCode === domainCode;
        return {
          relationshipCode: rt.relationshipCode,
          relationshipName: rt.relationshipName,
          direction: (isParent ? 'DOWN' : 'UP') as 'UP' | 'DOWN',
          targetDomainCode: isParent ? rt.childDomainCode : rt.parentDomainCode,
        };
      });
    setTree((prev) => {
      const next = new Map(prev);
      const existing = next.get(pathKey);
      next.set(pathKey, { domainCode, attributes, children, expanded: existing?.expanded ?? path.length === 0 });
      return next;
    });
  }, []);

  const loadDomain = useCallback(async (domainCode: string, path: RelationshipHop[]) => {
    const cached = domainCache.get(domainCode);
    if (cached) { addNodeToTree(domainCode, cached, path, allRelationships); setLoading(false); return; }
    const attrResult = await graphqlQuery<{ attributeRegister: AttributeInfo[] }, { domainCode: string }>(
      ATTRIBUTE_REGISTER_QUERY, { domainCode }
    );
    const attributes = (attrResult.data?.attributeRegister || []).map((a) => ({ ...a, domainCode }));
    domainCache.set(domainCode, attributes);
    addNodeToTree(domainCode, attributes, path, allRelationships);
    setLoading(false);
  }, [allRelationships, addNodeToTree]);

  useEffect(() => {
    if (!rootDomainCode || allRelationships.length === 0) return;
    setLoading(true);
    loadDomain(rootDomainCode, []);
  }, [rootDomainCode, allRelationships.length]);

  const toggleExpand = (pathKey: string) => {
    setTree((prev) => {
      const next = new Map(prev);
      const node = next.get(pathKey);
      if (node) next.set(pathKey, { ...node, expanded: !node.expanded });
      return next;
    });
  };

  const handleChildClick = async (parentPathKey: string, childDomainCode: string, hop: RelationshipHop) => {
    const parentPath = getPathFromKey(parentPathKey);
    const newPath = [...parentPath, hop];
    const childPathKey = getPathKey(childDomainCode, newPath);
    if (tree.has(childPathKey)) { toggleExpand(childPathKey); return; }
    await loadDomain(childDomainCode, newPath);
  };

  const getPathLabel = (path: RelationshipHop[]): string => {
    const parts = [rootDomainCode];
    for (const hop of path) {
      const rel = allRelationships.find((r) => r.relationshipCode === hop.relationshipCode);
      if (rel) parts.push(hop.direction === 'DOWN' ? rel.childDomainCode : rel.parentDomainCode);
    }
    return parts.join(' › ');
  };

  const filteredAttrs = (attrs: AttributeInfo[]): AttributeInfo[] => {
    if (!searchFilter) return attrs;
    const lower = searchFilter.toLowerCase();
    return attrs.filter((a) => a.attributeName.toLowerCase().includes(lower) || a.attributeCode.toLowerCase().includes(lower));
  };

  const renderNode = (pathKey: string, depth: number): React.ReactNode => {
    const node = tree.get(pathKey);
    if (!node) return null;
    const path = getPathFromKey(pathKey);
    const attrs = filteredAttrs(node.attributes);

    return (
      <div key={pathKey} style={{ marginLeft: depth * 14 }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px',
            background: depth === 0 ? 'var(--accent-light)' : 'var(--bg-alt)',
            borderRadius: '4px', cursor: 'pointer', marginBottom: '3px',
          }}
          onClick={() => toggleExpand(pathKey)}
        >
          <span style={{ fontSize: '11px', color: 'var(--ink-3)', width: '10px' }}>{node.expanded ? '▼' : '▶'}</span>
          <span style={{ fontWeight: 600, fontSize: '12px' }}>{node.domainCode}</span>
          <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>({attrs.length})</span>
        </div>

        {node.expanded && (
          <div style={{ paddingLeft: '10px', borderLeft: '1px solid var(--line)', marginLeft: '8px' }}>
            {attrs.map((attr) => (
              <div
                key={attr.attributeCode}
                style={{
                  padding: '3px 8px', margin: '1px 0', borderRadius: '3px', cursor: 'pointer', fontSize: '11px',
                  background: selectedCode === attr.attributeCode ? 'var(--accent-light)' : 'transparent',
                  borderLeft: selectedCode === attr.attributeCode ? '2px solid var(--accent)' : '2px solid transparent',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect({ attribute: attr, path, pathLabel: getPathLabel(path) });
                }}
                title={attr.description || attr.attributeCode}
              >
                <span style={{ fontWeight: 500 }}>{attr.attributeName}</span>
                <span style={{ color: 'var(--ink-4)', marginLeft: '6px', fontSize: '11px' }}>{attr.dataType}</span>
              </div>
            ))}
            {node.children.map((child) => {
              const childPath = [...path, { relationshipCode: child.relationshipCode, direction: child.direction }];
              const childPathKey = getPathKey(child.targetDomainCode, childPath);
              const childLoaded = tree.has(childPathKey);
              const childExpanded = tree.get(childPathKey)?.expanded ?? false;
              return (
                <div key={child.relationshipCode + child.direction} style={{ marginTop: '3px' }}>
                  <div
                    style={{
                      display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 8px',
                      background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '3px',
                      cursor: 'pointer', fontSize: '11px',
                    }}
                    onClick={() => handleChildClick(pathKey, child.targetDomainCode, { relationshipCode: child.relationshipCode, direction: child.direction })}
                  >
                    <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>{childExpanded ? '▼' : '▶'}</span>
                    <span style={{ color: child.direction === 'DOWN' ? 'var(--green)' : 'var(--accent)', fontSize: '11px' }}>
                      {child.direction === 'DOWN' ? '↓' : '↑'}
                    </span>
                    <span style={{ fontWeight: 500 }}>{child.relationshipName}</span>
                    <span style={{ color: 'var(--ink-3)', fontSize: '11px' }}>→ {child.targetDomainCode}</span>
                  </div>
                  {childLoaded && childExpanded && renderNode(childPathKey, depth + 1)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  if (loading && tree.size === 0) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--ink-3)', fontSize: '12px' }}>Loading entity tree...</div>;
  }

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: '6px', background: 'var(--surface)' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
        <input
          type="text" className="text-input" placeholder="Search attributes..."
          value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)}
          style={{ width: '100%', fontSize: '12px' }}
        />
      </div>
      <div style={{ maxHeight, overflowY: 'auto', padding: '8px' }}>
        {Array.from(tree.keys()).filter((key) => !key.includes(':')).map((key) => renderNode(key, 0))}
      </div>
    </div>
  );
}

