'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { buildRunInput, parseRunSetup } from '@tapestrai/graphql/src/lib/workflow-filters';
import { DOMAIN_TYPES_QUERY, graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { RECORD_CHOICES_QUERY, START_RUN, parseObject, recordTypeName, type MutationErrors, type RecordChoice } from '@/lib/workflows';

/**
 * Starting a run. A workflow does not say which records it runs on, so this
 * asks: the person picks records, or says "all of them" and confirms. A run
 * started from a record's page arrives with that record already chosen.
 *
 * The workflow's Start step says what kind of record it is about and what else
 * it needs (a period end, a limit). Where it names a type, only records of that
 * type are offered.
 */

export interface StartRunTarget {
  id: string;
  name: string;
  /** What the version being started asks for. Parsed here, so anything is accepted. */
  runSetup?: unknown;
}

interface Props {
  workflow: StartRunTarget;
  /** Start this version instead of the published one. Used by Try it. */
  version?: number;
  /** Records already chosen, when the run is started from one. */
  records?: RecordChoice[];
  onClose: () => void;
  onStarted: (runId: string) => void;
}

const label = { fontSize: 11, fontWeight: 600, color: 'var(--ink-3)' } as const;
const hint = { fontSize: 11, color: 'var(--ink-4)' } as const;

export function StartRunDialog({ workflow, version, records = [], onClose, onStarted }: Props) {
  const setup = useMemo(() => parseRunSetup(workflow.runSetup), [workflow.runSetup]);
  const [types, setTypes] = useState<Array<{ domainCode: string; domainName: string }>>([]);
  const [domainCode, setDomainCode] = useState<string>(setup.appliesTo || records[0]?.domainCode || '');
  const [chosen, setChosen] = useState<RecordChoice[]>(records);
  const [all, setAll] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<RecordChoice[]>([]);
  const [searching, setSearching] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const [inputText, setInputText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const request = useRef(0);

  useEffect(() => {
    graphqlQuery<{ domainTypes: Array<{ domainCode: string; domainName: string; isActive: boolean }> }>(DOMAIN_TYPES_QUERY).then(({ data }) => {
      setTypes((data?.domainTypes || []).filter((type) => type.isActive !== false).sort((left, right) => left.domainName.localeCompare(right.domainName)));
    });
  }, []);

  // The first few records of the type, or those matching what was typed.
  useEffect(() => {
    if (all || (!domainCode && !search.trim())) {
      setFound([]);
      return;
    }
    const current = ++request.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      const { data } = await graphqlQuery<{ workflowRecordChoices: RecordChoice[] }>(RECORD_CHOICES_QUERY, { domainCode: domainCode || null, search: search.trim() || null, first: 25 });
      if (current !== request.current) return;
      setFound(data?.workflowRecordChoices || []);
      setSearching(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [domainCode, search, all]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const typeName = recordTypeName(setup.appliesTo || domainCode, types);
  const chosenIds = new Set(chosen.map((record) => record.id));
  const input = useMemo(
    () => buildRunInput(setup, { entityIds: chosen.map((record) => record.id), domainCode, all }, values),
    [setup, chosen, domainCode, all, values],
  );
  // What "all" covers, in words, for the confirmation.
  const everything = setup.appliesTo || domainCode ? `every ${typeName.singular}` : 'every record it applies to';
  const unfiltered = all || chosen.length === 0;
  const blocked = setup.requiresRecords && unfiltered;

  const toggle = (record: RecordChoice) => {
    setConfirmAll(false);
    setChosen((current) => (current.some((item) => item.id === record.id) ? current.filter((item) => item.id !== record.id) : [...current, record]));
  };

  const start = async () => {
    setProblem('');
    let payload: Record<string, unknown> = input;
    if (advanced) {
      const parsed = parseObject(inputText, 'The input');
      if (!parsed.ok) {
        setProblem(parsed.message);
        return;
      }
      payload = parsed.value;
    } else if (blocked) {
      setProblem('Choose at least one record. This workflow does not run on everything.');
      return;
    } else if (unfiltered && !confirmAll) {
      // Running on everything is allowed, but never by leaving a box empty.
      setConfirmAll(true);
      return;
    }
    setBusy(true);
    const { data, error } = await graphqlMutation<{ startWorkflowRun: { run: { id: string } | null; errors: MutationErrors } }>(START_RUN, {
      workflowId: workflow.id,
      input: payload,
      ...(version ? { version } : {}),
    });
    setBusy(false);
    const failed = error?.message || data?.startWorkflowRun.errors[0]?.message;
    if (failed || !data?.startWorkflowRun.run) {
      setProblem(failed || 'The run could not be started.');
      return;
    }
    onStarted(data.startWorkflowRun.run.id);
  };

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.35)', display: 'grid', placeItems: 'start center', paddingTop: '8vh', zIndex: 200 }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={`Start ${workflow.name}`}
        onSubmit={(event) => {
          event.preventDefault();
          start();
        }}
        style={{ width: 'min(640px, calc(100vw - 32px))', maxHeight: '84vh', overflow: 'auto', background: 'var(--surface, #fff)', border: '1px solid var(--line-strong)', borderRadius: 10, padding: 18, display: 'grid', gap: 12, boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)' }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Start “{workflow.name}”{version ? ` (version ${version}, not published)` : ''}</div>
          <div style={hint}>
            {setup.appliesTo ? `Runs on ${typeName.plural}.` : 'Runs on any type of record.'} Choose which, or run it on all of them.
          </div>
        </div>

        {!advanced && (
          <>
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={label}>Records</span>
              <div style={{ display: 'flex', gap: 14, fontSize: 13 }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="radio" name="scope" checked={!all} onChange={() => { setAll(false); setConfirmAll(false); }} />
                  Chosen records
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: setup.requiresRecords ? 'var(--ink-4)' : undefined }} title={setup.requiresRecords ? 'This workflow reads records one at a time, so it needs them chosen.' : undefined}>
                  <input type="radio" name="scope" checked={all} disabled={setup.requiresRecords} onChange={() => { setAll(true); setConfirmAll(false); }} />
                  {setup.appliesTo || domainCode ? `All ${typeName.plural}` : 'Everything it applies to'}
                </label>
              </div>

              {!all && (
                <>
                  {chosen.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {chosen.map((record) => (
                        <span key={record.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 8px', borderRadius: 999, background: 'var(--accent-tint, #e0f2fe)', border: '1px solid var(--line)' }}>
                          <span>{record.entityName} <span style={{ color: 'var(--ink-4)' }}>{record.entityCode}</span></span>
                          <button type="button" aria-label={`Remove ${record.entityName}`} onClick={() => toggle(record)} style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink-3)', lineHeight: 1 }}>×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    {!setup.appliesTo && (
                      <select className="text-input" aria-label="Type of record" value={domainCode} onChange={(event) => setDomainCode(event.target.value)} style={{ fontSize: 13, maxWidth: 200 }}>
                        <option value="">Any type</option>
                        {types.map((type) => <option key={type.domainCode} value={type.domainCode}>{type.domainName}</option>)}
                      </select>
                    )}
                    <input
                      className="text-input"
                      autoFocus
                      aria-label="Find records"
                      placeholder={`Find ${setup.appliesTo || domainCode ? typeName.plural : 'records'} by name or code`}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      style={{ flex: 1, fontSize: 13 }}
                    />
                  </div>
                  <div role="listbox" aria-label="Records found" aria-multiselectable="true" style={{ border: '1px solid var(--line)', borderRadius: 6, maxHeight: 220, overflow: 'auto', minHeight: 44 }}>
                    {found.length === 0 ? (
                      <div style={{ ...hint, padding: 12 }}>
                        {searching ? 'Looking…' : !domainCode && !search.trim() ? 'Choose a type or type a name to find records.' : 'No records match.'}
                      </div>
                    ) : (
                      found.map((record) => (
                        <label key={record.id} role="option" aria-selected={chosenIds.has(record.id)} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', fontSize: 13, borderBottom: '1px solid var(--line)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={chosenIds.has(record.id)} onChange={() => toggle(record)} />
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{record.entityName}</span>
                          <span style={{ color: 'var(--ink-4)', fontSize: 12 }}>{record.entityCode}</span>
                          {!setup.appliesTo && !domainCode && <span style={{ color: 'var(--ink-4)', fontSize: 11 }}>{recordTypeName(record.domainCode, types).singular}</span>}
                        </label>
                      ))
                    )}
                  </div>
                  {found.length >= 25 && <span style={hint}>Showing the first 25. Type more of the name to narrow it.</span>}
                </>
              )}
            </div>

            {setup.inputs.map((field) => (
              <label key={field.key} style={{ display: 'grid', gap: 4, maxWidth: 260 }}>
                <span style={label}>{field.label}</span>
                <input
                  className="text-input"
                  type={field.type === 'text' ? 'text' : field.type}
                  value={values[field.key] || ''}
                  onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                  style={{ fontSize: 13 }}
                />
                {field.help && <span style={hint}>{field.help}</span>}
              </label>
            ))}

            <div style={{ fontSize: 13, padding: '8px 10px', borderRadius: 6, background: unfiltered ? '#fef3c7' : 'var(--surface-2, #f8fafc)', border: '1px solid var(--line)' }}>
              {blocked
                ? 'Choose at least one record to start.'
                : unfiltered
                  ? `This run will cover ${everything}.`
                  : `This run will cover ${chosen.length} ${chosen.length === 1 ? typeName.singular : typeName.plural}: ${chosen.slice(0, 4).map((record) => record.entityName).join(', ')}${chosen.length > 4 ? `, and ${chosen.length - 4} more` : ''}.`}
            </div>
          </>
        )}

        {advanced && (
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={label}>Input</span>
            <textarea className="text-input" rows={8} spellCheck={false} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }} value={inputText} onChange={(event) => setInputText(event.target.value)} />
            <span style={hint}>What the run starts with. Records go under filters: domainCode, entityCodes, entityIds, nameContains. No filters means everything.</span>
          </label>
        )}

        {problem && <div role="alert" style={{ color: 'var(--red)', fontSize: 13 }}>{problem}</div>}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="submit" className="btn btn-primary" disabled={busy || (!advanced && blocked)}>
            {busy ? 'Starting…' : !advanced && confirmAll && unfiltered ? `Yes, run on ${everything}` : 'Start run'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              if (!advanced) setInputText(JSON.stringify(input, null, 2));
              setAdvanced(!advanced);
              setConfirmAll(false);
              setProblem('');
            }}
          >
            {advanced ? 'Back to choosing records' : 'Edit as JSON'}
          </button>
        </div>
      </form>
    </div>
  );
}
