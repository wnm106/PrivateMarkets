'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  graphqlQuery,
  graphqlMutation,
  CREATE_INTERSECTION_MUTATION,
  INTERSECTION_TYPE_QUERY,
  ENTITIES_QUERY,
} from '@/lib/graphql';

interface IntersectionTypeMember {
  id: string;
  domainCode: string;
  memberRole: string;
  isRequired: boolean;
  displayOrder: number;
}

interface IntersectionType {
  id: string;
  intersectionCode: string;
  intersectionName: string;
  description?: string;
  members: IntersectionTypeMember[];
}

interface SelectedMember {
  entityId: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  memberRole: string;
}

interface IntersectionFormProps {
  intersectionTypeCode: string;
  onSubmit: (data: any) => void;
  onCancel: () => void;
}

export function IntersectionForm({ intersectionTypeCode, onSubmit, onCancel }: IntersectionFormProps) {
  const [intersectionType, setIntersectionType] = useState<IntersectionType | null>(null);
  const [loadingType, setLoadingType] = useState(true);
  const [selectedMembers, setSelectedMembers] = useState<Record<string, SelectedMember>>({});
  const [searchingRole, setSearchingRole] = useState<string | null>(null);
  const [searchTerms, setSearchTerms] = useState<Record<string, string>>({});
  const [searchResults, setSearchResults] = useState<Record<string, any[]>>({});
  const [searching, setSearching] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingType(true);
    graphqlQuery<{ intersectionType: IntersectionType }, { intersectionCode: string }>(
      INTERSECTION_TYPE_QUERY,
      { intersectionCode: intersectionTypeCode }
    ).then(({ data }) => {
      if (cancelled) return;
      if (data?.intersectionType) {
        setIntersectionType(data.intersectionType);
        data.intersectionType.members.sort((a, b) => a.displayOrder - b.displayOrder);
      }
      setLoadingType(false);
    });
    return () => { cancelled = true; };
  }, [intersectionTypeCode]);

  const runSearch = useCallback(async (role: string, domainCode: string, term: string) => {
    if (!term || term.length < 2) {
      setSearchResults(prev => ({ ...prev, [role]: [] }));
      return;
    }
    setSearching(true);
    const { data } = await graphqlQuery<{ entities: { edges: { node: any }[] } }, any>(
      ENTITIES_QUERY,
      { filter: { entityName: term, domainCode }, pagination: { first: 10 } }
    );
    setSearchResults(prev => ({ ...prev, [role]: data?.entities?.edges?.map(e => e.node) || [] }));
    setSearching(false);
  }, []);

  useEffect(() => {
    if (!intersectionType) return;
    const timers: NodeJS.Timeout[] = [];
    for (const member of intersectionType.members) {
      const term = searchTerms[member.memberRole] || '';
      const t = setTimeout(() => {
        if (term.length >= 2) runSearch(member.memberRole, member.domainCode, term);
      }, 350);
      timers.push(t);
    }
    return () => timers.forEach(clearTimeout);
  }, [searchTerms, intersectionType, runSearch]);

  const handleMemberSelect = (member: IntersectionTypeMember, entity: any) => {
    setSelectedMembers(prev => ({
      ...prev,
      [member.memberRole]: {
        entityId: entity.id,
        entityCode: entity.entityCode,
        entityName: entity.entityName,
        domainCode: entity.domainCode,
        memberRole: member.memberRole,
      },
    }));
    setSearchTerms(prev => ({ ...prev, [member.memberRole]: '' }));
    setSearchResults(prev => ({ ...prev, [member.memberRole]: [] }));
    setSearchingRole(null);
    if (errors[member.memberRole]) {
      setErrors(prev => { const next = { ...prev }; delete next[member.memberRole]; return next; });
    }
  };

  const handleRemoveMember = (memberRole: string) => {
    setSelectedMembers(prev => { const next = { ...prev }; delete next[memberRole]; return next; });
  };

  const generateIntersectionCode = () => {
    const parts = Object.values(selectedMembers)
      .sort((a, b) => a.memberRole.localeCompare(b.memberRole))
      .map(m => m.entityCode);
    return parts.join('-');
  };

  const handleSubmit = async () => {
    if (!intersectionType) return;
    const newErrors: Record<string, string> = {};
    for (const member of intersectionType.members) {
      if (member.isRequired && !selectedMembers[member.memberRole]) {
        newErrors[member.memberRole] = member.memberRole + ' is required';
      }
    }
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }
    setSubmitting(true);
    const members = Object.values(selectedMembers).map(m => ({ entityId: m.entityId, memberRole: m.memberRole }));
    const { data, error } = await graphqlMutation<{ createIntersection: { intersection: any; errors: any[] } }, any>(
      CREATE_INTERSECTION_MUTATION,
      { input: { intersectionCode: generateIntersectionCode(), intersectionTypeCode, members, validFrom: new Date().toISOString().split('T')[0] } }
    );
    setSubmitting(false);
    if (data?.createIntersection?.intersection) { onSubmit(data.createIntersection.intersection); }
    else if (data?.createIntersection?.errors?.length) { setErrors({ submit: data.createIntersection.errors[0].message }); }
    else if (error) { setErrors({ submit: error.message || 'Failed to create intersection' }); }
  };

  if (loadingType) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--ink-3)' }}>Loading intersection type definition...</div>;
  }
  if (!intersectionType) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--red)' }}>Intersection type not found. Please define it in Entity Management first.</div>;
  }

  return (
    <div>
      <div style={{ marginBottom: '20px', padding: '12px 16px', background: 'var(--bg-2, #f5f5f5)', borderRadius: '6px' }}>
        <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '4px' }}>Creating</div>
        <div style={{ fontSize: '14px', fontWeight: 600 }}>{intersectionType.intersectionName}</div>
        {intersectionType.description && <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '4px' }}>{intersectionType.description}</div>}
      </div>

      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '10px' }}>
        Select Constituent Entities
      </div>

      <div style={{ display: 'grid', gap: '12px' }}>
        {intersectionType.members.map(member => {
          const selected = selectedMembers[member.memberRole];
          const isSearching = searchingRole === member.memberRole;
          const results = searchResults[member.memberRole] || [];
          const searchTerm = searchTerms[member.memberRole] || '';
          const error = errors[member.memberRole];
          return (
            <div key={member.memberRole} style={{ border: '1px solid ' + (error ? 'var(--red)' : 'var(--line)'), borderRadius: '6px', padding: '12px', background: 'var(--bg)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div>
                  <span style={{ fontSize: '13px', fontWeight: 600 }}>{member.memberRole}</span>
                  <span style={{ fontSize: '11px', color: 'var(--ink-3)', marginLeft: '8px' }}>({member.domainCode})</span>
                  {member.isRequired && <span style={{ fontSize: '10px', color: 'var(--red)', marginLeft: '8px', fontWeight: 600 }}>REQUIRED</span>}
                </div>
                {selected && <button type="button" onClick={() => handleRemoveMember(member.memberRole)} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: '12px' }}>Remove</button>}
              </div>
              {selected ? (
                <div style={{ fontSize: '13px', color: 'var(--ink-1)' }}>
                  <strong>{selected.entityName}</strong>
                  <span style={{ color: 'var(--ink-3)', marginLeft: '6px', fontSize: '11px' }}>({selected.domainCode} &middot; {selected.entityCode})</span>
                </div>
              ) : (
                <div>
                  <input className="text-input" placeholder={'Search ' + member.domainCode + ' entities by name...'} value={searchTerm} onChange={e => { setSearchTerms(prev => ({ ...prev, [member.memberRole]: e.target.value })); setSearchingRole(member.memberRole); }} onFocus={() => setSearchingRole(member.memberRole)} style={{ width: '100%' }} />
                  {searching && isSearching && <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '4px' }}>Searching...</div>}
                  {results.length > 0 && isSearching && (
                    <div style={{ display: 'grid', gap: '4px', marginTop: '8px', maxHeight: '140px', overflow: 'auto' }}>
                      {results.map(entity => (
                        <div key={entity.id} onClick={() => handleMemberSelect(member, entity)} style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: '4px', fontSize: '12px', cursor: 'pointer', background: 'var(--bg-2, #f5f5f5)' }}>
                          <strong>{entity.entityName}</strong>
                          <span style={{ color: 'var(--ink-3)', marginLeft: '6px' }}>({entity.domainCode} &middot; {entity.entityCode})</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {searchTerm.length >= 2 && !searching && results.length === 0 && isSearching && <div style={{ fontSize: '11px', color: 'var(--ink-3)', fontStyle: 'italic', marginTop: '4px' }}>No matching {member.domainCode} entities found.</div>}
                </div>
              )}
              {error && <div style={{ fontSize: '11px', color: 'var(--red)', marginTop: '4px' }}>{error}</div>}
            </div>
          );
        })}
      </div>

      {Object.keys(selectedMembers).length > 0 && (
        <div style={{ marginTop: '16px', padding: '12px', background: 'var(--bg-2, #f5f5f5)', borderRadius: '6px' }}>
          <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '6px' }}>Generated Intersection Code</div>
          <div style={{ fontSize: '14px', fontFamily: 'monospace', fontWeight: 600 }}>{generateIntersectionCode()}</div>
        </div>
      )}

      {errors.submit && <div style={{ marginTop: '12px', padding: '10px', background: '#fef2f2', border: '1px solid var(--red)', borderRadius: '6px', fontSize: '12px', color: 'var(--red)' }}>{errors.submit}</div>}

      <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', padding: '16px 0 0' }}>
        <button type="button" className="btn" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>{submitting ? 'Creating...' : 'Create Position'}</button>
      </div>
    </div>
  );
}
