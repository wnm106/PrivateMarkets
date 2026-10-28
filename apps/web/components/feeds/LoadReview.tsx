'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { dependencyLoadWaves } from '@/lib/feeds/load-order';
import {
  TRANSFORM_OPTIONS,
  applyTarget,
  domainLabel,
  feedMapFromAssignments,
  previewTransform,
  suggestListValues,
  targetKey,
  type ColumnAssignment,
  type MappingTarget,
} from '@/lib/feeds/suggest';

interface ReferenceListCatalog {
  listCode: string;
  values: { code: string; label: string; synonyms?: string[] | null }[];
}

interface LoadResult {
  created: number;
  matched: number;
  failed: number;
  attributesCreated: number;
  attributesUpdated: number;
  attributesUnchanged: number;
  relationshipsMatched: number;
  relationshipsCreated?: number;
}

const RECORD_PLURALS: Record<string, string> = {
  Issuer: 'Issuers',
  Fund: 'Funds',
  Security: 'Securities',
  Position: 'Positions',
  Deal: 'Deals',
  'Cash flow': 'Cash flows',
};

const TRANSFORM_CHIPS: Record<string, string> = {
  trim: 'Trims spaces',
  none: 'Keeps text',
  number: 'Removes commas',
  percent: 'Converts percents',
  date: 'Reads dates',
  uppercase: 'Uppercases',
  lowercase: 'Lowercases',
  list: 'Matches a list',
  replace: 'Replaces text',
};

function recordTypeName(code: string) {
  const label = domainLabel(code);
  return RECORD_PLURALS[label] || `${label}s`;
}

function needsDecision(assignment: ColumnAssignment) {
  if (assignment.role === 'ignore') return false;
  if (assignment.suggestion.method === 'manual' || assignment.suggestion.method === 'source_map') return false;
  return assignment.suggestion.confidence < 0.8;
}

function fieldLabel(assignment: ColumnAssignment, targets: MappingTarget[], nameAsIdentity?: Set<string>) {
  if (assignment.role === 'identity' && assignment.domainCode && nameAsIdentity?.has(assignment.domainCode)) {
    return `${domainLabel(assignment.domainCode)} · Name`;
  }
  const known = targets.find((target) => target.key === targetKey(assignment));
  if (known) return known.label;
  if (assignment.role === 'ignore') return 'Not loaded';
  if (assignment.role === 'as_of') return 'As-of date';
  if (assignment.role === 'filter') return 'Row filter';
  return `${domainLabel(assignment.domainCode)} · ${assignment.attributeCode || assignment.role}`;
}

function formatLongDate(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return iso;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function storedValue(assignment: ColumnAssignment, source: string) {
  return assignment.transform.values?.find((entry) => entry.from === source)?.to ?? '';
}

function withStoredValue(assignment: ColumnAssignment, source: string, to: string): ColumnAssignment {
  const next = (assignment.transform.values || []).filter((entry) => entry.from !== source);
  if (to) next.push({ from: source, to });
  return { ...assignment, transform: { ...assignment.transform, values: next } };
}

function defaultOtherKey(assignment: ColumnAssignment, targets: MappingTarget[]) {
  const current = targetKey(assignment);
  const words = [...new Set(
    assignment.sourceColumn.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2)
  )];
  let best: { key: string; score: number } | null = null;
  for (const target of targets) {
    if (target.key === current || target.role === 'ignore' || target.role === 'as_of' || target.role === 'filter') continue;
    const label = target.label.toLowerCase();
    const score = words.reduce((sum, word) => sum + (label.includes(word) ? word.length : 0), 0);
    if (score > (best?.score || 0)) best = { key: target.key, score };
  }
  return best?.key
    || targets.find((target) => target.role === 'attribute' && target.domainCode === assignment.domainCode && target.key !== current)?.key
    || targets.find((target) => target.key !== current && target.key !== 'ignore' && target.role !== 'as_of' && target.role !== 'filter')?.key
    || 'ignore';
}

function acceptSuggestion(assignment: ColumnAssignment): ColumnAssignment {
  return {
    ...assignment,
    suggestion: {
      method: 'manual',
      confidence: 1,
      reason: assignment.suggestion.reason || 'You confirmed this field.',
    },
  };
}

export function LoadReview({
  fileId,
  fileName,
  rowCount,
  assignments,
  targets,
  lists,
  resultText,
  errorMessage,
  mapNote,
  loading,
  asOfMode,
  asOfDate,
  chosenDate,
  onAsOfMode,
  onAsOfDate,
  onChange,
  onLoad,
  onClose,
}: {
  fileId: string;
  fileName: string;
  rowCount: number;
  assignments: ColumnAssignment[];
  targets: MappingTarget[];
  lists: ReferenceListCatalog[];
  resultText: string | null;
  errorMessage: string | null;
  mapNote?: string | null;
  loading: boolean;
  asOfMode: 'today' | 'specific';
  asOfDate: string;
  chosenDate: string;
  onAsOfMode: (mode: 'today' | 'specific') => void;
  onAsOfDate: (value: string) => void;
  onChange: (index: number, next: ColumnAssignment) => void;
  onLoad: () => void;
  onClose: () => void;
}) {
  const columnsRef = useRef<HTMLElement>(null);
  const baselineFile = useRef(fileId);
  const baselineStore = useRef<Record<string, ColumnAssignment>>({});
  const [fundHint, setFundHint] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editKey, setEditKey] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { choice: 'suggested' | 'other' | 'skip'; otherKey: string }>>({});

  if (baselineFile.current !== fileId) {
    baselineFile.current = fileId;
    baselineStore.current = {};
  }
  for (const assignment of assignments) {
    if (!baselineStore.current[assignment.sourceColumn] && needsDecision(assignment)) {
      baselineStore.current[assignment.sourceColumn] = assignment;
    }
  }
  const baselines = baselineStore.current;

  useEffect(() => {
    setDrafts({});
    setEditing(null);
    setFundHint(false);
  }, [fileId]);

  const nameAsIdentity = useMemo(() => {
    const domains = new Set<string>();
    for (const assignment of assignments) {
      if (assignment.role !== 'identity' || !assignment.domainCode) continue;
      const separateName = assignments.some((other) => other.role === 'name' && other.domainCode === assignment.domainCode && other.sourceColumn !== assignment.sourceColumn);
      if (!separateName) domains.add(assignment.domainCode);
    }
    return domains;
  }, [assignments]);

  const targetsByGroup = useMemo(() => {
    const groups = new Map<string, MappingTarget[]>();
    for (const target of targets) {
      const list = groups.get(target.group) || [];
      list.push(target);
      groups.set(target.group, list);
    }
    return [...groups.entries()];
  }, [targets]);

  const plan = useMemo(() => {
    try {
      const map = feedMapFromAssignments(assignments);
      const waves = map.domains.length > 0 ? dependencyLoadWaves(map.domains) : [];
      const order = waves.flat();
      const steps = order.map((code) => {
        const domain = map.domains.find((item) => item.domainCode === code);
        const identity = assignments.find((assignment) => assignment.sourceColumn === domain?.identityColumn);
        const parents = [...new Set((domain?.parents || []).map((parent) => parent.parentDomainCode))];
        const identifiedBy = domain?.identityColumn && domain.identityColumn === domain.nameColumn
          ? `${domainLabel(code)} · Name`
          : identity ? fieldLabel(identity, targets) : domainLabel(code);
        return {
          code,
          count: identity?.distinctCount ?? 0,
          identifiedBy,
          parents,
        };
      });
      return { steps, hasFund: map.domains.some((domain) => domain.domainCode === 'FUND'), hasPosition: map.domains.some((domain) => domain.domainCode === 'POSITION') };
    } catch {
      return { steps: [] as { code: string; count: number; identifiedBy: string; parents: string[] }[], hasFund: false, hasPosition: false };
    }
  }, [assignments, targets]);

  const pending = assignments.filter(needsDecision);
  const confident = assignments.length - pending.length;
  const ready = pending.length === 0 && plan.steps.length > 0;
  const recordTotal = plan.steps.reduce((sum, step) => sum + step.count, 0);
  const loadCount = recordTotal > 0 ? recordTotal : rowCount;
  const maxCount = Math.max(1, ...plan.steps.map((step) => step.count));
  const decisionKeys = useMemo(() => new Set(Object.keys(baselines)), [baselines]);

  function assignTarget(assignment: ColumnAssignment, target: MappingTarget) {
    const next = applyTarget(assignment, target);
    const list = lists.find((item) => item.listCode === target.referenceListCode);
    if (list) {
      next.transform = {
        ...next.transform,
        kind: 'list',
        values: suggestListValues(next.distinctValues || [], list.values),
      };
    }
    return next;
  }

  function draftFor(assignment: ColumnAssignment) {
    const existing = drafts[assignment.sourceColumn];
    if (existing) return existing;
    const other = targets.find((target) => target.key === defaultOtherKey(assignment, targets));
    return {
      choice: (assignment.role === 'ignore' ? 'skip' : 'suggested') as 'suggested' | 'other' | 'skip',
      otherKey: other?.key || 'ignore',
    };
  }

  function confirmDecision(index: number, assignment: ColumnAssignment) {
    const draft = draftFor(assignment);
    if (draft.choice === 'suggested') {
      onChange(index, acceptSuggestion(assignment));
      return;
    }
    if (draft.choice === 'skip') {
      const ignore = targets.find((target) => target.key === 'ignore');
      const next = ignore ? assignTarget(assignment, ignore) : { ...assignment, role: 'ignore' as const, domainCode: null, attributeCode: null, parentDomainCode: null };
      onChange(index, {
        ...next,
        suggestion: { method: 'manual', confidence: 1, reason: 'You left this column out.' },
      });
      return;
    }
    const target = targets.find((item) => item.key === draft.otherKey);
    if (target) onChange(index, assignTarget(assignment, target));
  }

  function undoDecision(index: number, assignment: ColumnAssignment) {
    const baseline = baselines[assignment.sourceColumn];
    if (baseline) onChange(index, baseline);
  }

  const groups = useMemo(() => {
    const placed = new Set<string>();
    const buckets: { key: string; title: string; countLabel: string; rows: { assignment: ColumnAssignment; index: number }[] }[] = [];
    const rowsFor = (match: (assignment: ColumnAssignment) => boolean) =>
      assignments.flatMap((assignment, index) => {
        if (needsDecision(assignment) || decisionKeys.has(assignment.sourceColumn) || placed.has(assignment.sourceColumn) || !match(assignment)) return [];
        placed.add(assignment.sourceColumn);
        return [{ assignment, index }];
      });

    for (const step of plan.steps) {
      const rows = rowsFor((assignment) => assignment.domainCode === step.code && assignment.role !== 'ignore');
      if (rows.length === 0) continue;
      buckets.push({
        key: step.code,
        title: recordTypeName(step.code),
        countLabel: `${step.count.toLocaleString()} records`,
        rows,
      });
    }
    const leftovers = rowsFor((assignment) => Boolean(assignment.domainCode) && assignment.role !== 'ignore');
    const byDomain = new Map<string, { assignment: ColumnAssignment; index: number }[]>();
    for (const row of leftovers) {
      const code = row.assignment.domainCode || '';
      const list = byDomain.get(code) || [];
      list.push(row);
      byDomain.set(code, list);
    }
    for (const [code, rows] of byDomain) {
      buckets.push({ key: code, title: recordTypeName(code), countLabel: 'No identifier yet', rows });
    }
    const fileRows = rowsFor((assignment) => assignment.role === 'as_of' || assignment.role === 'filter');
    if (fileRows.length > 0) buckets.push({ key: 'file', title: 'File', countLabel: 'Applies to the load', rows: fileRows });
    const skipped = rowsFor((assignment) => assignment.role === 'ignore');
    if (skipped.length > 0) buckets.push({ key: 'skip', title: 'Not loaded', countLabel: `${skipped.length} column${skipped.length === 1 ? '' : 's'}`, rows: skipped });
    return buckets;
  }, [assignments, baselines, decisionKeys, plan.steps]);

  const columnSummary = pending.length === 0
    ? `${assignments.length} column${assignments.length === 1 ? '' : 's'}, all confirmed.`
    : `${assignments.length} column${assignments.length === 1 ? '' : 's'}. We’re confident about ${confident}; ${pending.length} need${pending.length === 1 ? 's' : ''} your decision.`;

  return (
    <div className="load-review">
      <div className="load-review-body">
        <div className="load-review-inner">
          <div className="crumbs">
            <button type="button" className="crumb-link load-crumb" onClick={onClose}>Load data</button>
            <span className="sep">›</span>
            <span className="crumb-current">{fileName}</span>
          </div>
          <h1 className="load-title">Load {fileName}</h1>
          <p className="load-sub">{rowCount.toLocaleString()} rows. Three steps: check what’s in the file, confirm where each column goes, then load.</p>
          {mapNote && <p className="load-sub" style={{ marginTop: 8 }}>{mapNote}</p>}
          {resultText && (
            <p className="load-sub" style={{ marginTop: -8 }}>
              Last load: {resultText}{errorMessage ? ` ${errorMessage}` : ''}
            </p>
          )}

          <section className="load-section">
            <div className="load-sh">
              <span className="load-step-n">1</span>
              <div>
                <h2>What’s in this file</h2>
                <p className="load-sub">
                  {plan.steps.length === 0
                    ? 'No record types yet. Map a column to a code or a name in step 2.'
                    : `We found ${plan.steps.length} record type${plan.steps.length === 1 ? '' : 's'}. Priority sets the load order, so each record’s parent already exists when it loads.`}
                </p>
              </div>
            </div>
            {plan.steps.length > 0 && (
              <div className="load-card">
                <div className="load-ent load-ent-head">
                  <span>Priority</span>
                  <span>Record type</span>
                  <span>Records in file</span>
                  <span>Needs first</span>
                </div>
                {plan.steps.map((step, index) => (
                  <div key={step.code} className="load-ent">
                    <span className="load-pr">{index + 1}</span>
                    <div>
                      <b>{recordTypeName(step.code)}</b>
                      <small>Identified by {step.identifiedBy}</small>
                    </div>
                    <div className="load-cnt">
                      <b>{step.count.toLocaleString()}</b>
                      <span className="load-bar"><i style={{ width: `${Math.max(4, (step.count / maxCount) * 100)}%` }} /></span>
                    </div>
                    <span className="load-dep">{step.parents.length === 0 ? 'Nothing, loads first' : step.parents.map(recordTypeName).join(', ')}</span>
                  </div>
                ))}
                {plan.hasPosition && !plan.hasFund && (
                  <div className="load-note">
                    <span>No fund column was found, so positions won’t be linked to a fund.</span>
                    <button
                      type="button"
                      className="load-link"
                      onClick={() => {
                        setFundHint(true);
                        columnsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                    >
                      Add a fund column
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="load-section" ref={columnsRef}>
            <div className="load-sh">
              <span className="load-step-n">2</span>
              <div>
                <h2>Confirm where each column goes</h2>
                <p className="load-sub">{columnSummary}</p>
              </div>
            </div>
            {fundHint && (
              <p className="load-sub">Map a column to Fund · Code or Fund · Name. Positions will link to that fund on the next load.</p>
            )}

            {assignments.map((assignment, index) => {
              if (needsDecision(assignment)) {
                return (
                  <DecisionCard
                    key={assignment.sourceColumn}
                    assignment={assignment}
                    targets={targets}
                    targetsByGroup={targetsByGroup}
                    lists={lists}
                    nameAsIdentity={nameAsIdentity}
                    draft={draftFor(assignment)}
                    onDraft={(next) => setDrafts((current) => ({ ...current, [assignment.sourceColumn]: next }))}
                    onConfirm={() => confirmDecision(index, assignment)}
                    onChange={(next) => onChange(index, next)}
                  />
                );
              }
              if (!decisionKeys.has(assignment.sourceColumn)) return null;
              const label = assignment.role === 'ignore' ? null : fieldLabel(assignment, targets, nameAsIdentity);
              return (
                <div key={assignment.sourceColumn} className="load-attn is-done">
                  <span className="load-tag ok">Confirmed</span>
                  <p style={{ margin: '8px 0 0' }}>
                    <b>{assignment.sourceColumn}</b>
                    {label ? <> → <b>{label}</b></> : ' will not be loaded'}
                    .{' '}
                    <button type="button" className="load-link" onClick={() => undoDecision(index, assignment)}>Undo</button>
                  </p>
                </div>
              );
            })}

            {groups.map((group) => (
              <div key={group.key} className="load-card load-grp">
                <div className="load-gh">
                  <b>{group.title}</b>
                  <span>{group.countLabel}</span>
                </div>
                {group.rows.map(({ assignment, index }) => (
                  <ColumnRow
                    key={assignment.sourceColumn}
                    assignment={assignment}
                    targets={targets}
                    targetsByGroup={targetsByGroup}
                    lists={lists}
                    nameAsIdentity={nameAsIdentity}
                    editing={editing === assignment.sourceColumn}
                    editKey={editKey}
                    onEdit={() => {
                      setEditing(assignment.sourceColumn);
                      setEditKey(targetKey(assignment));
                    }}
                    onEditKey={setEditKey}
                    onDone={() => {
                      const target = targets.find((item) => item.key === editKey);
                      if (target) onChange(index, assignTarget(assignment, target));
                      setEditing(null);
                    }}
                    onChange={(next) => onChange(index, next)}
                  />
                ))}
              </div>
            ))}
          </section>

          <section className="load-section">
            <div className="load-sh">
              <span className="load-step-n">3</span>
              <div>
                <h2>When do these values apply?</h2>
                <p className="load-sub">Pick the as-of date to stamp on everything you load.</p>
              </div>
            </div>
            <div className="load-card load-when">
              <div className="load-seg" role="radiogroup" aria-label="As-of date">
                <label>
                  <input type="radio" name="when" checked={asOfMode === 'today'} onChange={() => onAsOfMode('today')} />
                  Today
                </label>
                <label>
                  <input type="radio" name="when" checked={asOfMode === 'specific'} onChange={() => onAsOfMode('specific')} />
                  A specific date
                </label>
              </div>
              <input
                type="date"
                aria-label="As-of date"
                value={asOfMode === 'today' ? chosenDate : asOfDate}
                disabled={asOfMode === 'today'}
                onChange={(event) => onAsOfDate(event.target.value)}
              />
              <span className="load-sub">Values will be stored as of {formatLongDate(chosenDate)}.</span>
            </div>
          </section>
        </div>
      </div>

      <div className="load-review-bar">
        <div className="load-review-inner load-bar-row">
          <div className="load-prog">
            <p aria-live="polite">
              {pending.length > 0 ? (
                <><b>{confident} of {assignments.length}</b> columns confirmed · {pending.length} need{pending.length === 1 ? 's' : ''} a decision</>
              ) : plan.steps.length === 0 ? (
                <>Map a code or a name before loading</>
              ) : (
                <><b>{assignments.length} of {assignments.length}</b> columns confirmed · ready to load</>
              )}
            </p>
            <div className="load-pb"><i style={{ width: `${assignments.length === 0 ? 0 : (confident / assignments.length) * 100}%` }} /></div>
          </div>
          <span className="load-bar-actions">
            <button type="button" className="load-btn sec" disabled={loading} onClick={onClose}>Cancel</button>
            <button type="button" className="load-btn" disabled={!ready || loading} onClick={onLoad}>
              {loading ? 'Loading…' : `Load ${loadCount.toLocaleString()} records`}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function optionLabel(target: MappingTarget, nameAsIdentity?: Set<string>) {
  if (target.role === 'identity' && target.domainCode && nameAsIdentity?.has(target.domainCode)) {
    return `${domainLabel(target.domainCode)} · Name`;
  }
  return target.label;
}

function TargetSelect({
  value,
  targets,
  targetsByGroup,
  nameAsIdentity,
  onChange,
  ariaLabel,
}: {
  value: string;
  targets: MappingTarget[];
  targetsByGroup: [string, MappingTarget[]][];
  nameAsIdentity?: Set<string>;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const known = targets.some((target) => target.key === value);
  return (
    <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
      {!known && <option value={value}>{value}</option>}
      {targetsByGroup.map(([group, groupTargets]) => (
        <optgroup key={group} label={group}>
          {groupTargets.filter((target) => !(target.role === 'name' && target.domainCode && nameAsIdentity?.has(target.domainCode))).map((target) => (
            <option key={target.key} value={target.key}>{optionLabel(target, nameAsIdentity)}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function DecisionCard({
  assignment,
  targets,
  targetsByGroup,
  lists,
  nameAsIdentity,
  draft,
  onDraft,
  onConfirm,
  onChange,
}: {
  assignment: ColumnAssignment;
  targets: MappingTarget[];
  targetsByGroup: [string, MappingTarget[]][];
  lists: ReferenceListCatalog[];
  nameAsIdentity: Set<string>;
  draft: { choice: 'suggested' | 'other' | 'skip'; otherKey: string };
  onDraft: (next: { choice: 'suggested' | 'other' | 'skip'; otherKey: string }) => void;
  onConfirm: () => void;
  onChange: (next: ColumnAssignment) => void;
}) {
  const suggested = fieldLabel(assignment, targets, nameAsIdentity);
  const target = targets.find((item) => item.key === targetKey(assignment));
  const list = lists.find((item) => item.listCode === target?.referenceListCode) || null;
  const valueCount = assignment.distinctValues?.length || 0;
  return (
    <div className="load-attn">
      <span className="load-tag">Needs your decision</span>
      <h2 className="load-ask">Where should <em>{assignment.sourceColumn}</em> go?</h2>
      <p className="load-sub">{assignment.suggestion.reason}</p>
      <div className="load-opts">
        {assignment.role !== 'ignore' && (
          <label className="load-opt">
            <input type="radio" name={`decision-${assignment.sourceColumn}`} checked={draft.choice === 'suggested'} onChange={() => onDraft({ ...draft, choice: 'suggested' })} />
            <span>
              <b>Store on {suggested}</b> <span className="load-chip">Suggested</span>
              <small>Use the suggested field for this column.</small>
            </span>
          </label>
        )}
        <label className="load-opt">
          <input type="radio" name={`decision-${assignment.sourceColumn}`} checked={draft.choice === 'other'} onChange={() => onDraft({ ...draft, choice: 'other' })} />
          <span>
            <b>Choose a different field</b>
            <small>
              <TargetSelect
                ariaLabel={`Field for ${assignment.sourceColumn}`}
                value={draft.otherKey}
                targets={targets}
                targetsByGroup={targetsByGroup}
                nameAsIdentity={nameAsIdentity}
                onChange={(otherKey) => onDraft({ choice: 'other', otherKey })}
              />
            </small>
          </span>
        </label>
        <label className="load-opt">
          <input type="radio" name={`decision-${assignment.sourceColumn}`} checked={draft.choice === 'skip'} onChange={() => onDraft({ ...draft, choice: 'skip' })} />
          <span>
            <b>Don’t load this column</b>
            <small>{suggested} stays blank for these records.</small>
          </span>
        </label>
      </div>
      {valueCount > 0 && (
        <ValueCheck assignment={assignment} list={list} fieldName={target?.label || assignment.sourceColumn} onChange={onChange} />
      )}
      <p style={{ margin: '14px 0 0' }}>
        <button type="button" className="load-btn" onClick={onConfirm}>Confirm choice</button>
      </p>
    </div>
  );
}

function ColumnRow({
  assignment,
  targets,
  targetsByGroup,
  lists,
  nameAsIdentity,
  editing,
  editKey,
  onEdit,
  onEditKey,
  onDone,
  onChange,
}: {
  assignment: ColumnAssignment;
  targets: MappingTarget[];
  targetsByGroup: [string, MappingTarget[]][];
  lists: ReferenceListCatalog[];
  nameAsIdentity: Set<string>;
  editing: boolean;
  editKey: string;
  onEdit: () => void;
  onEditKey: (value: string) => void;
  onDone: () => void;
  onChange: (next: ColumnAssignment) => void;
}) {
  const sample = assignment.samples.slice(0, 3).join(', ');
  const transformed = assignment.samples[0] ? previewTransform(assignment.samples[0], assignment.transform) : '';
  const target = targets.find((item) => item.key === targetKey(assignment));
  const list = lists.find((item) => item.listCode === target?.referenceListCode) || null;
  const showValues = assignment.role !== 'ignore' && (assignment.distinctCount || 0) > 0 && (assignment.distinctCount || 0) <= 40;
  const quiet = assignment.role === 'ignore';
  return (
    <div className="load-row-wrap">
      <div className="load-row">
        <div className="load-col">
          <b>{assignment.sourceColumn}</b>
          <small>
            {sample || '—'}
            {assignment.samples[0] && transformed && transformed !== assignment.samples[0] ? ` → ${transformed}` : ''}
          </small>
        </div>
        <div className="load-to">
          {!quiet && <span className="load-ok" aria-hidden="true">✓</span>}
          {editing ? (
            <TargetSelect ariaLabel={`Field for ${assignment.sourceColumn}`} value={editKey} targets={targets} targetsByGroup={targetsByGroup} nameAsIdentity={nameAsIdentity} onChange={onEditKey} />
          ) : (
            <span className="load-field">{fieldLabel(assignment, targets, nameAsIdentity)}</span>
          )}
          {assignment.role !== 'ignore' && (
            <select
              className="load-chip-select"
              aria-label={`Clean up ${assignment.sourceColumn}`}
              value={assignment.transform.kind}
              onChange={(event) => onChange({
                ...assignment,
                transform: { ...assignment.transform, kind: event.target.value as ColumnAssignment['transform']['kind'] },
              })}
            >
              {TRANSFORM_OPTIONS.map((option) => (
                <option key={option.kind} value={option.kind}>{TRANSFORM_CHIPS[option.kind] || option.label}</option>
              ))}
            </select>
          )}
          <span className="load-why">{assignment.suggestion.reason}</span>
          {assignment.role === 'filter' && (
            <input
              className="load-filter"
              value={assignment.filterEquals || ''}
              placeholder="Keep rows equal to"
              aria-label={`Rows to keep for ${assignment.sourceColumn}`}
              onChange={(event) => onChange({ ...assignment, filterEquals: event.target.value })}
            />
          )}
          {assignment.transform.kind === 'replace' && (
            <span className="load-replace">
              <input
                value={assignment.transform.find || ''}
                placeholder="Find"
                aria-label={`Find in ${assignment.sourceColumn}`}
                onChange={(event) => onChange({ ...assignment, transform: { ...assignment.transform, find: event.target.value } })}
              />
              <input
                value={assignment.transform.replaceWith || ''}
                placeholder="Replace"
                aria-label={`Replace in ${assignment.sourceColumn}`}
                onChange={(event) => onChange({ ...assignment, transform: { ...assignment.transform, replaceWith: event.target.value } })}
              />
            </span>
          )}
        </div>
        <button type="button" className="load-link" onClick={editing ? onDone : onEdit}>{editing ? 'Done' : 'Change'}</button>
      </div>
      {showValues && (
        <div className="load-values-pad">
          <ValueCheck assignment={assignment} list={list} fieldName={target?.label || assignment.sourceColumn} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

function ValueCheck({
  assignment,
  list,
  fieldName,
  onChange,
}: {
  assignment: ColumnAssignment;
  list: ReferenceListCatalog | null;
  fieldName: string;
  onChange: (next: ColumnAssignment) => void;
}) {
  const values = assignment.distinctValues || [];
  const peak = Math.max(1, ...values.map((item) => item.count));
  const unmatched = list ? values.filter((item) => !storedValue(assignment, item.value)).length : 0;
  const shown = values.slice(0, 12);
  return (
    <details className="load-details">
      <summary>Check the {assignment.distinctCount?.toLocaleString() || values.length} value{values.length === 1 ? '' : 's'} in this column</summary>
      {list ? (
        <div className="load-value-map">
          <p className="load-sub">
            Match each value to {list.listCode.replace(/_/g, ' ').toLowerCase()}.
            {unmatched > 0 ? ` ${unmatched} are not in the list and will be stored as typed.` : ' Every value matches.'}
          </p>
          {values.map((item) => {
            const chosen = storedValue(assignment, item.value);
            return (
              <div key={item.value} className="load-value-line">
                <span>{item.value} <em>{item.count.toLocaleString()}</em></span>
                <select
                  aria-label={`Stored value for ${item.value}`}
                  value={chosen}
                  onChange={(event) => onChange(withStoredValue(assignment, item.value, event.target.value))}
                >
                  <option value="">Not in the list — store as typed</option>
                  {list.values.map((choice) => (
                    <option key={choice.code} value={choice.code}>{choice.label}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="load-vals">
            {shown.map((item) => (
              <div key={item.value} className="load-v">
                <span>{item.value}</span>
                <span className="load-bar"><i style={{ width: `${(item.count / peak) * 100}%` }} /></span>
                <em>{item.count.toLocaleString()}</em>
              </div>
            ))}
          </div>
          {values.length > shown.length && (
            <p className="load-sub">{(values.length - shown.length).toLocaleString()} more values are in this column.</p>
          )}
          <p className="load-sub">
            Values are saved exactly as typed. To turn them into controlled codes, link {fieldName} to a reference list in <Link href="/lists">Settings</Link>.
          </p>
        </>
      )}
    </details>
  );
}
