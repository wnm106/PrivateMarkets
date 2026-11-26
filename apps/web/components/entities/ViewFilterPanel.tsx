'use client';

import { useEffect, useMemo, useState } from 'react';
import { ConditionGroup, type Domain, type RelationshipTypeOpt, type ComplianceCondition } from '@/components/forms/ComplianceRuleForm';
import { DOMAIN_TYPES_QUERY, RELATIONSHIP_TYPES_QUERY, graphqlQuery } from '@/lib/graphql';
import { domainLabel } from '@/lib/parent-entities';
import {
  conditionsFromInput,
  conditionsToInput,
  filterSummary,
  sameConditions,
  suggestPopulationCode,
  type PopulationConditionInput,
  type PopulationFilter,
} from '@/lib/population-filters';

/**
 * The population filter of a view in use: which saved filter narrows the
 * records, and, for this visit only, a changed copy of it or one built on the
 * spot. The conditions are edited by the same builder rules use, over the same
 * entity tree as the view. Nothing here touches the saved filter until a
 * person saves.
 */
export function ViewFilterPanel({
  domainCode,
  filters,
  savedId,
  onPickSaved,
  working,
  onWorking,
  onSave,
  onDeleteSaved,
  onCertify,
  onWithdraw,
  error,
}: {
  domainCode: string;
  filters: PopulationFilter[];
  /** The saved filter in use, or null. */
  savedId: string | null;
  onPickSaved: (id: string | null) => void;
  /** Temporary conditions in the builder's rows, or null to use the saved filter as it is. */
  working: ComplianceCondition[] | null;
  onWorking: (next: ComplianceCondition[] | null) => void;
  /** Save the working conditions: over the saved filter (id given) or as a new one (name given). */
  onSave: (args: { id: string | null; name: string; populationCode?: string | null; description?: string | null; conditions: PopulationConditionInput[] }) => Promise<string | null>;
  onDeleteSaved: (id: string) => void;
  /** Give the filter a code and description if it has none, then certify it. Administrators only; the server decides. */
  onCertify: (args: { filter: PopulationFilter; populationCode: string; description: string; note: string }) => Promise<boolean>;
  onWithdraw: (id: string) => void;
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [certifying, setCertifying] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [relationshipTypes, setRelationshipTypes] = useState<RelationshipTypeOpt[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      graphqlQuery<{ domainTypes: Domain[] }, Record<string, never>>(DOMAIN_TYPES_QUERY, {}, 'cache-first'),
      graphqlQuery<{ relationshipTypes: RelationshipTypeOpt[] }, Record<string, never>>(RELATIONSHIP_TYPES_QUERY, {}, 'cache-first'),
    ]).then(([dom, rel]) => {
      if (cancelled) return;
      setDomains(dom.data?.domainTypes || []);
      setRelationshipTypes(rel.data?.relationshipTypes || []);
    });
    return () => { cancelled = true; };
  }, []);

  const saved = useMemo(() => filters.find((filter) => filter.id === savedId) || null, [filters, savedId]);
  const workingInput = useMemo(() => (working ? conditionsToInput(working) : null), [working]);
  const activeRows = workingInput ?? saved?.conditions ?? [];
  const changed = Boolean(workingInput && (saved ? !sameConditions(workingInput, saved.conditions) : workingInput.length > 0));
  const builderRows = working ?? (saved ? conditionsFromInput(saved.conditions) : []);

  const startEditing = () => {
    if (!working) onWorking(saved ? conditionsFromInput(saved.conditions) : []);
    setOpen(true);
  };

  const save = async (id: string | null, filterName: string) => {
    if (!workingInput) return;
    setBusy(true);
    const savedAs = await onSave({
      id,
      name: filterName,
      // Keep what the saved filter already says about itself when it is updated in place.
      populationCode: id ? saved?.populationCode ?? null : code.trim() || null,
      description: id ? saved?.description ?? null : description.trim() || null,
      conditions: workingInput,
    });
    setBusy(false);
    if (savedAs) { setNaming(false); setName(''); setCode(''); setDescription(''); }
  };

  const startCertifying = () => {
    if (!saved) return;
    setCode(saved.populationCode || suggestPopulationCode(saved.filterName));
    setDescription(saved.description || '');
    setNote('');
    setCertifying(true);
  };

  const certify = async () => {
    if (!saved) return;
    setBusy(true);
    const done = await onCertify({ filter: saved, populationCode: code.trim(), description: description.trim(), note: note.trim() });
    setBusy(false);
    if (done) setCertifying(false);
  };

  const label = saved ? saved.filterName : activeRows.length ? 'Ad hoc filter' : 'No filter';

  return (
    <section className="view-filter" aria-label="Population filter">
      <div className="view-filter-bar">
        <label className="entity-views-picker">
          <span>Filter</span>
          <select
            className="xp-input"
            value={savedId || ''}
            onChange={(event) => { onPickSaved(event.target.value || null); onWorking(null); setNaming(false); }}
            aria-label="Choose a saved filter"
          >
            <option value="">{savedId === null && workingInput?.length ? 'Ad hoc filter' : 'No filter'}</option>
            {filters.map((filter) => <option key={filter.id} value={filter.id}>{filter.filterName}</option>)}
          </select>
        </label>
        <button type="button" className="btn btn-sm" onClick={() => (open ? setOpen(false) : startEditing())} aria-expanded={open}>
          {open ? 'Hide conditions' : saved ? 'Change for now' : 'Build a filter'}
        </button>
        {working && (
          <button type="button" className="btn btn-sm" onClick={() => { onWorking(null); setNaming(false); }}>
            {saved ? 'Back to saved' : 'Clear'}
          </button>
        )}
        {changed && saved && (
          <button type="button" className="btn btn-sm" disabled={busy} title={saved.certifiedAt ? 'Changing the conditions withdraws the certification' : undefined} onClick={() => { void save(saved.id, saved.filterName); }}>Update “{saved.filterName}”</button>
        )}
        {changed && !naming && (
          <button type="button" className="btn btn-sm" onClick={() => setNaming(true)}>Save as new filter</button>
        )}
        {saved && !working && !certifying && (
          saved.certifiedAt
            ? <button type="button" className="btn btn-sm" onClick={() => onWithdraw(saved.id)}>Withdraw certification</button>
            : <button type="button" className="btn btn-sm" onClick={startCertifying}>Certify…</button>
        )}
        {saved && !working && (
          <button type="button" className="btn btn-sm" onClick={() => {
            if (window.confirm(`Delete the filter "${saved.filterName}"? Views that use it will show every record.`)) onDeleteSaved(saved.id);
          }}>Delete filter</button>
        )}
        {saved && (
          <span className="view-filter-flag" role="status">
            {saved.certifiedAt ? `Certified${saved.populationCode ? ` · ${saved.populationCode}` : ''}` : 'Not certified'}
          </span>
        )}
        {changed && <span className="view-filter-flag" role="status">{saved ? 'Changed for this visit only' : 'Not saved'}</span>}
      </div>

      {naming && (
        <div className="view-filter-bar">
          <input
            className="xp-input"
            value={name}
            placeholder="Name the filter, e.g. Active EU funds"
            onChange={(event) => { setName(event.target.value); if (!code || code === suggestPopulationCode(name)) setCode(suggestPopulationCode(event.target.value)); }}
            aria-label="Filter name"
          />
          <input className="xp-input" value={code} placeholder="Code for the assistant" onChange={(event) => setCode(event.target.value.toUpperCase())} aria-label="Population code" />
          <input className="xp-input grow" value={description} placeholder="What this population means" onChange={(event) => setDescription(event.target.value)} aria-label="Description" />
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || !name.trim()} onClick={() => { void save(null, name.trim()); }}>
            {busy ? 'Saving…' : 'Save filter'}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => { setNaming(false); setName(''); }}>Cancel</button>
        </div>
      )}

      {certifying && saved && (
        <div className="view-filter-bar">
          <input className="xp-input" value={code} placeholder="Code, e.g. ACTIVE_FUNDS" onChange={(event) => setCode(event.target.value.toUpperCase())} aria-label="Population code" />
          <input className="xp-input grow" value={description} placeholder="What this population means (the assistant reads this)" onChange={(event) => setDescription(event.target.value)} aria-label="Description" />
          <input className="xp-input" value={note} placeholder="Note (optional)" onChange={(event) => setNote(event.target.value)} aria-label="Certification note" />
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || !code.trim() || !description.trim()} onClick={() => { void certify(); }}>
            {busy ? 'Certifying…' : 'Certify'}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setCertifying(false)}>Cancel</button>
        </div>
      )}

      <div className="view-filter-summary">
        <strong>{label}:</strong> {filterSummary(activeRows)}
      </div>
      {error && <div className="attr-table-error">{error}</div>}

      {open && (
        <div className="view-filter-builder">
          <ConditionGroup
            appliesTo="BASE"
            conditions={builderRows}
            rootDomainCode={domainCode}
            domainLabel={domainLabel(domainCode)}
            relationshipTypes={relationshipTypes}
            domains={domains}
            onCommit={(next) => onWorking(next)}
          />
        </div>
      )}
    </section>
  );
}
