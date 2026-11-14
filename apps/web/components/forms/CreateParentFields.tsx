'use client';

import { useEffect, useState } from 'react';
import {
  assignParentSlot,
  selectedParent,
  type CreateParentSlot,
  type ParentSelection,
} from '@/lib/create-parents';
import { graphqlQuery } from '@/lib/graphql';

const PARENT_PICK_QUERY = `
  query ParentPick($filter: EntityFilter, $pagination: PaginationInput) {
    entities(filter: $filter, pagination: $pagination) {
      totalCount
      edges { node { id entityCode entityName domainCode } }
    }
  }
`;

interface ParentHit {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
}

export function CreateParentFields({
  slots,
  summary,
  parents,
  children,
  errors,
  onChange,
}: {
  slots: CreateParentSlot[];
  summary: string;
  parents: ParentSelection[];
  children: ParentSelection[];
  errors: Record<string, string>;
  onChange: (next: { parentRelationships: ParentSelection[]; childRelationships: ParentSelection[] }) => void;
}) {
  if (slots.length === 0) return null;
  const requiredCount = slots.filter((slot) => slot.required).length;

  return (
    <div className="field-section">
      <div className="field-section-head">
        <div className="field-section-name">Parents</div>
        <div className="field-section-count">{requiredCount > 0 ? `${requiredCount} required` : slots.length}</div>
      </div>
      <div className="builder-body">
        {summary && <p className="create-parent-summary">{summary}</p>}
        <div className="create-parent-grid">
          {slots.map((slot) => (
            <ParentSlotField
              key={slot.key}
              slot={slot}
              selected={selectedParent(parents, children, slot)}
              error={errors[slot.key]}
              onSelect={(entry) => onChange(assignParentSlot(parents, children, slot, entry))}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ParentSlotField({
  slot,
  selected,
  error,
  onSelect,
}: {
  slot: CreateParentSlot;
  selected: ParentSelection | null;
  error?: string;
  onSelect: (entry: ParentSelection | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ParentHit[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open || selected) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setSearching(true);
      const term = search.trim();
      const { data } = await graphqlQuery<
        { entities: { totalCount: number; edges: Array<{ node: ParentHit }> } },
        { filter: { domainCode: string; entityName?: string; isActive: boolean }; pagination: { first: number } }
      >(PARENT_PICK_QUERY, {
        filter: {
          domainCode: slot.domainCode,
          isActive: true,
          ...(term ? { entityName: term } : {}),
        },
        pagination: { first: 8 },
      });
      if (cancelled) return;
      setResults((data?.entities?.edges || []).map((edge) => edge.node));
      setTotal(data?.entities?.totalCount || 0);
      setSearching(false);
    }, search.trim() ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, search, selected, slot.domainCode]);

  const choose = (entity: ParentHit) => {
    onSelect({
      entityId: entity.id,
      entityCode: entity.entityCode,
      entityName: entity.entityName,
      domainCode: entity.domainCode,
      relationshipCode: slot.relationshipCode,
      relationshipName: slot.relationshipName,
      isPrimary: true,
      validFrom: new Date().toISOString().split('T')[0],
    });
    setOpen(false);
    setSearch('');
    setResults([]);
  };

  return (
    <div className="field">
      <label htmlFor={`parent-${slot.key}`}>
        {slot.label}
        {slot.required && <span className="create-parent-required">*</span>}
      </label>
      {selected ? (
        <div className="create-parent-chosen">
          <div>
            <strong>{selected.entityName}</strong>
            <span className="mono">{selected.entityCode}</span>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => onSelect(null)}>Clear</button>
        </div>
      ) : (
        <>
          <input
            id={`parent-${slot.key}`}
            className={`text-input ${error ? 'error' : ''}`}
            value={search}
            placeholder={`Search ${plural(slot.label).toLowerCase()}`}
            autoComplete="off"
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onChange={(event) => {
              setSearch(event.target.value);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
          {open && (
            <div className="create-parent-results">
              {searching && <div className="create-parent-note">Searching…</div>}
              {results.map((entity) => (
                <button
                  key={entity.id}
                  type="button"
                  className="btn create-parent-hit"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(entity)}
                >
                  <strong>{entity.entityName}</strong>
                  <span className="mono">{entity.entityCode}</span>
                </button>
              ))}
              {!searching && results.length === 0 && (
                <div className="create-parent-note">No matching {plural(slot.label).toLowerCase()}.</div>
              )}
              {!searching && total > results.length && (
                <div className="create-parent-note">Type to narrow {total} {plural(slot.label).toLowerCase()}.</div>
              )}
            </div>
          )}
        </>
      )}
      {error && <span className="create-parent-error">{error}</span>}
    </div>
  );
}

function plural(label: string) {
  if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  if (/s$/i.test(label)) return label;
  return `${label}s`;
}
