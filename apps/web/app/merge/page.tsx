'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { entityHref } from '@/components/detail/EntityGraphPanel';
import { planChildMerge, type ChildPlan, type ChildRecord } from '@tapestrai/graphql/lib/entity-resolution/children';
import {
  graphqlMutation,
  graphqlQuery,
  MATCH_RULES_QUERY,
  MERGE_CANDIDATES_QUERY,
  MERGE_ENTITIES_MUTATION,
  UPDATE_MATCH_RULE_MUTATION,
} from '@/lib/graphql';

interface EntityRef {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  createdAt?: string | null;
  relationshipCount: number;
  children?: ChildRecord[];
}

interface MergeReason {
  clauseCode: string;
  algorithm: string;
  label: string;
  leftValue: string;
  rightValue: string;
  leftAttribute: string;
  rightAttribute: string;
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

type Band = 'very' | 'possible';
type ChildPolicy = 'exact' | 'review' | 'move';

const DISMISS_KEY = 'tapestrai.merge.dismissed';
const REVIEW_KEY = 'tapestrai.merge.review';
const ATTR_LABEL: Record<string, string> = {
  LEI: 'LEI',
  TAX_ID: 'tax ID',
  EIN: 'tax ID',
  CIK: 'CIK',
  VAT: 'VAT',
  VAT_NUMBER: 'VAT',
  DUNS: 'DUNS',
  CUSIP: 'CUSIP',
  ISIN: 'ISIN',
  SEDOL: 'SEDOL',
  FIGI: 'FIGI',
  TICKER: 'ticker',
  FUND_CODE: 'fund code',
  INTERNAL_ID: 'internal ID',
  COMPANY_NUMBER: 'company number',
  ENTITY_NAME: 'name',
};

function pairKey(candidate: MergeCandidate) {
  return candidate.left.id < candidate.right.id
    ? `${candidate.left.id}:${candidate.right.id}`
    : `${candidate.right.id}:${candidate.left.id}`;
}

interface ReviewItem {
  key: string;
  under: string;
  keep: ChildRecord;
  retire: ChildRecord;
  exact: boolean;
}

function readReview(): ReviewItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEW_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function readDismissed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function typeLabel(code: string) {
  const names: Record<string, string> = {
    ISSUER: 'Issuers',
    SECURITY: 'Securities',
    FUND: 'Funds',
    POSITION: 'Positions',
    DEAL: 'Deals',
    INVESTOR: 'Investors',
  };
  if (names[code]) return names[code];
  return code.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function addedLabel(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `Added ${date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
}

function timeOf(entity: EntityRef) {
  const time = entity.createdAt ? new Date(entity.createdAt).getTime() : Number.NaN;
  return Number.isNaN(time) ? null : time;
}

function nameChip(similarity: number) {
  if (similarity >= 0.995) return 'Same name';
  if (similarity >= 0.9) return 'Near-identical name';
  return 'Similar name';
}

function chipsFor(candidate: MergeCandidate) {
  const chips: string[] = [];
  let bestName = 0;
  for (const reason of candidate.reasons) {
    if (reason.deterministic) {
      const name = ATTR_LABEL[reason.leftAttribute] || reason.leftAttribute.toLowerCase().replace(/_/g, ' ');
      chips.push(`Same ${name}`);
      continue;
    }
    bestName = Math.max(bestName, reason.similarity);
  }
  if (bestName > 0) chips.push(nameChip(bestName));
  return [...new Set(chips)];
}

function bandOf(candidate: MergeCandidate): Band {
  if (candidate.reasons.some((reason) => reason.deterministic)) return 'very';
  const bestName = candidate.reasons.reduce((best, reason) => reason.deterministic ? best : Math.max(best, reason.similarity), 0);
  return bestName >= 0.995 ? 'very' : 'possible';
}

function arrange(candidate: MergeCandidate, flipped: boolean) {
  const leftTime = timeOf(candidate.left);
  const rightTime = timeOf(candidate.right);
  const leftIsOlder = leftTime == null || rightTime == null ? true : leftTime <= rightTime;
  const keepIsLeft = flipped ? !leftIsOlder : leftIsOlder;
  return {
    keep: keepIsLeft ? candidate.left : candidate.right,
    retire: keepIsLeft ? candidate.right : candidate.left,
  };
}

function MergeDialog({
  candidates,
  policy,
  impactOf,
  merging,
  onPolicy,
  onCancel,
  onConfirm,
}: {
  candidates: MergeCandidate[];
  policy: ChildPolicy;
  impactOf: (candidate: MergeCandidate) => { keep: EntityRef; retire: EntityRef; plan: ChildPlan };
  merging: boolean;
  onPolicy: (policy: ChildPolicy) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const plans = candidates.map(impactOf);
  const relationships = plans.reduce((sum, item) => sum + item.retire.relationshipCount, 0);
  const descendants = plans.reduce((sum, item) => sum + item.plan.descendantMoving, 0);
  const exact = plans.reduce((sum, item) => sum + item.plan.exactCount, 0);
  const review = plans.reduce((sum, item) => sum + item.plan.reviewCount, 0);
  return (
    <div className="dup-modal" role="dialog" aria-modal="true" aria-labelledby="merge-dialog-title">
      <div className="dup-dialog">
        <h3 id="merge-dialog-title">Merge {candidates.length} pair{candidates.length === 1 ? '' : 's'}?</h3>
        <div className="dup-stats">
          <div><strong>{candidates.length}</strong><span>older record{candidates.length === 1 ? '' : 's'} kept</span></div>
          <div><strong>{relationships}</strong><span>relationship{relationships === 1 ? '' : 's'} move</span></div>
          <div><strong>{descendants}</strong><span>children move, grandchildren included</span></div>
        </div>
        <h4>Moving children can create new duplicates</h4>
        <p>Under the kept record, {exact + review} child pair{exact + review === 1 ? '' : 's'} now match: {exact} exact, {review} close.</p>
        <div className="dup-trees">
          {candidates.map((candidate) => {
            const { keep, plan } = impactOf(candidate);
            return (
            <div key={pairKey(candidate)} className="dup-tree">
              <strong>{keep.entityName} <span>(kept)</span></strong>
              {plan.collisions.length === 0 && plan.moving === 0 && <div className="dup-leaf">No children</div>}
              {plan.collisions.map((collision) => {
                const alreadyThere = (keep.children || []).some((child) => child.id === collision.kept.id);
                const queued = policy === 'review' || (policy === 'exact' && !collision.exact);
                const held = policy === 'move';
                return (
                  <div key={`${collision.kept.id}:${collision.moved.id}`}>
                    <div className="dup-leaf">↳ {collision.kept.entityName} · {alreadyThere ? 'existing' : 'kept'}</div>
                    <div className="dup-leaf">
                      ↳ {collision.moved.entityName} · moved in
                      {!held && <span className={queued ? 'dup-tag review' : 'dup-tag exact'}>{queued ? 'sent to review' : 'merges with above'}</span>}
                    </div>
                  </div>
                );
              })}
              {plan.moving > plan.collisions.length && (
                <div className="dup-leaf">↳ {plan.moving - plan.collisions.length} other child{plan.moving - plan.collisions.length === 1 ? '' : 'ren'} move with no match</div>
              )}
            </div>
            );
          })}
        </div>
        <h4>What should happen to matching children?</h4>
        <label className={`dup-choice ${policy === 'exact' ? 'is-on' : ''}`}>
          <input type="radio" name="child-policy" checked={policy === 'exact'} onChange={() => onPolicy('exact')} />
          <span><strong>Merge exact matches, review the rest</strong><small>Recommended. Close matches wait in your queue.</small></span>
        </label>
        <label className={`dup-choice ${policy === 'review' ? 'is-on' : ''}`}>
          <input type="radio" name="child-policy" checked={policy === 'review'} onChange={() => onPolicy('review')} />
          <span><strong>Send all child matches to review</strong><small>Nothing merges below the parent until you confirm it.</small></span>
        </label>
        <label className={`dup-choice ${policy === 'move' ? 'is-on' : ''}`}>
          <input type="radio" name="child-policy" checked={policy === 'move'} onChange={() => onPolicy('move')} />
          <span><strong>Move children only</strong><small>Leave any new duplicates in place.</small></span>
        </label>
        <div className="dup-dialog-actions">
          <button className="dup-row-btn quiet" onClick={onCancel} disabled={merging}>Cancel</button>
          <button className="dup-merge" onClick={onConfirm} disabled={merging}>{merging ? 'Merging…' : `Merge ${candidates.length} pair${candidates.length === 1 ? '' : 's'}`}</button>
        </div>
      </div>
    </div>
  );
}

export default function MergePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusId = searchParams.get('entity');
  const [query, setQuery] = useState('');
  const [typeCode, setTypeCode] = useState('all');
  const [band, setBand] = useState<Band>('very');
  const [rules, setRules] = useState<MatchRule[]>([]);
  const [candidates, setCandidates] = useState<MergeCandidate[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [dialog, setDialog] = useState<{ candidates: MergeCandidate[]; policy: ChildPolicy } | null>(null);
  const [mergingKey, setMergingKey] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<MatchRule | null>(null);
  const [savingRule, setSavingRule] = useState(false);
  const [ruleMessage, setRuleMessage] = useState<string | null>(null);

  useEffect(() => {
    setDismissed(readDismissed());
    setReview(readReview());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [ruleResult, candidateResult] = await Promise.all([
      graphqlQuery<{ matchRules: MatchRule[] }, Record<string, never>>(MATCH_RULES_QUERY, {}, 'network-only'),
      graphqlQuery<{ mergeCandidates: { candidates: MergeCandidate[]; truncated: boolean } }, { filter: Record<string, unknown> }>(
        MERGE_CANDIDATES_QUERY,
        { filter: { entityId: focusId, limit: 200 } },
        'network-only',
      ),
    ]);
    if (ruleResult.error) setError(ruleResult.error.message || 'Could not load match rules');
    else setRules(ruleResult.data?.matchRules || []);
    if (candidateResult.error) setError(candidateResult.error.message || 'Could not score entities');
    else {
      setCandidates(candidateResult.data?.mergeCandidates?.candidates || []);
      setTruncated(Boolean(candidateResult.data?.mergeCandidates?.truncated));
    }
    setLoading(false);
  }, [focusId]);

  useEffect(() => { load(); }, [load]);

  const active = useMemo(
    () => candidates.filter((candidate) => !dismissed.has(pairKey(candidate))),
    [candidates, dismissed],
  );

  const reviewCandidates = useMemo<MergeCandidate[]>(() => review
    .filter((item) => !dismissed.has(item.key))
    .map((item) => ({
      score: item.exact ? 100 : 80,
      crossDomain: item.keep.domainCode !== item.retire.domainCode,
      ruleCode: 'CHILD_REVIEW',
      ruleName: 'Child of a merge',
      reasons: [{
        clauseCode: 'NAME',
        algorithm: item.exact ? 'exact' : 'jaro_winkler',
        label: item.exact ? 'Same name' : 'Near-identical name',
        leftValue: item.keep.entityName,
        rightValue: item.retire.entityName,
        leftAttribute: 'ENTITY_NAME',
        rightAttribute: 'ENTITY_NAME',
        similarity: item.exact ? 1 : 0.92,
        deterministic: item.exact,
      }],
      left: { ...item.keep, relationshipCount: item.keep.descendantCount, children: [] },
      right: { ...item.retire, relationshipCount: item.retire.descendantCount, children: [] },
    })), [dismissed, review]);

  const underByKey = useMemo(() => new Map(review.map((item) => [item.key, item.under])), [review]);

  const listed = useMemo(() => {
    const seen = new Set(reviewCandidates.map(pairKey));
    return [...reviewCandidates, ...active.filter((candidate) => !seen.has(pairKey(candidate)))];
  }, [active, reviewCandidates]);

  const types = useMemo(() => {
    const codes = new Set<string>();
    for (const candidate of listed) {
      codes.add(candidate.left.domainCode);
      codes.add(candidate.right.domainCode);
    }
    return [...codes].sort();
  }, [listed]);

  const searched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return listed.filter((candidate) => {
      if (typeCode !== 'all' && candidate.left.domainCode !== typeCode && candidate.right.domainCode !== typeCode) return false;
      if (!needle) return true;
      const haystack = `${candidate.left.entityName} ${candidate.left.entityCode} ${candidate.right.entityName} ${candidate.right.entityCode}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [listed, query, typeCode]);

  const counts = useMemo(() => ({
    very: searched.filter((candidate) => bandOf(candidate) === 'very').length,
    possible: searched.filter((candidate) => bandOf(candidate) === 'possible').length,
  }), [searched]);

  const visible = searched.filter((candidate) => bandOf(candidate) === band);
  const visibleKeys = visible.map(pairKey);
  const selectedVisible = visibleKeys.filter((key) => selected.has(key));
  const veryKeys = searched.filter((candidate) => bandOf(candidate) === 'very').map(pairKey);

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  const toggleVisible = () => {
    const next = new Set(selected);
    const allOn = visibleKeys.length > 0 && visibleKeys.every((key) => next.has(key));
    for (const key of visibleKeys) {
      if (allOn) next.delete(key);
      else next.add(key);
    }
    setSelected(next);
  };

  const selectVeryLikely = () => setSelected(new Set(veryKeys));

  const dismiss = (keys: string[]) => {
    const next = new Set(dismissed);
    for (const key of keys) next.add(key);
    setDismissed(next);
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
    setSelected((current) => {
      const remaining = new Set(current);
      for (const key of keys) remaining.delete(key);
      return remaining;
    });
  };

  const saveReview = (items: ReviewItem[]) => {
    setReview(items);
    localStorage.setItem(REVIEW_KEY, JSON.stringify(items));
  };

  const mergeIds = async (survivorId: string, retiredId: string, score = 100, reasons: MergeReason[] = []) => {
    const { data, error: mutationError } = await graphqlMutation<{
      mergeEntities: { success: boolean; errors: Array<{ message: string }> };
    }, { survivorId: string; retiredId: string; matchScore: number; matchReasons: MergeReason[] }>(MERGE_ENTITIES_MUTATION, {
      survivorId,
      retiredId,
      matchScore: score,
      matchReasons: reasons,
    });
    const result = data?.mergeEntities;
    if (mutationError || !result?.success) return result?.errors?.[0]?.message || mutationError?.message || 'Merge failed';
    return null;
  };

  const impactOf = (candidate: MergeCandidate) => {
    const { keep, retire } = arrange(candidate, Boolean(flipped[pairKey(candidate)]));
    return { keep, retire, plan: planChildMerge(keep.children || [], retire.children || []) };
  };

  const applyMerges = async (chosen: MergeCandidate[], policy: ChildPolicy) => {
    setDialog(null);
    setNotice(null);
    setError(null);
    const queued = review.filter((item) => !chosen.some((candidate) => pairKey(candidate) === item.key));
    let mergedParents = 0;
    let mergedChildren = 0;
    for (const candidate of chosen) {
      const { keep, retire, plan } = impactOf(candidate);
      setMergingKey(pairKey(candidate));
      const failure = await mergeIds(keep.id, retire.id, candidate.score, candidate.reasons);
      if (failure) {
        setMergingKey(null);
        setError(failure);
        await load();
        return;
      }
      mergedParents += 1;
      const toQueue = policy === 'move' ? [] : policy === 'review' ? plan.collisions : plan.collisions.filter((collision) => !collision.exact);
      for (const collision of toQueue) {
        const key = [collision.kept.id, collision.moved.id].sort().join(':');
        if (queued.some((item) => item.key === key)) continue;
        queued.push({ key, under: keep.entityName, keep: collision.kept, retire: collision.moved, exact: collision.exact });
      }
      if (policy === 'exact') {
        for (const collision of plan.collisions.filter((collision) => collision.exact)) {
          const childFailure = await mergeIds(collision.kept.id, collision.moved.id);
          if (childFailure) {
            setMergingKey(null);
            setError(childFailure);
            saveReview(queued);
            await load();
            return;
          }
          mergedChildren += 1;
        }
      }
    }
    setMergingKey(null);
    saveReview(queued);
    setSelected(new Set());
    const childNote = mergedChildren > 0 ? ` ${mergedChildren} exact child match${mergedChildren === 1 ? '' : 'es'} merged.` : '';
    const reviewNote = queued.length > review.length ? ' Close child matches are in the list for review.' : '';
    setNotice(`Merged ${mergedParents} pair${mergedParents === 1 ? '' : 's'}.${childNote}${reviewNote}`);
    if (focusId) router.replace('/merge');
    else await load();
  };

  const requestMerge = (chosen: MergeCandidate[]) => {
    if (chosen.length === 0) return;
    const needsDecision = chosen.length > 1 || chosen.some((candidate) => impactOf(candidate).plan.reviewCount > 0);
    if (needsDecision) setDialog({ candidates: chosen, policy: 'exact' });
    else applyMerges(chosen, 'exact');
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

  return (
    <div className="view-fade da dup-page">
      <div className="da-crumbs">
        <Link href="/">Home</Link>
        <span>/</span>
        <strong>Entity resolution</strong>
      </div>

      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Resolution</span>
          <h1>Possible duplicates</h1>
          <p>Records that look like the same entity. The older record is kept.</p>
        </div>
        <div className="da-facts">
          <div className="da-fact big"><span>Very likely</span><strong>{counts.very}</strong></div>
          <div className="da-fact"><span>Possible</span><strong>{counts.possible}</strong></div>
        </div>
        <div className="da-holdbox">
          <div className="da-holdtop"><span>In this view</span><b>{visible.length}</b></div>
          <p>Search by name, then choose which pairs are the same record.</p>
        </div>
      </header>
      <div className="dup-head">
        <div className="dup-tools">
          <input className="dup-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name" aria-label="Search by name" />
          <select className="dup-type" value={typeCode} onChange={(event) => setTypeCode(event.target.value)} aria-label="Entity type">
            <option value="all">All types</option>
            {types.map((code) => <option key={code} value={code}>{typeLabel(code)}</option>)}
          </select>
        </div>
      </div>

      <div className="dup-bands">
        <button className={`dup-band ${band === 'very' ? 'is-on' : ''}`} onClick={() => setBand('very')}>Very likely · {counts.very}</button>
        <button className={`dup-band ${band === 'possible' ? 'is-on' : ''}`} onClick={() => setBand('possible')}>Possible · {counts.possible}</button>
      </div>

      {error && <div className="dup-error">{error}</div>}
      {notice && <div className="dup-notice">{notice}</div>}

      {!loading && visible.length > 0 && (
        <div className="dup-bar">
          <label>
            <input
              type="checkbox"
              checked={visibleKeys.length > 0 && selectedVisible.length === visibleKeys.length}
              ref={(node) => {
                if (node) node.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleKeys.length;
              }}
              onChange={toggleVisible}
            />
            {selectedVisible.length} of {visible.length} selected
          </label>
          {counts.very > 0 && <button className="dup-link" onClick={selectVeryLikely}>Select all {counts.very} very likely</button>}
          <span className="dup-hint">The older record is kept in every pair.</span>
          <div className="dup-bar-actions">
            <button className="dup-ghost" disabled={selectedVisible.length === 0} onClick={() => dismiss(selectedVisible)}>Not the same</button>
            <button className="dup-merge" disabled={selectedVisible.length === 0 || mergingKey !== null} onClick={() => requestMerge(visible.filter((candidate) => selected.has(pairKey(candidate))))}>
              {mergingKey ? 'Merging…' : selectedVisible.length === 0 ? 'Merge pairs' : `Merge ${selectedVisible.length} pair${selectedVisible.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {loading && <div className="dup-empty">Scoring candidates…</div>}
      {!loading && visible.length === 0 && <div className="dup-empty">No {band === 'very' ? 'very likely' : 'possible'} pairs in this view.</div>}

      {visible.map((candidate) => {
        const key = pairKey(candidate);
        const { keep, retire } = arrange(candidate, Boolean(flipped[key]));
        const keepTime = timeOf(keep);
        const retireTime = timeOf(retire);
        const keepIsNewer = keepTime != null && retireTime != null && keepTime > retireTime;
        const meta = (entity: EntityRef) => addedLabel(entity.createdAt);
        const plan = planChildMerge(keep.children || [], retire.children || []);
        const under = underByKey.get(key);
        const moves = retire.relationshipCount;
        return (
          <article key={key} className={`dup-card ${selected.has(key) ? 'is-on' : ''}`}>
            <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} aria-label={`Select ${keep.entityName}`} />
            <div className="dup-side">
              <div className="dup-role">Keep · {keepIsNewer ? 'newer' : 'older'}</div>
              <strong><Link href={entityHref(keep.domainCode, keep.id)} className="entity-link">{keep.entityName}</Link></strong>
              <div className="dup-meta">{meta(keep)}</div>
              {under && <div className="dup-under">under {under}</div>}
            </div>
            <button className="dup-swap" aria-label="Swap which record is kept" onClick={() => setFlipped({ ...flipped, [key]: !flipped[key] })}>{flipped[key] ? '→' : '←'}</button>
            <div className="dup-side">
              <div className="dup-role">Merge in · {keepIsNewer ? 'older' : 'newer'}</div>
              <strong><Link href={entityHref(retire.domainCode, retire.id)} className="entity-link">{retire.entityName}</Link></strong>
              <div className="dup-meta">{meta(retire)}</div>
              <div className="dup-rels">{moves} relationship{moves === 1 ? '' : 's'} will move</div>
              <div className="dup-kids">
                ⤷ {plan.moving === 0 ? 'No children' : plan.moving === 1 ? '1 child moves' : `${plan.moving} children move`}
                {plan.exactCount > 0 && <span className="dup-also"> · {plan.exactCount} will also merge</span>}
                {plan.reviewCount > 0 && <span className="is-review"> · needs review</span>}
              </div>
            </div>
            <div className="dup-marks">
              <span className={`dup-badge ${band}`}>{band === 'very' ? 'Very likely' : 'Possible'}</span>
              <div className="dup-chips">{chipsFor(candidate).map((chip) => <span key={chip} className="dup-chip">{chip}</span>)}</div>
            </div>
            <div className="dup-actions">
              <button className="dup-row-btn primary" disabled={mergingKey !== null} onClick={() => requestMerge([candidate])}>{mergingKey === key ? 'Merging…' : 'Merge'}</button>
              <button className="dup-row-btn quiet" onClick={() => dismiss([key])}>Not the same</button>
            </div>
          </article>
        );
      })}

      {dialog && (
        <MergeDialog
          candidates={dialog.candidates}
          policy={dialog.policy}
          impactOf={impactOf}
          merging={mergingKey !== null}
          onPolicy={(policy) => setDialog({ ...dialog, policy })}
          onCancel={() => setDialog(null)}
          onConfirm={() => applyMerges(dialog.candidates, dialog.policy)}
        />
      )}

      <div className="dup-foot">
        A merge retires one record and moves its relationships onto the one you keep.
        {truncated ? ' The list shows the strongest 200 pairs.' : ''}
        {' '}
        <button onClick={() => setShowRules((open) => !open)}>How matches are scored</button>
      </div>

      {showRules && (
        <div className="dup-rules">
          <p style={{ color: 'var(--ink-2)', fontSize: 13, maxWidth: 760 }}>
            Exact keys such as LEI, tax ID, and CUSIP make a pair very likely. Differing exact keys reject the pair.
            Name scores use Jaro-Winkler, Levenshtein, and Jaccard. Saving a rule requires a tenant admin.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
            {rules.map((rule) => (
              <button key={rule.id} className="btn btn-sm" onClick={() => { setRuleDraft(JSON.parse(JSON.stringify(rule))); setRuleMessage(null); }}>
                {rule.ruleName}
              </button>
            ))}
          </div>
          {ruleDraft && (
            <div>
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
              {ruleDraft.clauses.map((clause, index) => (
                <div key={`${clause.clauseCode}-${index}`} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 140px 80px 80px 70px', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  <strong style={{ fontSize: 12 }}>{clause.clauseCode}</strong>
                  <input className="text-input" value={clause.attributeCodes.join(', ')} onChange={(event) => {
                    const clauses = [...ruleDraft.clauses];
                    clauses[index] = { ...clause, attributeCodes: event.target.value.split(',').map((code) => code.trim()).filter(Boolean) };
                    setRuleDraft({ ...ruleDraft, clauses });
                  }} />
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
                    <input type="checkbox" checked={clause.isActive} onChange={(event) => {
                      const clauses = [...ruleDraft.clauses];
                      clauses[index] = { ...clause, isActive: event.target.checked };
                      setRuleDraft({ ...ruleDraft, clauses });
                    }} /> On
                  </label>
                </div>
              ))}
              <div style={{ marginTop: 12 }}>
                <button className="btn btn-primary" disabled={savingRule} onClick={saveRule}>{savingRule ? 'Saving…' : 'Save rule'}</button>
                {ruleMessage && <span style={{ marginLeft: 12, fontSize: 13 }}>{ruleMessage}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
