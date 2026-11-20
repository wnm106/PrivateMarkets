'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { sources, type SourceKey } from '@/lib/data';
import { domainHref } from '@/lib/domain-routes';
import {
  entitiesFromConflicts,
  fieldsForEntity,
  valuesAgree,
  type ConflictRow,
  type LineageField,
  type ResolutionField,
  type SourceCandidate,
} from '@/lib/conflict-resolution';
import {
  CLEAR_MANUAL_OVERRIDE_MUTATION,
  DATA_QUALITY_DASHBOARD_QUERY,
  FIELD_LINEAGE_QUERY,
  SUBMIT_MANUAL_OVERRIDE_MUTATION,
  graphqlMutation,
  graphqlQuery,
} from '@/lib/graphql';
import { useTemporalStore } from '@/lib/store';
import { usePublishViewContext } from '@/lib/view-context';

type Choice = { kind: 'source'; source: string } | { kind: 'custom' };

const REASONS = ['Steward decision', 'Source error', 'Confirmed against a document', 'Normalization'];

function knowledgeArgument(knowledgeDate: string): string | null {
  const trimmed = knowledgeDate.trim();
  if (!trimmed || /^\d{4}-\d{2}-\d{2}$/.test(trimmed) && trimmed >= new Date().toISOString().slice(0, 10)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T23:59:59.999Z`;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() >= Date.now() - 1000) return null;
  return parsed.toISOString();
}

function sourcePaint(code: string) {
  const known = sources[code.toLowerCase() as SourceKey];
  const hex = known?.hex || '#475569';
  return { hex, name: known?.name };
}

function formatWhen(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16).replace('T', ' ');
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function chosenValue(field: ResolutionField, choice: Choice | undefined, custom: string): string | null {
  if (choice?.kind === 'custom') return custom.trim() || null;
  const source = choice?.kind === 'source' ? choice.source : field.candidates.find((row) => row.golden)?.source;
  return field.candidates.find((row) => row.source === source)?.value ?? null;
}

export function ConflictResolution() {
  const router = useRouter();
  const params = useSearchParams();
  const entityId = params.get('entity');
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const knownAt = useMemo(() => knowledgeArgument(knowledgeDate), [knowledgeDate]);

  const [conflicts, setConflicts] = useState<ConflictRow[]>([]);
  const [lineage, setLineage] = useState<LineageField[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingFields, setLoadingFields] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState(REASONS[0]);
  const [note, setNote] = useState('Resolved a source conflict.');
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const entities = useMemo(() => entitiesFromConflicts(conflicts), [conflicts]);
  const selected = entities.find((entity) => entity.id === entityId)
    ?? (entityId ? { id: entityId, entityCode: 'Record', entityName: 'This record', domainCode: '', conflictCount: 0 } : null);
  const entityConflicts = conflicts.filter((row) => row.id === entityId);
  const fields = useMemo(
    () => (entityId ? fieldsForEntity(lineage, entityConflicts) : []),
    [entityId, lineage, entityConflicts],
  );

  usePublishViewContext(selected ? {
    activity: 'editing',
    kind: 'conflict-resolution',
    label: selected.entityName,
    id: selected.id,
    entityId: selected.id,
    entityCode: selected.entityCode,
    domainCode: selected.domainCode,
    summary: `${fields.length} source ${fields.length === 1 ? 'conflict' : 'conflicts'} as of ${asOfDate}`,
    snapshot: {
      conflicts: fields.map((field) => ({
        attribute: field.attributeName,
        golden: field.candidates.find((row) => row.golden)?.value ?? field.currentValue,
        sources: field.candidates.map((row) => ({ source: row.sourceName, value: row.value, golden: row.golden })),
      })),
    },
  } : {
    activity: 'viewing',
    kind: 'conflict-resolution',
    label: 'Resolve conflicts',
    summary: loadingList ? 'Loading records with source conflicts.' : `${entities.length} records have a source conflict.`,
  });

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    setError(null);
    graphqlQuery<{ dataQualityDashboard: { consensusConflicts: ConflictRow[] } }, { toDate: string; knowledgeDate: string | null }>(
      DATA_QUALITY_DASHBOARD_QUERY,
      { toDate: asOfDate, knowledgeDate: knownAt },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data?.dataQualityDashboard) {
        setError(result.error?.message || 'Could not load source conflicts.');
        setConflicts([]);
      } else {
        setConflicts(result.data.dataQualityDashboard.consensusConflicts ?? []);
      }
      setLoadingList(false);
    });
    return () => { cancelled = true; };
  }, [asOfDate, knownAt]);

  useEffect(() => {
    if (!loadingList && !entityId && entities[0]) router.replace(`/resolve?entity=${entities[0].id}`);
  }, [loadingList, entityId, entities, router]);

  useEffect(() => {
    if (!entityId) {
      setLineage([]);
      return;
    }
    let cancelled = false;
    setLoadingFields(true);
    setChoices({});
    setCustomValues({});
    setSaved({});
    graphqlQuery<{ fieldLineage: LineageField[] }, { entityId: string; asOfDate: string; knowledgeDate: string | null }>(
      FIELD_LINEAGE_QUERY,
      { entityId, asOfDate, knowledgeDate: knownAt },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      if (result.error) setError(result.error.message || 'Could not load the source values.');
      setLineage(result.data?.fieldLineage ?? []);
      setLoadingFields(false);
    });
    return () => { cancelled = true; };
  }, [entityId, asOfDate, knownAt]);

  const openCount = fields.filter((field) => !saved[field.attributeCode]).length;
  const manualCount = fields.filter((field) => field.candidates.some((row) => row.source === 'MANUAL')).length;

  const chooseEntity = (id: string) => router.push(`/resolve?entity=${id}`);

  const applyField = async (field: ResolutionField) => {
    if (!entityId) return false;
    const choice = choices[field.attributeCode] ?? { kind: 'source' as const, source: field.candidates.find((row) => row.golden)?.source || '' };
    const value = chosenValue(field, choice, customValues[field.attributeCode] ?? '');
    if (!value) {
      setError(`${field.attributeName} needs a value before it can be kept.`);
      return false;
    }
    if (!note.trim()) {
      setError('A resolution note is required.');
      return false;
    }
    const golden = field.candidates.find((row) => row.golden);
    if (golden?.source === 'MANUAL' && valuesAgree(golden.value, value) && choice.kind === 'source') {
      setSaved((current) => ({ ...current, [field.attributeCode]: value }));
      return true;
    }
    setBusy(field.attributeCode);
    setError(null);
    const sourceName = choice.kind === 'source'
      ? field.candidates.find((row) => row.source === choice.source)?.sourceName
      : null;
    const result = await graphqlMutation<{ submitManualOverride: { success: boolean; errors: Array<{ message: string }> } }>(
      SUBMIT_MANUAL_OVERRIDE_MUTATION,
      {
        input: {
          entityId,
          attributeCode: field.attributeCode,
          value,
          validFrom: asOfDate,
          overrideReason: `${reason}. ${note.trim()}${sourceName ? ` Kept ${sourceName}.` : ''}`,
        },
      },
    );
    const saveError = result.error?.message || result.data?.submitManualOverride?.errors?.[0]?.message;
    if (saveError || !result.data?.submitManualOverride?.success) {
      setError(saveError || `Could not keep the value for ${field.attributeName}.`);
      setBusy(null);
      return false;
    }
    setSaved((current) => ({ ...current, [field.attributeCode]: value }));
    setBusy(null);
    const refresh = await graphqlQuery<{ fieldLineage: LineageField[] }, { entityId: string; asOfDate: string; knowledgeDate: string | null }>(
      FIELD_LINEAGE_QUERY,
      { entityId, asOfDate, knowledgeDate: knownAt },
      'network-only',
    );
    if (refresh.data?.fieldLineage) setLineage(refresh.data.fieldLineage);
    return true;
  };

  const applyAll = async () => {
    for (const field of fields) {
      if (saved[field.attributeCode]) continue;
      const kept = await applyField(field);
      if (!kept) return;
    }
  };

  const clearOverride = async (field: ResolutionField) => {
    if (!entityId) return;
    setBusy(field.attributeCode);
    setError(null);
    const result = await graphqlMutation<{ clearManualOverride: { success: boolean; errors: Array<{ message: string }> } }>(
      CLEAR_MANUAL_OVERRIDE_MUTATION,
      { input: { entityId, attributeCode: field.attributeCode, asOf: asOfDate } },
    );
    const saveError = result.error?.message || result.data?.clearManualOverride?.errors?.[0]?.message;
    if (saveError || !result.data?.clearManualOverride?.success) {
      setError(saveError || `Could not clear the override on ${field.attributeName}.`);
      setBusy(null);
      return;
    }
    setSaved((current) => {
      const next = { ...current };
      delete next[field.attributeCode];
      return next;
    });
    setChoices((current) => {
      const next = { ...current };
      delete next[field.attributeCode];
      return next;
    });
    setBusy(null);
    const refresh = await graphqlQuery<{ fieldLineage: LineageField[] }, { entityId: string; asOfDate: string; knowledgeDate: string | null }>(
      FIELD_LINEAGE_QUERY,
      { entityId, asOfDate, knowledgeDate: knownAt },
      'network-only',
    );
    if (refresh.data?.fieldLineage) setLineage(refresh.data.fieldLineage);
  };

  const recordHref = selected?.domainCode ? `${domainHref(selected.domainCode)}/${selected.id}` : '/quality';
  const nextEntity = selected ? entities[entities.findIndex((entity) => entity.id === selected.id) + 1] : undefined;

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        {selected?.domainCode && (
          <>
            <Link href={domainHref(selected.domainCode)} className="crumb-link">{selected.domainCode.toLowerCase().replace(/_/g, ' ')}</Link>
            <span className="sep">›</span>
            <Link href={recordHref} className="crumb-link">{selected.entityName}</Link>
            <span className="sep">›</span>
          </>
        )}
        <span className="crumb-current">Resolve conflicts</span>
      </div>

      <div className="resolve-header">
        <div className="resolve-eyebrow">Conflict resolution</div>
        <div className="resolve-title">
          {selected ? `${selected.entityName} · ${fields.length} ${fields.length === 1 ? 'conflict' : 'conflicts'}` : 'Resolve conflicts'}
        </div>
        <div className="resolve-sub">
          Choose the value that should win for each field. Keeping a value writes a manual override as of {asOfDate}, so a later sync does not replace it. Other sources stay on the record, and consensus still counts the field until they match.
        </div>
        {entities.length > 0 && (
          <div className="resolve-progress">
            <label htmlFor="resolve-entity" className="progress-label">Record</label>
            <select id="resolve-entity" className="select" value={selected?.id ?? ''} onChange={(event) => chooseEntity(event.target.value)}>
              {entities.map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.entityName} · {entity.conflictCount} {entity.conflictCount === 1 ? 'conflict' : 'conflicts'}
                </option>
              ))}
            </select>
            {fields.map((field) => (
              <div key={field.attributeCode} className={`progress-step ${saved[field.attributeCode] ? 'done' : ''}`} />
            ))}
            <span className="progress-label">{fields.length - openCount} of {fields.length} kept this session</span>
          </div>
        )}
      </div>

      {error && <div className="dq-error">{error}</div>}

      <div className="resolve-layout">
        <div>
          {loadingList && <div className="dq-empty">Loading records with source conflicts…</div>}
          {!loadingList && entities.length === 0 && <div className="dq-empty">No golden source disagrees with another active value.</div>}
          {selected && loadingFields && <div className="dq-empty">Loading source values…</div>}
          {selected && !loadingFields && fields.length === 0 && <div className="dq-empty">This record has no source conflict as of {asOfDate}.</div>}
          {selected && !loadingFields && fields.map((field, index) => (
            <FieldCard
              key={field.attributeCode}
              index={index + 1}
              field={field}
              choice={choices[field.attributeCode]}
              custom={customValues[field.attributeCode] ?? ''}
              savedValue={saved[field.attributeCode]}
              busy={busy === field.attributeCode}
              onChoose={(choice) => setChoices((current) => ({ ...current, [field.attributeCode]: choice }))}
              onCustom={(value) => {
                setCustomValues((current) => ({ ...current, [field.attributeCode]: value }));
                setChoices((current) => ({ ...current, [field.attributeCode]: { kind: 'custom' } }));
              }}
              onApply={() => applyField(field)}
              onClear={field.candidates.some((row) => row.source === 'MANUAL') ? () => clearOverride(field) : undefined}
            />
          ))}
        </div>

        <div className="resolve-summary-card">
          <div className="summary-head">Resolution summary</div>
          <div className="summary-row">
            <span className="l">Record</span>
            <span className="r">{selected?.entityCode ?? '—'}</span>
          </div>
          <div className="summary-row">
            <span className="l">Conflicts open</span>
            <span className="r" style={{ color: openCount ? 'var(--red)' : 'var(--green)' }}>{selected ? openCount : entities.length}</span>
          </div>
          <div className="summary-row">
            <span className="l">Kept this session</span>
            <span className="r" style={{ color: 'var(--green)' }}>{Object.keys(saved).length}</span>
          </div>
          <div className="summary-row">
            <span className="l">Manual overrides</span>
            <span className="r">{manualCount}</span>
          </div>
          <div className="summary-row">
            <span className="l">Records waiting</span>
            <span className="r">{entities.length}</span>
          </div>
          <div className="audit-note">
            <label htmlFor="resolve-reason">Reason</label>
            <select id="resolve-reason" className="select" value={reason} onChange={(event) => setReason(event.target.value)} style={{ width: '100%', marginBottom: 8 }}>
              {REASONS.map((item) => <option key={item}>{item}</option>)}
            </select>
            <label htmlFor="resolve-note">Resolution note</label>
            <textarea id="resolve-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
          <button type="button" className="summary-cta" disabled={!selected || busy != null || openCount === 0} onClick={applyAll}>
            {busy ? 'Saving…' : 'Apply all resolutions'}
          </button>
          {nextEntity && (
            <button type="button" className="summary-secondary" onClick={() => chooseEntity(nextEntity.id)}>
              Next record · {nextEntity.entityName}
            </button>
          )}
          <Link href={recordHref} className="summary-secondary" style={{ display: 'block', marginTop: 8, textAlign: 'center', textDecoration: 'none' }}>
            Back to the record
          </Link>
        </div>
      </div>
    </div>
  );
}

function FieldCard({
  index,
  field,
  choice,
  custom,
  savedValue,
  busy,
  onChoose,
  onCustom,
  onApply,
  onClear,
}: {
  index: number;
  field: ResolutionField;
  choice: Choice | undefined;
  custom: string;
  savedValue?: string;
  busy: boolean;
  onChoose: (choice: Choice) => void;
  onCustom: (value: string) => void;
  onApply: () => void;
  onClear?: () => void;
}) {
  const golden = field.candidates.find((row) => row.golden);
  const selectedSource = choice?.kind === 'source' ? choice.source : choice?.kind === 'custom' ? null : golden?.source;
  const saved = savedValue != null;
  return (
    <div className="conflict-card" style={saved ? undefined : { borderColor: 'var(--accent)', boxShadow: '0 0 0 2px #fef6ec' }}>
      <div className="conflict-card-head" style={saved ? { background: '#f0f7f2', borderBottomColor: '#c9e4d4' } : { background: '#fef6ec', borderBottomColor: '#f4d4a3' }}>
        <div className="left">
          <div className="conflict-num-large" style={{ color: saved ? 'var(--green)' : 'var(--accent)' }}>{String(index).padStart(2, '0')}</div>
          <div>
            <div className="conflict-field-name">{field.attributeName}</div>
            <div className="conflict-rule-applied">{field.rule || 'The golden source disagrees with another active value.'}</div>
          </div>
        </div>
        <span className={`severity-pill ${field.candidates.length > 3 ? 'high' : 'med'}`}>
          {saved ? 'Kept' : `${field.candidates.length} active values`}
        </span>
      </div>
      <div className="candidates-grid" role="radiogroup" aria-label={field.attributeName} style={{ gridTemplateColumns: `repeat(${Math.min(field.candidates.length + 1, 4)}, minmax(0, 1fr))` }}>
        {field.candidates.map((candidate) => (
          <CandidateCard
            key={candidate.source}
            candidate={candidate}
            selected={choice?.kind !== 'custom' && selectedSource === candidate.source}
            onSelect={() => onChoose({ kind: 'source', source: candidate.source })}
          />
        ))}
        <div className={`candidate ${choice?.kind === 'custom' ? 'selected' : ''}`} onClick={() => onChoose({ kind: 'custom' })} role="radio" aria-checked={choice?.kind === 'custom'} tabIndex={0}>
          <div className="candidate-head">
            <span className="src-badge" style={{ color: 'var(--ink-3)', borderColor: 'var(--line)', background: 'var(--bg)' }}>
              <span className="dot" style={{ background: 'var(--ink-3)' }} />
              Custom
            </span>
            {choice?.kind === 'custom' && <span className="candidate-flag selected">Selected</span>}
          </div>
          <input
            className="text-input"
            value={custom}
            placeholder="Enter a value"
            aria-label={`Custom value for ${field.attributeName}`}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onCustom(event.target.value)}
          />
          <div className="candidate-radio"><span className="radio-dot" /> Use this value</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px', justifyContent: 'flex-end' }}>
        {onClear && <button type="button" className="btn btn-sm" disabled={busy} onClick={onClear}>Clear the manual override</button>}
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={onApply}>{busy ? 'Saving…' : saved ? 'Keep again' : 'Keep this value'}</button>
      </div>
    </div>
  );
}

function CandidateCard({ candidate, selected, onSelect }: { candidate: SourceCandidate; selected: boolean; onSelect: () => void }) {
  const paint = sourcePaint(candidate.source);
  return (
    <div className={`candidate ${selected ? 'selected' : ''} ${candidate.golden && !selected ? 'winner' : ''}`} onClick={onSelect} role="radio" aria-checked={selected} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(); }}>
      <div className="candidate-head">
        <span className="src-badge" style={{ color: paint.hex, borderColor: `${paint.hex}40`, background: `${paint.hex}0a` }}>
          <span className="dot" style={{ background: paint.hex }} />
          {candidate.sourceName || paint.name || candidate.source}
        </span>
        {candidate.golden && <span className="candidate-flag winner">Golden</span>}
        {selected && !candidate.golden && <span className="candidate-flag selected">Selected</span>}
      </div>
      <div className={`candidate-value ${selected || candidate.golden ? '' : 'muted'}`}>{candidate.value}</div>
      <div className="candidate-meta">
        <span className="k">Received</span>
        <span className="v">{formatWhen(candidate.receivedAt)}</span>
        <span className="k">Rank</span>
        <span className="v">{candidate.precedenceRank || '—'}</span>
      </div>
      <div className="candidate-radio"><span className="radio-dot" />{selected ? 'Selected' : 'Use this value'}</div>
    </div>
  );
}
