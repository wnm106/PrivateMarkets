'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { EntityGraphPanel, entityHref } from '@/components/detail/EntityGraphPanel';
import {
  graphqlMutation,
  graphqlQuery,
  MATCH_RULES_QUERY,
  MERGE_CANDIDATES_QUERY,
  MERGE_ENTITIES_MUTATION,
  MERGE_PREVIEW_QUERY,
  UPDATE_MATCH_RULE_MUTATION,
} from '@/lib/graphql';

interface EntityRef {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
}

interface MergeReason {
  clauseCode: string;
  algorithm: string;
  label: string;
  leftValue: string;
  rightValue: string;
  similarity: number;
  deterministic: boolean;
}

interface MergeCandidate {
  score: number;
  crossDomain: boolean;
  ruleCode: string;
  ruleName: string;
  reasons: MergeReason[];
  left: EntityRef;
  right: EntityRef;
}

interface MatchClause {
  id: string;
  clauseCode: string;
  attributeCodes: string[];
  useEntityName: boolean;
  algorithm: string;
  threshold: number;
  weight: number;
  deterministic: boolean;
  isActive: boolean;
}

interface MatchRule {
  id: string;
  ruleCode: string;
  ruleName: string;
  description?: string | null;
  minScore: number;
  isActive: boolean;
  clauses: MatchClause[];
}

interface PreviewField {
  attributeCode: string;
  survivorValue?: string | null;
  retiredValue?: string | null;
  status: string;
}

interface Preview {
  crossDomain: boolean;
  score: number;
  ruleName?: string | null;
  relationshipsToMove: number;
  reasons: MergeReason[];
  survivor: EntityRef;
  retired: EntityRef;
  fields: PreviewField[];
}

type Scope = 'all' | 'same' | 'across';

function DomainChip({ code }: { code: string }) {
  return (
    <span style={{
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      padding: '2px 6px',
      borderRadius: 999,
      background: 'var(--bg-alt)',
      color: 'var(--ink-2)',
    }}>{code}</span>
  );
}

export default function MergePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusId = searchParams.get('entity');
  const [scope, setScope] = useState<Scope>('all');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [ruleCode, setRuleCode] = useState('');
  const [rules, setRules] = useState<MatchRule[]>([]);
  const [candidates, setCandidates] = useState<MergeCandidate[]>([]);
  const [scannedCount, setScannedCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MergeCandidate | null>(null);
  const [survivorId, setSurvivorId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [choices, setChoices] = useState<Record<string, 'survivor' | 'retired'>>({});
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = useState<MatchRule | null>(null);
  const [savingRule, setSavingRule] = useState(false);
  const [ruleMessage, setRuleMessage] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setAppliedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [ruleResult, candidateResult] = await Promise.all([
      graphqlQuery<{ matchRules: MatchRule[] }, Record<string, never>>(MATCH_RULES_QUERY, {}, 'network-only'),
      graphqlQuery<{ mergeCandidates: { candidates: MergeCandidate[]; scannedCount: number; truncated: boolean } }, { filter: Record<string, unknown> }>(
        MERGE_CANDIDATES_QUERY,
        {
          filter: {
            entityId: focusId,
            query: appliedQuery.trim() || null,
            ruleCode: ruleCode || null,
            crossDomainOnly: scope === 'across',
            sameDomainOnly: scope === 'same',
            limit: 50,
          },
        },
        'network-only',
      ),
    ]);
    if (ruleResult.error) setError(ruleResult.error.message || 'Could not load match rules');
    else setRules(ruleResult.data?.matchRules || []);
    if (candidateResult.error) setError(candidateResult.error.message || 'Could not score entities');
    else {
      setCandidates(candidateResult.data?.mergeCandidates?.candidates || []);
      setScannedCount(candidateResult.data?.mergeCandidates?.scannedCount || 0);
      setTruncated(Boolean(candidateResult.data?.mergeCandidates?.truncated));
    }
    setLoading(false);
  }, [appliedQuery, focusId, ruleCode, scope]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected || !survivorId) {
      setPreview(null);
      return;
    }
    const retiredId = selected.left.id === survivorId ? selected.right.id : selected.left.id;
    let cancelled = false;
    graphqlQuery<{ mergePreview: Preview }, { survivorId: string; retiredId: string; ruleCode: string }>(
      MERGE_PREVIEW_QUERY,
      { survivorId, retiredId, ruleCode: selected.ruleCode },
      'network-only',
    ).then(({ data, error: queryError }) => {
      if (cancelled) return;
      if (queryError) {
        setPreviewError(queryError.message || 'Could not preview the merge');
        setPreview(null);
        return;
      }
      const next = data?.mergePreview || null;
      setPreview(next);
      setPreviewError(null);
      const initial: Record<string, 'survivor' | 'retired'> = {};
      next?.fields.forEach((field) => {
        if (field.status === 'conflict') initial[field.attributeCode] = 'survivor';
      });
      setChoices(initial);
    });
    return () => { cancelled = true; };
  }, [selected, survivorId]);

  const openCandidate = (candidate: MergeCandidate) => {
    setSelected(candidate);
    setNotice(null);
    const preferred = focusId && (candidate.left.id === focusId || candidate.right.id === focusId)
      ? focusId
      : candidate.left.id;
    setSurvivorId(preferred);
  };

  const merge = async () => {
    if (!preview || !survivorId) return;
    setMerging(true);
    setNotice(null);
    const fieldChoices = Object.entries(choices)
      .filter(([, takeFrom]) => takeFrom === 'retired')
      .map(([attributeCode, takeFrom]) => ({ attributeCode, takeFrom }));
    const { data, error: mutationError } = await graphqlMutation<{
      mergeEntities: { success: boolean; attributesCopied: number; relationshipsMoved: number; errors: Array<{ message: string }> };
    }, {
      survivorId: string;
      retiredId: string;
      fieldChoices: Array<{ attributeCode: string; takeFrom: string }>;
      matchScore: number;
      matchReasons: MergeReason[];
    }>(MERGE_ENTITIES_MUTATION, {
      survivorId: preview.survivor.id,
      retiredId: preview.retired.id,
      fieldChoices,
      matchScore: preview.score,
      matchReasons: selected?.reasons || [],
    });
    setMerging(false);
    const result = data?.mergeEntities;
    if (mutationError || !result?.success) {
      setNotice(result?.errors?.[0]?.message || mutationError?.message || 'Merge failed');
      return;
    }
    setNotice(`Merged into ${preview.survivor.entityName}. ${result.attributesCopied} attribute${result.attributesCopied === 1 ? '' : 's'} copied and ${result.relationshipsMoved} relationship${result.relationshipsMoved === 1 ? '' : 's'} moved.`);
    setSelected(null);
    setPreview(null);
    if (focusId) router.replace('/merge');
    else load();
  };

  const saveRule = async () => {
    if (!ruleDraft) return;
    setSavingRule(true);
    setRuleMessage(null);
    const { data, error: mutationError } = await graphqlMutation<{ updateMatchRule: { errors: Array<{ message: string }> } }, { input: Record<string, unknown> }>(
      UPDATE_MATCH_RULE_MUTATION,
      {
        input: {
          id: ruleDraft.id,
          ruleName: ruleDraft.ruleName,
          description: ruleDraft.description,
          minScore: Number(ruleDraft.minScore),
          isActive: ruleDraft.isActive,
          clauses: ruleDraft.clauses.map((clause) => ({
            clauseCode: clause.clauseCode,
            attributeCodes: clause.attributeCodes,
            useEntityName: clause.useEntityName,
            algorithm: clause.algorithm,
            threshold: Number(clause.threshold),
            weight: Number(clause.weight),
            deterministic: clause.deterministic,
            isActive: clause.isActive,
          })),
        },
      },
    );
    setSavingRule(false);
    const message = data?.updateMatchRule?.errors?.[0]?.message || mutationError?.message;
    setRuleMessage(message || 'Match rule saved.');
    if (!message) load();
  };

  const retiredId = selected && survivorId
    ? (selected.left.id === survivorId ? selected.right.id : selected.left.id)
    : null;

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Entity resolution</span>
      </div>

      <div className="section-title" style={{ marginBottom: 8 }}>
        <h2>Entity resolution</h2>
      </div>
      <p style={{ color: 'var(--ink-2)', maxWidth: 820, marginTop: 0 }}>
        Exact keys such as tax ID, LEI, CUSIP, and internal identifiers combine with Jaro-Winkler, Levenshtein, and Jaccard name scores.
        The scan looks across entity types. Confirming a merge moves relationship edges onto the survivor instead of copying them onto its attributes.
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: 'var(--ink-2)' }}>
          Search
          <input className="text-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, code, or type" style={{ display: 'block', marginTop: 4, minWidth: 220 }} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--ink-2)' }}>
          Scope
          <select className="text-input" value={scope} onChange={(event) => setScope(event.target.value as Scope)} style={{ display: 'block', marginTop: 4 }}>
            <option value="all">All entities</option>
            <option value="across">Across types only</option>
            <option value="same">Same type only</option>
          </select>
        </label>
        <label style={{ fontSize: 12, color: 'var(--ink-2)' }}>
          Rule
          <select className="text-input" value={ruleCode} onChange={(event) => setRuleCode(event.target.value)} style={{ display: 'block', marginTop: 4 }}>
            <option value="">All active rules</option>
            {rules.filter((rule) => rule.isActive).map((rule) => <option key={rule.id} value={rule.ruleCode}>{rule.ruleName}</option>)}
          </select>
        </label>
        <button className="btn" onClick={load}>Refresh</button>
      </div>

      <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 12 }}>
        Scored {scannedCount.toLocaleString()} active {focusId ? 'entities against this record' : 'entities'}.
        {focusId ? ' This record is compared with every other type.' : ' Pairs are blocked on shared keys and name tokens, then scored.'}
        {truncated ? ' The scan stopped early; narrow the search if a pair is missing.' : ''}
      </div>
      {error && <div style={{ color: 'var(--red)', marginBottom: 12 }}>{error}</div>}
      {notice && <div style={{ color: 'var(--green)', marginBottom: 12 }}>{notice}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20, alignItems: 'start' }}>
        <div>
          {loading && <div style={{ color: 'var(--ink-3)' }}>Scoring candidates…</div>}
          {!loading && candidates.length === 0 && <div style={{ color: 'var(--ink-3)' }}>No candidate pairs at the current thresholds.</div>}
          {candidates.map((candidate) => {
            const active = selected?.left.id === candidate.left.id && selected?.right.id === candidate.right.id;
            return (
              <button
                key={`${candidate.left.id}:${candidate.right.id}`}
                onClick={() => openCandidate(candidate)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background: active ? 'var(--bg-alt)' : 'var(--surface)',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 10,
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong>{candidate.score}</strong>
                  <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{candidate.crossDomain ? 'Across types' : 'Same type'} · {candidate.ruleName}</span>
                </div>
                <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <DomainChip code={candidate.left.domainCode} />
                  <span>{candidate.left.entityName}</span>
                </div>
                <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <DomainChip code={candidate.right.domainCode} />
                  <span>{candidate.right.entityName}</span>
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-3)' }}>
                  {candidate.reasons.map((reason) => reason.label).join(' · ')}
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 16, background: 'var(--surface)' }}>
          {!selected && <div style={{ color: 'var(--ink-3)' }}>Select a pair to choose the survivor, settle conflicting values, and merge.</div>}
          {selected && (
            <>
              <div style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 10 }}>Which record should survive?</div>
              {[selected.left, selected.right].map((entity) => (
                <label key={entity.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <input type="radio" name="survivor" checked={survivorId === entity.id} onChange={() => setSurvivorId(entity.id)} />
                  <DomainChip code={entity.domainCode} />
                  <span>{entity.entityName}</span>
                  <Link href={entityHref(entity.domainCode, entity.id)} style={{ fontSize: 12 }}>Open</Link>
                </label>
              ))}
              {previewError && <div style={{ color: 'var(--red)', marginTop: 8 }}>{previewError}</div>}
              {preview && (
                <>
                  <div style={{ fontSize: 12, color: 'var(--ink-3)', margin: '12px 0' }}>
                    {preview.relationshipsToMove} current relationship{preview.relationshipsToMove === 1 ? '' : 's'} on the retired record will move onto the survivor.
                    {preview.crossDomain ? ' These records are different entity types.' : ''}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr', gap: 8, fontSize: 11, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    <div>Attribute</div><div>Survivor</div><div>Retired</div>
                  </div>
                  {preview.fields.map((field) => (
                    <div key={field.attributeCode} style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
                      <div>
                        <div>{field.attributeCode}</div>
                        {field.status === 'conflict' && (
                          <div style={{ marginTop: 4 }}>
                            <label style={{ fontSize: 11, marginRight: 8 }}>
                              <input type="radio" checked={choices[field.attributeCode] !== 'retired'} onChange={() => setChoices({ ...choices, [field.attributeCode]: 'survivor' })} /> Keep
                            </label>
                            <label style={{ fontSize: 11 }}>
                              <input type="radio" checked={choices[field.attributeCode] === 'retired'} onChange={() => setChoices({ ...choices, [field.attributeCode]: 'retired' })} /> Take other
                            </label>
                          </div>
                        )}
                        {field.status === 'only_retired' && <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>Will be copied</div>}
                      </div>
                      <div>{field.survivorValue || '—'}</div>
                      <div>{field.retiredValue || '—'}</div>
                    </div>
                  ))}
                  <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={merging} onClick={merge}>
                    {merging ? 'Merging…' : 'Merge entities'}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {survivorId && (
        <EntityGraphPanel entityId={survivorId} />
      )}
      {retiredId && survivorId && retiredId !== survivorId && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>Graph of the record that will be retired</div>
          <EntityGraphPanel entityId={retiredId} />
        </div>
      )}

      <details style={{ marginTop: 28 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Match rules</summary>
        <p style={{ color: 'var(--ink-2)', fontSize: 13, maxWidth: 760 }}>
          Deterministic clauses are exact keys. If both records have a value and it differs, the pair is rejected.
          Probabilistic clauses contribute only when the score clears the threshold. A missing key is skipped, not a rejection.
          Saving a rule requires a tenant admin.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {rules.map((rule) => (
            <button key={rule.id} className="btn btn-sm" onClick={() => { setRuleDraft(JSON.parse(JSON.stringify(rule))); setRuleMessage(null); }}>
              {rule.ruleName}
            </button>
          ))}
        </div>
        {ruleDraft && (
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 16 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12 }}>Name
                <input className="text-input" value={ruleDraft.ruleName} onChange={(event) => setRuleDraft({ ...ruleDraft, ruleName: event.target.value })} style={{ display: 'block' }} />
              </label>
              <label style={{ fontSize: 12 }}>Minimum score
                <input className="text-input" type="number" min={0} max={100} value={ruleDraft.minScore} onChange={(event) => setRuleDraft({ ...ruleDraft, minScore: Number(event.target.value) })} style={{ display: 'block', width: 100 }} />
              </label>
              <label style={{ fontSize: 12, alignSelf: 'end' }}>
                <input type="checkbox" checked={ruleDraft.isActive} onChange={(event) => setRuleDraft({ ...ruleDraft, isActive: event.target.checked })} /> Active
              </label>
            </div>
            <div style={{ overflowX: 'auto' }}>
            {ruleDraft.clauses.map((clause, index) => (
              <div key={clause.clauseCode} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 140px 80px 80px 90px 70px', gap: 8, marginTop: 10, alignItems: 'center' }}>
                <strong style={{ fontSize: 12 }}>{clause.clauseCode}</strong>
                <input
                  className="text-input"
                  value={clause.attributeCodes.join(', ')}
                  onChange={(event) => {
                    const clauses = [...ruleDraft.clauses];
                    clauses[index] = { ...clause, attributeCodes: event.target.value.split(',').map((code) => code.trim()).filter(Boolean) };
                    setRuleDraft({ ...ruleDraft, clauses });
                  }}
                />
                <select className="text-input" value={clause.algorithm} onChange={(event) => {
                  const clauses = [...ruleDraft.clauses];
                  clauses[index] = { ...clause, algorithm: event.target.value };
                  setRuleDraft({ ...ruleDraft, clauses });
                }}>
                  <option value="exact">Exact</option>
                  <option value="jaro_winkler">Jaro-Winkler</option>
                  <option value="levenshtein">Levenshtein</option>
                  <option value="jaccard">Jaccard</option>
                </select>
                <input className="text-input" type="number" step="0.01" min={0} max={1} value={clause.threshold} onChange={(event) => {
                  const clauses = [...ruleDraft.clauses];
                  clauses[index] = { ...clause, threshold: Number(event.target.value) };
                  setRuleDraft({ ...ruleDraft, clauses });
                }} />
                <input className="text-input" type="number" min={1} value={clause.weight} onChange={(event) => {
                  const clauses = [...ruleDraft.clauses];
                  clauses[index] = { ...clause, weight: Number(event.target.value) };
                  setRuleDraft({ ...ruleDraft, clauses });
                }} />
                <label style={{ fontSize: 12 }}>
                  <input type="checkbox" checked={clause.deterministic} onChange={(event) => {
                    const clauses = [...ruleDraft.clauses];
                    clauses[index] = { ...clause, deterministic: event.target.checked };
                    setRuleDraft({ ...ruleDraft, clauses });
                  }} /> Key
                </label>
                <label style={{ fontSize: 12 }}>
                  <input type="checkbox" checked={clause.isActive} onChange={(event) => {
                    const clauses = [...ruleDraft.clauses];
                    clauses[index] = { ...clause, isActive: event.target.checked };
                    setRuleDraft({ ...ruleDraft, clauses });
                  }} /> On
                </label>
              </div>
            ))}
            </div>
            <button
              className="btn btn-sm"
              style={{ marginTop: 12 }}
              onClick={() => setRuleDraft({
                ...ruleDraft,
                clauses: [...ruleDraft.clauses, {
                  id: '',
                  clauseCode: `CLAUSE_${ruleDraft.clauses.length + 1}`,
                  attributeCodes: [],
                  useEntityName: true,
                  algorithm: 'jaro_winkler',
                  threshold: 0.88,
                  weight: 10,
                  deterministic: false,
                  isActive: true,
                }],
              })}
            >Add clause</button>
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-primary" disabled={savingRule} onClick={saveRule}>{savingRule ? 'Saving…' : 'Save rule'}</button>
              {ruleMessage && <span style={{ marginLeft: 12, fontSize: 13 }}>{ruleMessage}</span>}
            </div>
          </div>
        )}
      </details>
    </div>
  );
}
