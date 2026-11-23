'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { AppGrid } from '@/components/grid/AppGrid';
import { usePublishTabs, usePublishViewContext, type TabPayload } from '@/lib/view-context';
import { useTemporalStore } from '@/lib/store';
import { CLEAR_MANUAL_OVERRIDE_MUTATION, DATA_QUALITY_DASHBOARD_QUERY, DATA_QUALITY_DASHBOARD_WITH_ENTITIES_QUERY, DQ_AVAILABILITY_DETAIL_QUERY, FIELD_LINEAGE_QUERY, STALE_ATTRIBUTES_QUERY, graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { CommittedDateInput } from '@/components/forms/CommittedDateInput';
import { TypeaheadSelect, type TypeaheadOption } from '@/components/forms/TypeaheadSelect';
import { STALE_AFTER_DAYS, formatReceipt } from '@/lib/receipt-freshness';
import { domainHref } from '@/lib/domain-routes';
import { nestDomainLinks, type DomainNavItem } from '@/lib/domain-nav';
import { AttributeValueInput } from '@/components/forms/AttributeValueInput';
import { groupByEntityType, splitChangesByEntityType, splitRulesByEntityType } from '@/lib/dq-groups';
import { compareScores, knowledgeArgument, scoreFromWeights, type ScoreWeights } from '@/lib/dq-scores';

type Section = 'availability' | 'quality' | 'trajectory' | 'handoff' | 'freshness' | 'consensus';
type Period = 'day' | 'week' | 'month' | 'quarter' | 'custom';

interface EntityRef {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
}

interface MeasureShift extends EntityRef {
  previousValue: string | null;
  currentValue: string | null;
}

interface AvailabilityDetailData {
  missingEntities: EntityRef[];
  resolvedEntities: MeasureShift[];
  introducedEntities: MeasureShift[];
}

interface ConsensusConflict {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  attributeCode: string;
  attributeName: string;
  goldenSourceCode: string;
  goldenSourceName: string;
  goldenValue: string | null;
  sourceCode: string;
  sourceName: string;
  value: string | null;
}

interface StaleAttribute {
  entityId: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  attributeCode: string;
  attributeName: string;
  sourceCode: string;
  sourceName: string;
  value: string | null;
  receivedAt: string;
  ageDays: number;
}

interface StaleReport {
  olderThanDays: number;
  asOfDate: string;
  count: number;
  attributes: StaleAttribute[];
}

interface OverrideMatch extends EntityRef {
  attributeCode: string;
  attributeName: string;
  overrideValue: string;
  overrideReason: string | null;
  prioritySourceCode: string | null;
  prioritySourceName: string | null;
  priorityValue: string | null;
  ready: boolean;
}

interface Dashboard {
  fromDate: string;
  toDate: string;
  domains: string[];
  summary: {
    entityCount: number;
    requiredSlots: number;
    populatedSlots: number;
    missingSlots: number;
    entitiesMissingRequired: number;
    availabilityPercent: number | null;
    rulesEvaluated: number;
    passingChecks: number;
    failingChecks: number;
    entitiesFailingRules: number;
    qualityPercent: number | null;
    changedAttributeCount: number;
    changedEntityCount: number;
    attributeChangeCount: number;
    clearEntityCount: number;
    availabilityResolvedCount: number;
    availabilityIntroducedCount: number;
    qualityResolvedCount: number;
    qualityIntroducedCount: number;
    overrideMatchCount: number;
  };
  availability: Array<{
    attributeCode: string;
    attributeName: string;
    domainCode: string | null;
    requiredCount: number;
    missingCount: number;
    availabilityPercent: number | null;
    resolvedCount: number;
    introducedCount: number;
  }>;
  quality: Array<{
    ruleId: string;
    ruleCode: string;
    ruleName: string;
    ruleType: string;
    severity: string;
    domainCode: string | null;
    ruleExpression: string;
    ruleDescription: string | null;
    attributeCode: string | null;
    attributeName: string | null;
    evaluated: boolean;
    evaluationMessage: string | null;
    entityCount: number;
    failingCount: number;
    passingCount: number;
    acceptedCount: number;
    failingEntities: Array<EntityRef & { attributeCode: string | null; attributeName: string | null; message: string | null; actualValue: string | null }>;
    acceptedEntities: Array<EntityRef & { status: string; notes: string | null }>;
    resolvedCount: number;
    introducedCount: number;
    resolvedEntities: MeasureShift[];
    introducedEntities: MeasureShift[];
  }>;
  overrideMatches: OverrideMatch[];
  scores: ScoreWeights | null;
  entityTypeScores: Array<ScoreWeights & { domainCode: string | null; entityCount: number }> | null;
  consensusConflicts: ConsensusConflict[];
  trajectory: Array<{
    attributeCode: string;
    attributeName: string;
    domainCode: string | null;
    changeCount: number;
    changes: Array<EntityRef & { previousValue: string | null; currentValue: string | null }>;
  }>;
  /** Loaded only once the Entity view has been opened. */
  entities?: Array<{
    id: string;
    entityCode: string;
    entityName: string;
    domainCode: string;
    requiredCount: number;
    missingCount: number;
    availabilityPercent: number | null;
    missingAttributes: Array<{ attributeCode: string; attributeName: string }>;
    ruleCount: number;
    failingRuleCount: number;
    qualityPercent: number | null;
    failingRules: Array<{
      ruleId: string;
      ruleCode: string;
      ruleName: string;
      severity: string;
      attributeCode: string | null;
      attributeName: string | null;
      message: string | null;
      actualValue: string | null;
    }>;
    acceptedRules: Array<{
      ruleId: string;
      ruleCode: string;
      ruleName: string;
      severity: string;
      attributeCode: string | null;
      attributeName: string | null;
      status: string;
      notes: string | null;
    }>;
    changeCount: number;
    changes: Array<{
      attributeCode: string;
      attributeName: string;
      previousValue: string | null;
      currentValue: string | null;
    }>;
    availabilityResolvedCount: number;
    availabilityIntroducedCount: number;
    qualityResolvedCount: number;
    qualityIntroducedCount: number;
    overrideMatchCount: number;
    overrideCount: number;
    availabilityPassing: number;
    availabilityApplicable: number;
    qualityPassing: number;
    qualityApplicable: number;
    freshnessPassing: number;
    freshnessApplicable: number;
    consensusPassing: number;
    consensusApplicable: number;
    waivedChecks: number;
  }>;
}

const PAGE_SIZE = 40;
const DETAIL_PAGE = 25;

function slicePage<T>(items: readonly T[], page: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  return {
    rows: items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE),
    page: current,
    pageCount,
  };
}

function isoDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseIso(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function shiftBack(toIso: string, period: Exclude<Period, 'custom'>) {
  const date = parseIso(toIso);
  if (period === 'day') date.setDate(date.getDate() - 1);
  if (period === 'week') date.setDate(date.getDate() - 7);
  if (period === 'month') date.setMonth(date.getMonth() - 1);
  if (period === 'quarter') date.setMonth(date.getMonth() - 3);
  return isoDate(date);
}

function qualityError(message: string | undefined, fallback: string) {
  const text = message || '';
  if (/timeout|canceling statement|statement timeout/i.test(text)) {
    return 'That date was stopped because it took too long. The refresh icon stays up while a run is still going. Wait until it finishes, then choose the date again.';
  }
  return text || fallback;
}

function formatDay(iso: string) {
  return parseIso(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function domainLabel(code?: string | null) {
  if (!code) return '—';
  return code.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function TypeHead({ code, count, singular, plural, score }: { code: string; count: number; singular: string; plural?: string; score?: number | null }) {
  const noun = count === 1 ? singular : (plural ?? `${singular}s`);
  return (
    <div className="dq-type-head">
      <h2>{code ? domainLabel(code) : 'All types'}</h2>
      <span className="dq-type-meta">
        {score !== undefined && <strong className="dq-type-score" title="Score for every record of this type">{formatPercent(score)} type score</strong>}
        <span>{count.toLocaleString()} {noun}</span>
      </span>
    </div>
  );
}

function GroupPager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (page: number) => void }) {
  if (pageCount <= 1) return null;
  return (
    <div className="dq-head">
      <span className="dq-sub">Page {page + 1} of {pageCount}</span>
      <div className="dq-seg">
        <button type="button" disabled={page === 0} onClick={() => onPage(Math.max(0, page - 1))}>Previous</button>
        <button type="button" disabled={page + 1 >= pageCount} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

function formatPercent(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '—';
  if (value > 0 && value < 100 && value >= 99.95) return '99.9%';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function scoreLine(weights: ScoreWeights) {
  const score = scoreFromWeights(weights);
  return [
    ['Availability', score.availability],
    ['Quality', score.quality],
    ['Freshness', score.freshness],
    ['Consensus', score.consensus],
  ].map(([label, value]) => `${label} ${formatPercent(value as number | null)}`).join(' · ');
}

function RefreshMark() {
  return (
    <svg className="dq-refresh" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 0 0-9-9 9 9 0 0 0-8.3 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M3 12a9 9 0 0 0 9 9 9 9 0 0 0 8.3-5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M3 4v5h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 20v-5h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PillarHead({ label, tone, refreshing }: { label: string; tone: 'attention' | 'success' | 'quiet'; refreshing?: boolean }) {
  return (
    <div className="pillar-top">
      <div className="pillar-lbl">{label}</div>
      {refreshing ? (
        <RefreshMark />
      ) : tone === 'quiet' ? (
        <span className="pillar-dot" aria-hidden />
      ) : (
        <span className={`pillar-chip ${tone}`}>
          <span className="pillar-chip-mark" aria-hidden />
          {tone === 'success' ? 'Success' : 'Attention'}
        </span>
      )}
    </div>
  );
}

function barColor(value: number | null) {
  if (value == null) return 'var(--ink-3)';
  if (value >= 95) return 'var(--green)';
  if (value >= 80) return 'var(--accent-2)';
  return 'var(--amber)';
}

function entityHref(domainCode: string, id: string) {
  return `${domainHref(domainCode)}/${id}`;
}

function displayValue(value: string | null | undefined) {
  if (value == null || value === '') return '—';
  return value;
}

function severityClass(severity: string) {
  const key = severity.toLowerCase();
  if (key === 'critical' || key === 'high') return 'sev-high';
  if (key === 'medium' || key === 'med') return 'sev-med';
  return 'sev-low';
}

const top = <T,>(rows: T[], limit: number) => rows.slice(0, limit);

/**
 * What each pillar of the dashboard tells the assistant, from the one load that feeds
 * all of them, so the assistant sees every pillar and not only the open one.
 */
const SCORE_READING = 'The score averages availability, quality, freshness, and consensus. A dimension with no checks is left out. The firm score and each entity-type score add up the checks underneath; they are not the average of the record scores. Quality weights a critical check as 8, high as 4, medium as 2, and low as 1, and leaves out a failure a person has accepted. Freshness passes when a sourced value was received within 30 days of the end date; derived and calculated values are left out. Consensus passes when every other active source value agrees with the golden source. An attribute with no second active value is left out. A conflict is one active value that disagrees with the golden source. The availability and quality percentages in each panel count each check once.';

function publishedScore(weights: ScoreWeights | null | undefined) {
  if (!weights) return null;
  const score = scoreFromWeights(weights);
  return {
    score: score.score,
    availability: score.availability,
    quality: score.quality,
    freshness: score.freshness,
    consensus: score.consensus,
    dimensionsApplied: score.dimensionsApplied,
    acceptedFailuresLeftOut: score.waivedChecks,
    checks: {
      availability: `${score.weights.availabilityPassing} of ${score.weights.availabilityApplicable}`,
      qualityWeight: `${score.weights.qualityPassing} of ${score.weights.qualityApplicable}`,
      freshness: `${score.weights.freshnessPassing} of ${score.weights.freshnessApplicable}`,
      consensus: `${score.weights.consensusPassing} of ${score.weights.consensusApplicable}`,
    },
  };
}

/** Who the dashboard covers, in words. */
function qualityScope(scope: { domainCode: string; entityId?: string }) {
  return scope.entityId ? 'this record' : scope.domainCode ? `every ${scope.domainCode} record` : 'every record';
}

/** The name, purpose and reading notes of each tab, published whether or not the dashboard has loaded. */
function qualityTabInfo(where: string) {
  return {
    'dq-availability': {
      label: 'Data quality: Availability',
      purpose: `Whether the required attributes have values for ${where}, by attribute.`,
      howToRead: `Required attributes come from the entity template. missing is a required value with no value. resolved means a gap at the start of the period now has a value. introduced means a value at the start is now missing. ${SCORE_READING}`,
    },
    'dq-quality': {
      label: 'Data quality: Quality',
      purpose: `Whether ${where} pass the data quality rules, by rule.`,
      howToRead: `A rule expression describes the exception: a record fails when it meets every condition of any group. A blank value meets no condition about its value, so blanks are counted under availability, not here. failing counts records failing the rule, accepted are failures someone has accepted. resolved and introduced compare with the start of the period. ${SCORE_READING}`,
    },
    'dq-trajectory': {
      label: 'Data quality: Trajectory',
      purpose: `Which attribute values changed over the period for ${where}.`,
      howToRead: `changeCount counts values that differ between the start and the end of the period. Each example shows the previous and current value. ${SCORE_READING}`,
    },
    'dq-handoff': {
      label: 'Data quality: Handoff',
      purpose: `Manual overrides on ${where} that can be released because a priority source now matches the manual value.`,
      howToRead: `ready means the priority source's value matches the override as of the end of the period, so the manual value can be cleared. ${SCORE_READING}`,
    },
    'dq-freshness': {
      label: 'Data quality: Freshness',
      purpose: `Which prevailing values for ${where} have not been received recently.`,
      howToRead: `A value is stale when its source has not sent it in olderThanDays days as of the date shown. ageDays is days since it was received. The freshness used in the score is fixed at 30 days and does not follow this panel's older-than control. ${SCORE_READING}`,
    },
    'dq-consensus': {
      label: 'Data quality: Consensus',
      purpose: `Where the golden source for ${where} disagrees with another active value of the same attribute.`,
      howToRead: `A conflict is one active source value that does not match the golden source. The consensus score counts an attribute as passing only when every other active value agrees, and leaves out an attribute that has no second active value. ${SCORE_READING}`,
    },
  } satisfies Record<string, Omit<TabPayload, 'data'>>;
}

function qualityTabs(
  dashboard: Dashboard | null,
  stale: StaleReport | null,
  scope: { fromDate: string; toDate: string; domainCode: string; entityId?: string },
): Record<string, TabPayload> {
  const where = qualityScope(scope);
  const ref = (row: { entityCode: string; entityName: string; domainCode: string }) => ({ code: row.entityCode, name: row.entityName, domain: row.domainCode });
  const info = qualityTabInfo(where);
  // The freshness tab loads on its own, so it can publish before the dashboard does.
  const freshness = stale ? {
    scope: where, asOfDate: stale.asOfDate, olderThanDays: stale.olderThanDays, staleValues: stale.count,
    values: top(stale.attributes, 80).map((row) => ({ ...ref(row), attribute: row.attributeName, source: row.sourceName, value: row.value, receivedAt: row.receivedAt, ageDays: row.ageDays })),
  } : null;
  if (!dashboard) {
    return Object.fromEntries(Object.entries(info).map(([key, tab]) => [key, { ...tab, data: key === 'dq-freshness' ? freshness : null }]));
  }
  const { summary } = dashboard;
  const entityTypeScores = [...(dashboard.entityTypeScores ?? [])]
    .map((row) => ({
      domain: row.domainCode,
      label: row.domainCode ? domainLabel(row.domainCode) : 'All types',
      records: row.entityCount,
      ...publishedScore(row),
    }))
    .sort((a, b) => compareScores({ score: a.score ?? null, label: a.label }, { score: b.score ?? null, label: b.label }));
  const entityScores = dashboard.entities
    ? {
        note: 'The lowest record scores among records with something open. A record with nothing open still counts in the firm and entity-type scores.',
        records: top(
          dashboard.entities
            .map((entity) => ({
              ...ref(entity),
              ...publishedScore(entity),
            }))
            .sort((a, b) => compareScores(
              { score: a.score ?? null, label: a.name },
              { score: b.score ?? null, label: b.name },
            )),
          40,
        ),
      }
    : null;
  const common = {
    period: `${scope.fromDate} to ${scope.toDate}`,
    scope: where,
    entityCount: summary.entityCount,
    score: publishedScore(dashboard.scores),
    entityTypeScores,
    entityScores,
  };
  return {
    'dq-availability': {
      ...info['dq-availability'],
      data: {
        ...common, availabilityPercent: summary.availabilityPercent, requiredValues: summary.requiredSlots, populated: summary.populatedSlots, missing: summary.missingSlots,
        entitiesMissingRequired: summary.entitiesMissingRequired, filledIn: summary.availabilityResolvedCount, nowMissing: summary.availabilityIntroducedCount,
        attributes: top(dashboard.availability.filter((row) => row.missingCount > 0 || row.resolvedCount > 0 || row.introducedCount > 0), 80).map((row) => ({
          attribute: row.attributeName, domain: row.domainCode, required: row.requiredCount, missing: row.missingCount, availabilityPercent: row.availabilityPercent, resolved: row.resolvedCount, introduced: row.introducedCount,
        })),
      },
    },
    'dq-quality': {
      ...info['dq-quality'],
      data: {
        ...common, qualityPercent: summary.qualityPercent, rulesEvaluated: summary.rulesEvaluated, passingChecks: summary.passingChecks, failingChecks: summary.failingChecks,
        entitiesFailingRules: summary.entitiesFailingRules, nowPassing: summary.qualityResolvedCount, nowFailing: summary.qualityIntroducedCount,
        rules: top(dashboard.quality.filter((rule) => rule.failingCount > 0 || rule.resolvedCount > 0 || rule.introducedCount > 0), 60).map((rule) => ({
          rule: rule.ruleName, code: rule.ruleCode, severity: rule.severity, domain: rule.domainCode, attribute: rule.attributeName, evaluated: rule.evaluated,
          records: rule.entityCount, failing: rule.failingCount, passing: rule.passingCount, accepted: rule.acceptedCount, resolved: rule.resolvedCount, introduced: rule.introducedCount,
          failingExamples: top(rule.failingEntities, 5).map((row) => ({ ...ref(row), message: row.message, value: row.actualValue })),
        })),
      },
    },
    'dq-trajectory': {
      ...info['dq-trajectory'],
      data: {
        ...common, valuesChanged: summary.attributeChangeCount, recordsChanged: summary.changedEntityCount, attributesChanged: summary.changedAttributeCount,
        attributes: top(dashboard.trajectory, 60).map((row) => ({
          attribute: row.attributeName, domain: row.domainCode, changeCount: row.changeCount,
          examples: top(row.changes, 5).map((change) => ({ ...ref(change), previous: change.previousValue, current: change.currentValue })),
        })),
      },
    },
    'dq-handoff': {
      ...info['dq-handoff'],
      data: {
        ...common, overridesReady: summary.overrideMatchCount,
        overrides: top(dashboard.overrideMatches, 80).map((row) => ({ ...ref(row), attribute: row.attributeName, override: row.overrideValue, reason: row.overrideReason, prioritySource: row.prioritySourceName, priorityValue: row.priorityValue, ready: row.ready })),
      },
    },
    'dq-freshness': {
      ...info['dq-freshness'],
      data: freshness,
    },
    'dq-consensus': {
      ...info['dq-consensus'],
      data: {
        ...common,
        conflictCount: (dashboard.consensusConflicts ?? []).length,
        conflicts: top(dashboard.consensusConflicts ?? [], 80).map((row) => ({
          ...ref({ entityCode: row.entityCode, entityName: row.entityName, domainCode: row.domainCode }),
          attribute: row.attributeName,
          goldenSource: row.goldenSourceName,
          goldenValue: row.goldenValue,
          otherSource: row.sourceName,
          otherValue: row.value,
        })),
      },
    },
  };
}

export function DataQualityDashboard({
  domainCode: fixedDomain,
  entityId,
  active = true,
}: {
  domainCode?: string;
  entityId?: string;
  /** False when the dashboard is mounted on a hidden tab. It still publishes its figures but does not take over the page's focus. */
  active?: boolean;
} = {}) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const setAsOfDate = useTemporalStore((state) => state.setAsOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const knownAt = useMemo(() => knowledgeArgument(knowledgeDate), [knowledgeDate]);
  const today = useMemo(() => isoDate(new Date()), []);
  const [period, setPeriod] = useState<Period>('day');
  const [toDate, setToDate] = useState(today);
  const [fromDate, setFromDate] = useState(shiftBack(today, 'day'));
  const [domainCode, setDomainCode] = useState(fixedDomain || '');
  const [knownDomains, setKnownDomains] = useState<string[]>([]);
  const [domainCatalog, setDomainCatalog] = useState<DomainNavItem[]>([]);
  const [section, setSection] = useState<Section>('availability');
  const [view, setView] = useState<'measures' | 'entities'>('measures');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [detailLimit, setDetailLimit] = useState(DETAIL_PAGE);
  const [entityQuery, setEntityQuery] = useState('');
  const [entityPages, setEntityPages] = useState<Record<string, number>>({});
  const [refreshToken, setRefreshToken] = useState(0);
  const [handoffScope, setHandoffScope] = useState<'ready' | 'all'>('ready');
  const [measureQuery, setMeasureQuery] = useState('');
  const [rowScope, setRowScope] = useState<'exceptions' | 'all'>('exceptions');
  const [staleDays, setStaleDays] = useState(STALE_AFTER_DAYS);
  const [staleReport, setStaleReport] = useState<StaleReport | null>(null);
  const [entitiesNeeded, setEntitiesNeeded] = useState(false);
  const openRule = openKey?.startsWith('rule-')
    ? dashboard?.quality.find((rule) => `rule-${rule.ruleId}` === openKey)
    : undefined;

  usePublishViewContext(!active ? null : {
    activity: 'viewing',
    kind: 'data-quality',
    label: openRule?.ruleName || (domainCode ? `${domainCode} data quality` : 'Data quality'),
    domainCode: domainCode || undefined,
    summary: `${section}, ${view}, ${fromDate} to ${toDate}`,
    snapshot: {
      section,
      view,
      period,
      fromDate,
      toDate,
      domainCode: domainCode || null,
      openRule: openRule
        ? {
            ruleCode: openRule.ruleCode,
            ruleName: openRule.ruleName,
            severity: openRule.severity,
            domainCode: openRule.domainCode,
            entityCount: openRule.entityCount,
            failingCount: openRule.failingCount,
          }
        : null,
    },
  });

  useEffect(() => {
    if (view === 'entities' && section !== 'freshness' && section !== 'consensus') setEntitiesNeeded(true);
  }, [view, section]);

  useEffect(() => {
    let cancelled = false;
    graphqlQuery<{
      domainTypes: Array<{
        domainCode: string;
        domainName: string;
        isActive: boolean;
        displayOrder: number;
        parentDomainCode?: string | null;
        group?: { groupName: string; displayOrder: number } | null;
      }>;
    }, Record<string, never>>(
      `query QualityDomains {
        domainTypes {
          domainCode
          domainName
          isActive
          displayOrder
          parentDomainCode
          group { groupName displayOrder }
        }
      }`,
      {},
      'network-only',
    ).then((result) => {
      if (cancelled || result.error || !result.data) return;
      setDomainCatalog(
        (result.data.domainTypes || [])
          .filter((domain) => domain.isActive)
          .map((domain) => ({
            code: domain.domainCode,
            name: domain.domainName,
            groupName: domain.group?.groupName || 'Other',
            groupOrder: domain.group?.displayOrder ?? 9999,
            displayOrder: domain.displayOrder || 0,
            parentCode: domain.parentDomainCode || null,
          })),
      );
    });
    return () => { cancelled = true; };
  }, []);

  const refreshJob = useRef({ domainCode, entityId, fromDate, toDate, knownAt, staleDays, refreshToken, entitiesNeeded });
  refreshJob.current = { domainCode, entityId, fromDate, toDate, knownAt, staleDays, refreshToken, entitiesNeeded };
  const refreshPump = useRef(false);
  const refreshApplied = useRef('');
  const refreshAlive = useRef(true);

  useEffect(() => {
    refreshAlive.current = true;
    return () => {
      refreshAlive.current = false;
    };
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const pump = () => {
      if (refreshPump.current || !refreshAlive.current) return;
      refreshPump.current = true;
      const run = async () => {
        try {
          while (refreshAlive.current) {
            const job = refreshJob.current;
            const key = JSON.stringify(job);
            const dashboardQuery = job.entitiesNeeded ? DATA_QUALITY_DASHBOARD_WITH_ENTITIES_QUERY : DATA_QUALITY_DASHBOARD_QUERY;
            setLoading(true);
            setComparing(false);
            const [dashboardResult, staleResult] = await Promise.all([
              graphqlQuery<{ dataQualityDashboard: Dashboard }, { domainCode: string | null; fromDate: string; toDate: string; knowledgeDate: string | null; entityId: string | null }>(
                dashboardQuery,
                {
                  domainCode: job.domainCode || null,
                  fromDate: job.toDate,
                  toDate: job.toDate,
                  knowledgeDate: job.knownAt,
                  entityId: job.entityId || null,
                },
                'network-only',
              ),
              graphqlQuery<{ staleAttributes: StaleReport }, { domainCode: string | null; olderThanDays: number; asOfDate: string; knowledgeDate: string | null; entityId: string | null }>(
                STALE_ATTRIBUTES_QUERY,
                {
                  domainCode: job.domainCode || null,
                  olderThanDays: job.staleDays,
                  asOfDate: job.toDate,
                  knowledgeDate: job.knownAt,
                  entityId: job.entityId || null,
                },
                'network-only',
              ),
            ]);
            if (!refreshAlive.current) return;
            if (JSON.stringify(refreshJob.current) !== key) continue;
            if (dashboardResult.aborted || staleResult.aborted) continue;
            if (dashboardResult.error || !dashboardResult.data?.dataQualityDashboard) {
              setError(qualityError(dashboardResult.error?.message, 'Could not load the data quality dashboard.'));
              setDashboard(null);
              setLoading(false);
              refreshApplied.current = key;
              return;
            }
            setError(null);
            setDashboard(dashboardResult.data.dataQualityDashboard);
            setKnownDomains(dashboardResult.data.dataQualityDashboard.domains || []);
            if (staleResult.error || !staleResult.data?.staleAttributes) {
              setStaleReport(null);
              setError(qualityError(staleResult.error?.message, 'Could not load stale attributes.'));
            } else {
              setStaleReport(staleResult.data.staleAttributes);
            }
            setLoading(false);
            if (job.fromDate === job.toDate) {
              refreshApplied.current = key;
              if (JSON.stringify(refreshJob.current) !== key) continue;
              return;
            }
            setComparing(true);
            const compared = await graphqlQuery<{ dataQualityDashboard: Dashboard }, { domainCode: string | null; fromDate: string; toDate: string; knowledgeDate: string | null; entityId: string | null }>(
              dashboardQuery,
              {
                domainCode: job.domainCode || null,
                fromDate: job.fromDate,
                toDate: job.toDate,
                knowledgeDate: job.knownAt,
                entityId: job.entityId || null,
              },
              'network-only',
            );
            if (!refreshAlive.current) return;
            if (JSON.stringify(refreshJob.current) !== key) continue;
            if (compared.error || !compared.data?.dataQualityDashboard) {
              setError(qualityError(compared.error?.message, 'Could not compare the prior date.'));
            } else {
              setError(null);
              setDashboard(compared.data.dataQualityDashboard);
              setKnownDomains(compared.data.dataQualityDashboard.domains || []);
            }
            setComparing(false);
            refreshApplied.current = key;
            if (JSON.stringify(refreshJob.current) !== key) continue;
            return;
          }
        } finally {
          refreshPump.current = false;
          if (refreshAlive.current && JSON.stringify(refreshJob.current) !== refreshApplied.current) pump();
        }
      };
      void run();
    };

    pump();
  }, [domainCode, entityId, fromDate, toDate, knownAt, refreshToken, staleDays, entitiesNeeded]);

  useEffect(() => {
    setOpenKey(null);
    setDetailLimit(DETAIL_PAGE);
    setEntityPages({});
  }, [domainCode, fromDate, toDate, section, view]);

  useEffect(() => {
    setToDate(asOfDate);
    setFromDate((current) => (period === 'custom' && current <= asOfDate ? current : shiftBack(asOfDate, period === 'custom' ? 'day' : period)));
  }, [asOfDate, period]);

  const choosePeriod = (next: Period) => {
    setPeriod(next);
    if (next === 'custom') return;
    setToDate(asOfDate);
    setFromDate(shiftBack(asOfDate, next));
  };

  const summary = dashboard?.summary;
  const scopeScore = useMemo(() => (dashboard?.scores ? scoreFromWeights(dashboard.scores) : null), [dashboard]);
  const typeScoreCards = useMemo(() => (
    [...(dashboard?.entityTypeScores ?? [])]
      .map((row) => ({
        code: row.domainCode ?? '',
        label: row.domainCode ? domainLabel(row.domainCode) : 'All types',
        entityCount: row.entityCount,
        scored: scoreFromWeights(row),
      }))
      .sort((a, b) => compareScores({ score: a.scored.score, label: a.label }, { score: b.scored.score, label: b.label }))
  ), [dashboard]);
  const typeScoreByCode = useMemo(() => new Map(typeScoreCards.map((row) => [row.code, row.scored])), [typeScoreCards]);
  usePublishTabs(qualityTabs(dashboard, staleReport, { fromDate, toDate, domainCode, entityId }));
  const filteredEntities = useMemo(() => {
    const rows = (dashboard?.entities ?? []).filter((entity) => {
      if (section === 'availability') return entity.missingCount > 0 || entity.availabilityResolvedCount > 0 || entity.availabilityIntroducedCount > 0;
      if (section === 'quality') return entity.failingRuleCount > 0 || entity.qualityResolvedCount > 0 || entity.qualityIntroducedCount > 0;
      if (section === 'handoff') return handoffScope === 'all' ? entity.overrideCount > 0 : entity.overrideMatchCount > 0;
      return entity.changeCount > 0;
    });
    const query = entityQuery.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((entity) =>
      entity.entityName.toLowerCase().includes(query) ||
      entity.entityCode.toLowerCase().includes(query) ||
      entity.domainCode.toLowerCase().includes(query)
    );
  }, [dashboard, entityQuery, handoffScope, section]);

  const entityGroups = useMemo(
    () => groupByEntityType(filteredEntities, (entity) => entity.domainCode, domainLabel),
    [filteredEntities],
  );
  const availabilityGroups = useMemo(
    () => groupByEntityType(
      (dashboard?.availability ?? []).filter((row) =>
        (rowScope === 'all' || row.missingCount > 0) && row.attributeName.toLowerCase().includes(measureQuery.trim().toLowerCase())),
      (row) => row.domainCode,
      domainLabel,
    ),
    [dashboard, rowScope, measureQuery],
  );
  const qualityGroups = useMemo(
    () => groupByEntityType(
      splitRulesByEntityType(dashboard?.quality ?? []).filter(
        (rule) => (rowScope === 'all' || !rule.evaluated || rule.failingCount > 0) &&
          rule.ruleName.toLowerCase().includes(measureQuery.trim().toLowerCase()),
      ),
      (rule) => rule.domainCode,
      domainLabel,
    ),
    [dashboard, rowScope, measureQuery],
  );
  const trajectoryGroups = useMemo(
    () => groupByEntityType(
      splitChangesByEntityType(dashboard?.trajectory ?? []),
      (row) => row.domainCode,
      domainLabel,
    ),
    [dashboard],
  );
  const handoffGroups = useMemo(() => {
    const matches = (dashboard?.overrideMatches ?? []).filter((match) => handoffScope === 'all' || match.ready);
    return groupByEntityType(matches, (match) => match.domainCode, domainLabel).map((group) => ({
      ...group,
      attributes: groupMatchesByAttribute(group.items),
    }));
  }, [dashboard, handoffScope]);

  const freshnessEntities = useMemo(() => {
    const query = entityQuery.trim().toLowerCase();
    return groupStaleByEntity(staleReport?.attributes ?? []).filter((entity) =>
      !query ||
      entity.entityName.toLowerCase().includes(query) ||
      entity.entityCode.toLowerCase().includes(query) ||
      entity.domainCode.toLowerCase().includes(query)
    );
  }, [entityQuery, staleReport]);
  const freshnessGroups = useMemo(
    () => groupByEntityType(staleReport?.attributes ?? [], (row) => row.domainCode, domainLabel).map((group) => ({
      ...group,
      attributes: groupStaleByAttribute(group.items),
    })),
    [staleReport],
  );
  const freshnessEntityGroups = useMemo(
    () => groupByEntityType(freshnessEntities, (entity) => entity.domainCode, domainLabel),
    [freshnessEntities],
  );
  const consensusRows = dashboard?.consensusConflicts ?? [];
  const consensusGroups = useMemo(() => {
    const query = measureQuery.trim().toLowerCase();
    const rows = consensusRows.filter((row) => !query || row.attributeName.toLowerCase().includes(query) || row.entityName.toLowerCase().includes(query));
    return groupByEntityType(rows, (row) => row.domainCode, domainLabel).map((group) => ({
      ...group,
      attributes: groupConflictsByAttribute(group.items),
    }));
  }, [consensusRows, measureQuery]);
  const consensusEntities = useMemo(() => {
    const query = entityQuery.trim().toLowerCase();
    return groupConflictsByEntity(consensusRows).filter((entity) =>
      !query ||
      entity.entityName.toLowerCase().includes(query) ||
      entity.entityCode.toLowerCase().includes(query) ||
      entity.domainCode.toLowerCase().includes(query)
    );
  }, [consensusRows, entityQuery]);
  const consensusEntityGroups = useMemo(
    () => groupByEntityType(consensusEntities, (entity) => entity.domainCode, domainLabel),
    [consensusEntities],
  );
  const pageFor = (code: string) => entityPages[code] ?? 0;

  const toggle = (key: string) => {
    setDetailLimit(DETAIL_PAGE);
    setOpenKey((current) => (current === key ? null : key));
  };

  const domainOptions = useMemo(() => {
    const catalog = domainCatalog.length > 0
      ? domainCatalog
      : knownDomains.map((code) => ({
          code,
          name: domainLabel(code),
          groupName: '',
          groupOrder: 0,
          displayOrder: 0,
          parentCode: null,
        }));
    const rows = nestDomainLinks(catalog);
    const options: TypeaheadOption[] = fixedDomain ? [] : [{ value: '', label: 'All domains' }];
    if (fixedDomain && !catalog.some((domain) => domain.code === fixedDomain)) {
      options.push({ value: fixedDomain, label: domainLabel(fixedDomain), search: fixedDomain });
    }
    for (const row of rows) {
      options.push({
        value: row.domain.code,
        label: row.domain.name,
        group: row.domain.groupName || undefined,
        depth: row.depth,
        search: row.domain.code,
      });
    }
    return options;
  }, [domainCatalog, knownDomains, fixedDomain]);

  return (
    <div className="view-fade da">
      <div className="da-sechead">
        <p>{comparing ? `Comparing ${formatDay(fromDate)} to ${formatDay(toDate)}` : `As of ${formatDay(toDate)}`}</p>
        <div className="page-actions">
          {(loading || comparing) && (
            <div className="dq-refreshing" role="status" aria-live="polite">
              <RefreshMark />
              <span>{comparing ? 'Comparing' : 'Refreshing'}</span>
            </div>
          )}
          <Link href="/admin/dq-rules" className="btn">Rules</Link>
        </div>
      </div>

      <div className="dq-toolbar">
        {!entityId && (
          <div className="dq-field dq-domain">
            <label htmlFor="dq-domain">Domain</label>
            <TypeaheadSelect
              id="dq-domain"
              options={domainOptions}
              value={domainCode}
              onChange={setDomainCode}
              placeholder="All domains"
              disabled={Boolean(fixedDomain)}
            />
          </div>
        )}
        <div className="dq-field">
          <label>Period</label>
          <div className="dq-seg" role="group" aria-label="Comparison period">
            {([
              ['day', 'Day'],
              ['week', 'Week'],
              ['month', 'Month'],
              ['quarter', 'Quarter'],
              ['custom', 'Custom'],
            ] as Array<[Period, string]>).map(([value, label]) => (
              <button key={value} type="button" className={period === value ? 'active' : ''} onClick={() => choosePeriod(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="dq-field">
          <label htmlFor="dq-from">From</label>
          <CommittedDateInput
            id="dq-from"
            className="select"
            value={fromDate}
            title="Choosing a day applies it when the calendar closes. Press Enter or click away after stepping the fields."
            onCommit={(value) => {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
              setPeriod('custom');
              setFromDate(value);
            }}
          />
        </div>
        <div className="dq-field">
          <label htmlFor="dq-to">To</label>
          <CommittedDateInput
            id="dq-to"
            className="select"
            value={toDate}
            title="Choosing a day applies it when the calendar closes. Press Enter or click away after stepping the fields."
            onCommit={(value) => {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
              setPeriod('custom');
              setToDate(value);
              setAsOfDate(value);
            }}
          />
        </div>
        <div className="dq-field">
          <label>View</label>
          <div className="dq-seg" role="group" aria-label="Dashboard view">
            <button type="button" className={view === 'measures' ? 'active' : ''} onClick={() => setView('measures')}>{section === 'quality' ? 'Rule' : 'Attribute'}</button>
            <button type="button" className={view === 'entities' ? 'active' : ''} onClick={() => setView('entities')}>Entity</button>
          </div>
        </div>
        <div className="dq-score">
          <div className="da-holdtop">
            <span>Score</span>
            <b>{loading && !scopeScore ? '—' : formatPercent(scopeScore?.score)}</b>
          </div>
          <div
            className="da-bar"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={scopeScore?.score ?? 0}
            aria-label={scopeScore ? `Score ${formatPercent(scopeScore.score)}. ${scoreLine(scopeScore.weights)}` : 'Score'}
          >
            <i style={{ width: `${Math.min(100, Math.max(0, scopeScore?.score ?? 0))}%` }} />
          </div>
        </div>
      </div>

      {error && <div className="dq-error">{error}</div>}

      <div className={`pillar-grid${loading ? ' is-refreshing' : ''}`} aria-busy={loading}>
        <button
          type="button"
          className={`pillar ${section === 'availability' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--accent-2)' } as React.CSSProperties}
          aria-pressed={section === 'availability'}
          onClick={() => setSection('availability')}
        >
          <PillarHead label="Availability" refreshing={loading} tone={!summary ? 'quiet' : (summary.availabilityPercent ?? 0) >= 99.5 ? 'success' : 'attention'} />
          <div className="pillar-val">
            <span>{loading && !summary ? '…' : formatPercent(summary?.availabilityPercent)}</span>
            {summary && <DirectionMark up={summary.availabilityResolvedCount} down={summary.availabilityIntroducedCount} pending={comparing} upLabel="filled in" downLabel="now missing" />}
          </div>
          <div className="pillar-sub">required attributes populated</div>
          <div className="pillar-det">
            {summary ? `${summary.populatedSlots.toLocaleString()} of ${summary.requiredSlots.toLocaleString()} required values${comparing ? ' · comparing the prior date' : ` · ${summary.availabilityResolvedCount.toLocaleString()} filled in · ${summary.availabilityIntroducedCount.toLocaleString()} now missing`}` : 'Loading required attributes'}
          </div>
        </button>
        <button
          type="button"
          className={`pillar ${section === 'quality' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--green)' } as React.CSSProperties}
          aria-pressed={section === 'quality'}
          onClick={() => setSection('quality')}
        >
          <PillarHead label="Quality" refreshing={loading} tone={!summary ? 'quiet' : (summary.qualityPercent ?? 0) >= 99 ? 'success' : 'attention'} />
          <div className="pillar-val">
            <span>{loading && !summary ? '…' : formatPercent(summary?.qualityPercent)}</span>
            {summary && <DirectionMark up={summary.qualityResolvedCount} down={summary.qualityIntroducedCount} pending={comparing} upLabel="now passing" downLabel="now failing" />}
          </div>
          <div className="pillar-sub">rule checks passing</div>
          <div className="pillar-det">
            {summary ? `${summary.failingChecks.toLocaleString()} failing${comparing ? ' · comparing the prior date' : ` · ${summary.qualityResolvedCount.toLocaleString()} now passing · ${summary.qualityIntroducedCount.toLocaleString()} now failing`}` : 'Loading rules'}
          </div>
        </button>
        <button
          type="button"
          className={`pillar ${section === 'trajectory' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--accent)' } as React.CSSProperties}
          aria-pressed={section === 'trajectory'}
          onClick={() => setSection('trajectory')}
        >
          <PillarHead label="Trajectory" refreshing={loading || comparing} tone="quiet" />
          <div className="pillar-val">
            <span>{(loading && !summary) || comparing ? '…' : (summary?.attributeChangeCount ?? 0).toLocaleString()}</span>
            {summary && !comparing && <ValueDirection changes={(dashboard?.trajectory ?? []).flatMap((row) => row.changes)} />}
            {comparing && <DirectionArrow direction="wait" label="Comparing the prior date" />}
          </div>
          <div className="pillar-sub">attribute values changed</div>
          <div className="pillar-det">
            {comparing ? `Comparing ${formatDay(fromDate)} to ${formatDay(toDate)}` : summary ? `${summary.changedEntityCount.toLocaleString()} entities · ${summary.changedAttributeCount.toLocaleString()} attributes · ${formatDay(fromDate)} to ${formatDay(toDate)}` : 'Comparing periods'}
          </div>
        </button>
        <button
          type="button"
          className={`pillar ${section === 'handoff' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--amber)' } as React.CSSProperties}
          aria-pressed={section === 'handoff'}
          onClick={() => setSection('handoff')}
        >
          <PillarHead label="Handoff" refreshing={loading} tone="quiet" />
          <div className="pillar-val">
            {loading && !summary ? '…' : (summary?.overrideMatchCount ?? 0).toLocaleString()}
          </div>
          <div className="pillar-sub">overrides ready to release</div>
          <div className="pillar-det">
            {summary ? `Priority source matches the manual value as of ${formatDay(toDate)}` : 'Comparing overrides'}
          </div>
        </button>
        <button
          type="button"
          className={`pillar ${section === 'freshness' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--gold)' } as React.CSSProperties}
          aria-pressed={section === 'freshness'}
          onClick={() => setSection('freshness')}
        >
          <PillarHead label="Freshness" refreshing={loading} tone={!staleReport ? 'quiet' : staleReport.count > 0 ? 'attention' : 'success'} />
          <div className="pillar-val">
            {loading && !staleReport ? '…' : (staleReport?.count ?? 0).toLocaleString()}
          </div>
          <div className="pillar-sub">stale prevailing values</div>
          <div className="pillar-det">
            {loading
              ? `Refreshing as of ${formatDay(toDate)}`
              : staleReport
                ? `Not received in ${staleReport.olderThanDays} days as of ${formatDay(staleReport.asOfDate)}`
                : 'Checking last receipt'}
          </div>
        </button>
        <button
          type="button"
          className={`pillar ${section === 'consensus' ? 'active' : ''}`}
          style={{ '--pillar-color': 'var(--red)' } as React.CSSProperties}
          aria-pressed={section === 'consensus'}
          onClick={() => setSection('consensus')}
        >
          <PillarHead label="Consensus" refreshing={loading} tone={!dashboard ? 'quiet' : consensusRows.length > 0 ? 'attention' : 'success'} />
          <div className="pillar-val">
            {loading && !dashboard ? '…' : consensusRows.length.toLocaleString()}
          </div>
          <div className="pillar-sub">values disagree with the golden source</div>
          <div className="pillar-det">
            {scopeScore
              ? `${formatPercent(scopeScore.consensus)} of attributes with a second active value agree`
              : `Comparing sources as of ${formatDay(toDate)}`}
          </div>
        </button>
      </div>

      {view === 'measures' && section === 'availability' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Data availability by attribute</div>
              <p>Required attributes come from the entity template. Resolved means a gap on {formatDay(fromDate)} now has a value. Introduced means a value then is missing on {formatDay(toDate)}.</p>
            </div>
            <div className="dq-head-tools">
              <input className="text-input" placeholder="Search attributes" value={measureQuery} onChange={(event) => setMeasureQuery(event.target.value)} aria-label="Search attributes" />
              <ExceptionScopeRadios name="dq-scope-availability" value={rowScope} onChange={setRowScope} />
            </div>
          </div>
          {loading && !dashboard && <div className="dq-empty">Loading availability…</div>}
          {dashboard && availabilityGroups.length === 0 && (
            <div className="dq-empty">
              {rowScope === 'exceptions' && (dashboard.availability?.length ?? 0) > 0
                ? 'Every required attribute is fully populated.'
                : 'No required attributes are defined for this selection. Mark attributes required on the template or the attribute register.'}
            </div>
          )}
          {availabilityGroups.map((group) => (
            <div className="dq-type" key={group.code || 'all'}>
              <TypeHead code={group.code} count={group.items.length} singular="attribute" score={typeScoreByCode.get(group.code)?.score} />
              <div className="dq-grid dq-avail">
                <div />
                <div>Attribute</div>
                <div>Required</div>
                <div>Missing</div>
                <div>Change</div>
                <div>Availability</div>
              </div>
              {group.items.map((row) => {
            const key = `avail-${group.code}-${row.attributeCode}`;
            const open = openKey === key;
            return (
              <div className="dq-line" key={key}>
                <button type="button" className="dq-open dq-avail" aria-expanded={open} onClick={() => toggle(key)}>
                  <span>{open ? '▾' : '▸'}</span>
                  <span className="dq-name">
                    {row.attributeName}
                    {comparing && <span className="dq-sub">Comparing the prior date</span>}
                  </span>
                  <span className="dq-num">{row.requiredCount.toLocaleString()}</span>
                  <span className="dq-num" style={{ color: row.missingCount ? 'var(--red)' : 'var(--green)' }}>{row.missingCount.toLocaleString()}</span>
                  <DirectionMark up={row.resolvedCount} down={row.introducedCount} pending={comparing} upLabel="filled in" downLabel="now missing" />
                  <span className="qm-bar-wrap">
                    <span className="qm-bar"><span style={{ background: barColor(row.availabilityPercent), width: `${row.availabilityPercent ?? 0}%` }} /></span>
                    <span className="qm-pct">{formatPercent(row.availabilityPercent)}</span>
                  </span>
                </button>
                {open && (
                  <AvailabilityDetail
                    attributeCode={row.attributeCode}
                    attributeName={row.attributeName}
                    domainCode={row.domainCode}
                    entityId={entityId}
                    fromDate={fromDate}
                    toDate={toDate}
                    knownAt={knownAt}
                    refreshToken={refreshToken}
                    limit={detailLimit}
                    onMore={() => setDetailLimit((count) => count + DETAIL_PAGE)}
                    onDone={() => setRefreshToken((token) => token + 1)}
                  />
                )}
              </div>
            );
              })}
            </div>
          ))}
        </section>
      )}

      {view === 'measures' && section === 'quality' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Data quality by rule</div>
              <p>Each active rule is checked as of {formatDay(toDate)}{knownAt ? `, using what was known at ${new Date(knownAt).toLocaleString()}` : ''}. Resolved means it failed on {formatDay(fromDate)} and passes on {formatDay(toDate)}. Introduced means it passed then and fails on {formatDay(toDate)}. Waived results stay off the failing list.</p>
            </div>
            <div className="dq-head-tools">
              <input className="text-input" placeholder="Search rules" value={measureQuery} onChange={(event) => setMeasureQuery(event.target.value)} aria-label="Search rules" />
              <ExceptionScopeRadios name="dq-scope-quality" value={rowScope} onChange={setRowScope} />
            </div>
          </div>
          {loading && !dashboard && <div className="dq-empty">Loading rules…</div>}
          {dashboard && qualityGroups.length === 0 && (
            <div className="dq-empty">
              {rowScope === 'exceptions' && (dashboard.quality?.length ?? 0) > 0
                ? 'Every active rule is passing.'
                : 'No active data quality rules match this selection.'}
            </div>
          )}
          {qualityGroups.map((group) => (
            <div className="dq-type" key={group.code || 'all'}>
              <TypeHead code={group.code} count={group.items.length} singular="rule" score={typeScoreByCode.get(group.code)?.score} />
              <div className="dq-grid dq-qual">
                <div />
                <div>Rule</div>
                <div>Severity</div>
                <div>Checked</div>
                <div>Failing</div>
                <div>Change</div>
              </div>
              {group.items.map((rule) => {
            const key = `rule-${group.code}-${rule.ruleId}`;
            const open = openKey === key;
            return (
              <div className="dq-line" key={key}>
                <button type="button" className="dq-open dq-qual" aria-expanded={open} onClick={() => toggle(key)}>
                  <span>{open ? '▾' : '▸'}</span>
                  <span className="dq-name">
                    {rule.ruleName}
                    {comparing && <span className="dq-sub">Comparing the prior date</span>}
                  </span>
                  <span><span className={`sev-dot ${severityClass(rule.severity)}`} />{rule.severity}</span>
                  <span className="dq-num" title={rule.checkedKnown === false ? 'This rule covers more than one entity type, so the checked total stays with the whole book.' : undefined}>{rule.checkedKnown === false ? '—' : rule.entityCount.toLocaleString()}</span>
                  <span className="dq-num" style={{ color: rule.failingCount ? 'var(--red)' : 'var(--green)' }}>
                    {rule.evaluated ? rule.failingCount.toLocaleString() : '—'}
                  </span>
                  <DirectionMark up={rule.resolvedCount} down={rule.introducedCount} pending={comparing} upLabel="now passing" downLabel="now failing" />
                </button>
                {open && (
                  <div className="dq-detail">
                    {rule.ruleDescription && <p>{rule.ruleDescription}</p>}
                    {!rule.evaluated && <div className="dq-empty">{rule.evaluationMessage || 'This expression is not evaluated automatically.'}</div>}
                    {rule.evaluated && rule.failingEntities.length === 0 && rule.acceptedEntities.length === 0 && (
                      <div className="dq-empty">No entities are failing this rule.</div>
                    )}
                    {(rule.failingEntities.length > 0 || rule.acceptedEntities.length > 0) && (
                      <div className="ex-card">
                        <div className="ex-grid ex-grid-head">
                          <div>Entity</div>
                          <div>Actual</div>
                          <div>Corrected value</div>
                        </div>
                        {rule.failingEntities.slice(0, detailLimit).map((entity) => (
                          <ExceptionRow
                            key={entity.id}
                            entityId={entity.id}
                            ruleId={rule.ruleId}
                            ruleName={entity.entityName}
                            severity={rule.severity}
                            attributeCode={entity.attributeCode || rule.attributeCode}
                            actualValue={entity.actualValue}
                            asOf={toDate}
                            href={entityHref(entity.domainCode, entity.id)}
                            onDone={() => setRefreshToken((token) => token + 1)}
                          />
                        ))}
                        {rule.acceptedEntities.map((entity) => (
                          <div className="ex-grid ex-row" key={entity.id}>
                            <div>
                              <Link href={entityHref(entity.domainCode, entity.id)} className="ex-rule">{entity.entityName}</Link>
                              <div className="dq-sub">{entity.status === 'FALSE_POSITIVE' ? 'Not an issue' : 'Waived'}</div>
                            </div>
                            <div className="dq-sub">{entity.notes || '—'}</div>
                            <div>
                              <button type="button" className="btn btn-sm" onClick={() => reopenRule(entity.id, rule.ruleId, toDate, () => setRefreshToken((token) => token + 1))}>Reopen</button>
                            </div>
                          </div>
                        ))}
                        {rule.failingEntities.length > detailLimit && (
                          <button type="button" className="dq-more" onClick={() => setDetailLimit((count) => count + DETAIL_PAGE)}>
                            Show more ({rule.failingEntities.length - detailLimit} remaining)
                          </button>
                        )}
                        <div className="ex-foot">Edits stay in the row until you save. Waive and Not an issue ask for a short reason and are kept with the exception.</div>
                      </div>
                    )}
                    <ShiftTables
                      resolved={rule.resolvedEntities}
                      introduced={rule.introducedEntities}
                      fromDate={fromDate}
                      toDate={toDate}
                      limit={detailLimit}
                      onMore={() => setDetailLimit((count) => count + DETAIL_PAGE)}
                    />
                  </div>
                )}
              </div>
            );
              })}
            </div>
          ))}
        </section>
      )}

      {view === 'measures' && section === 'trajectory' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Data trajectory by attribute</div>
              <p>Golden values that differ between {formatDay(fromDate)} and {formatDay(toDate)}. The count is the number of entities whose value changed.</p>
            </div>
          </div>
          {loading && !dashboard && <div className="dq-empty">Loading the current date…</div>}
          {comparing && dashboard && trajectoryGroups.length === 0 && <div className="dq-empty">Comparing {formatDay(fromDate)} to {formatDay(toDate)}…</div>}
          {!comparing && dashboard && trajectoryGroups.length === 0 && <div className="dq-empty">No attribute values changed in this period.</div>}
          {trajectoryGroups.map((group) => (
            <div className="dq-type" key={group.code || 'all'}>
              <TypeHead code={group.code} count={group.items.length} singular="attribute" score={typeScoreByCode.get(group.code)?.score} />
              <div className="dq-grid dq-traj">
                <div />
                <div>Attribute</div>
                <div>Entities changed</div>
                <div>Change</div>
              </div>
              {group.items.map((row) => {
            const key = `traj-${group.code}-${row.attributeCode}`;
            const open = openKey === key;
            return (
              <div className="dq-line" key={key}>
                <button type="button" className="dq-open dq-traj" aria-expanded={open} onClick={() => toggle(key)}>
                  <span>{open ? '▾' : '▸'}</span>
                  <span className="dq-name">
                    {row.attributeName}
                  </span>
                  <span className="dq-num">{row.changeCount.toLocaleString()}</span>
                  <ValueDirection changes={row.changes} />
                </button>
                {open && (
                  <div className="dq-detail">
                    <AppGrid
                      rows={row.changes.slice(0, detailLimit)}
                      columns={trajectoryChangeColumns(fromDate, toDate)}
                      getRowId={(change) => change.id}
                      autoHeight
                      autoRowHeight
                      emptyMessage="No changes."
                    />
                    {row.changes.length > detailLimit && (
                      <button type="button" className="dq-more" onClick={() => setDetailLimit((count) => count + DETAIL_PAGE)}>
                        Show more ({row.changes.length - detailLimit} remaining)
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
              })}
            </div>
          ))}
        </section>
      )}

      {view === 'measures' && section === 'handoff' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Overrides by attribute</div>
              <p>
                {handoffScope === 'ready'
                  ? `Attributes where the highest-ranked system source now has the same value as the manual override. Clearing the override keeps it on earlier as-of dates and lets that source own the value from ${formatDay(toDate)} forward.`
                  : `Every manual override in effect as of ${formatDay(toDate)}. Ready rows match the highest-ranked system source and can be cleared. The others still differ from that source, or have no other source.`}
              </p>
            </div>
            <HandoffScopeToggle value={handoffScope} onChange={(next) => { setHandoffScope(next); setEntityPages({}); }} />
          </div>
          {loading && !dashboard && <div className="dq-empty">Comparing overrides…</div>}
          {dashboard && handoffGroups.length === 0 && (
            <div className="dq-empty">
              {handoffScope === 'ready'
                ? 'No manual override currently matches its priority source.'
                : `No manual override is in effect as of ${formatDay(toDate)}.`}
            </div>
          )}
          {handoffGroups.map((group) => (
            <div className="dq-type" key={group.code || 'all'}>
              <TypeHead code={group.code} count={group.attributes.length} singular="attribute" score={typeScoreByCode.get(group.code)?.score} />
              <div className="dq-grid dq-hand-attr">
                <div />
                <div>Attribute</div>
                <div>{handoffScope === 'ready' ? 'Ready' : 'Overrides'}</div>
              </div>
              {group.attributes.map((attribute) => {
            const key = `hand-${group.code}-${attribute.attributeCode}`;
            const open = isBranchOpen(openKey, key);
            return (
              <div className="dq-line" key={key}>
                <button type="button" className="dq-open dq-hand-attr" aria-expanded={open} onClick={() => toggle(key)}>
                  <span>{open ? '▾' : '▸'}</span>
                  <span className="dq-name">
                    {attribute.attributeName}
                  </span>
                  <span className="dq-num">
                    {attribute.matches.length.toLocaleString()}
                    {handoffScope === 'all' && (
                      <span className="dq-sub">{attribute.matches.filter((match) => match.ready).length.toLocaleString()} ready</span>
                    )}
                  </span>
                </button>
                {open && (
                  <div className="dq-detail">
                    <div className={`dq-grid dq-hand ${handoffScope === 'all' ? 'dq-hand-all' : ''}`}>
                      <div />
                      {handoffScope === 'all' && <div>Status</div>}
                      <div>Entity</div>
                      <div>Attribute</div>
                      <div>Priority source</div>
                      <div>{handoffScope === 'all' ? 'Override' : 'Value'}</div>
                      {handoffScope === 'all' && <div>Source</div>}
                      <div />
                    </div>
                    {attribute.matches.slice(0, detailLimit).map((match) => {
                      const matchKey = `${key}::${match.id}`;
                      return (
                        <HandoffMatch
                          key={matchKey}
                          match={match}
                          open={openKey === matchKey}
                          asOf={toDate}
                          showStatus={handoffScope === 'all'}
                          onToggle={() => toggle(matchKey)}
                          onDone={() => setRefreshToken((token) => token + 1)}
                        />
                      );
                    })}
                    {attribute.matches.length > detailLimit && (
                      <button type="button" className="dq-more" onClick={() => setDetailLimit((count) => count + DETAIL_PAGE)}>
                        Show more ({attribute.matches.length - detailLimit} remaining)
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
              })}
            </div>
          ))}
        </section>
      )}

      {view === 'measures' && section === 'freshness' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Stale values by attribute</div>
              <p>
                The winning source last delivered these values more than {staleDays} days ago. Reloading the same value still counts as received. Calculated values are left out.
                {staleReport && staleReport.count > staleReport.attributes.length
                  ? ` Showing the ${staleReport.attributes.length} oldest of ${staleReport.count.toLocaleString()}.`
                  : ''}
              </p>
            </div>
            <div className="dq-field">
              <label htmlFor="stale-days">Older than</label>
              <select id="stale-days" className="select" value={staleDays} onChange={(event) => setStaleDays(Number(event.target.value))}>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
              </select>
            </div>
          </div>
          {loading && !staleReport && <div className="dq-empty">Checking receipts…</div>}
          {staleReport && freshnessGroups.length === 0 && (
            <div className="dq-empty">No prevailing value is older than {staleDays} days.</div>
          )}
          {freshnessGroups.map((group) => (
            <div className="dq-type" key={group.code || 'all'}>
              <TypeHead code={group.code} count={group.attributes.length} singular="attribute" score={typeScoreByCode.get(group.code)?.score} />
              <div className="dq-grid dq-fresh">
                <div />
                <div>Attribute</div>
                <div>Stale</div>
                <div>Oldest</div>
              </div>
              {group.attributes.map((attribute) => {
            const key = `fresh-${group.code}-${attribute.attributeCode}`;
            const open = openKey === key;
            return (
              <div className="dq-line" key={key}>
                <button type="button" className="dq-open dq-fresh" aria-expanded={open} onClick={() => toggle(key)}>
                  <span>{open ? '▾' : '▸'}</span>
                  <span className="dq-name">
                    {attribute.attributeName}
                  </span>
                  <span className="dq-num">{attribute.rows.length.toLocaleString()}</span>
                  <span className="dq-num">{oldestAge(attribute.rows)}d</span>
                </button>
                {open && (
                  <StaleTable
                    rows={attribute.rows}
                    limit={detailLimit}
                    showEntity
                    onMore={() => setDetailLimit((count) => count + DETAIL_PAGE)}
                    onConfirmed={() => setRefreshToken((token) => token + 1)}
                  />
                )}
              </div>
            );
              })}
            </div>
          ))}
        </section>
      )}

      {view === 'entities' && section === 'freshness' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Stale values by entity</div>
              <p>
                Entities whose prevailing source last delivered a value more than {staleDays} days ago. Reloading the same value still counts as received. Calculated values are left out.
                {staleReport && staleReport.count > staleReport.attributes.length
                  ? ` Showing the ${staleReport.attributes.length} oldest of ${staleReport.count.toLocaleString()}.`
                  : ''}
                {staleReport ? ` ${freshnessEntities.length.toLocaleString()} shown.` : ''}
              </p>
            </div>
            <div className="dq-head-tools">
              <input
                className="text-input"
                placeholder="Search entities"
                value={entityQuery}
                onChange={(event) => { setEntityQuery(event.target.value); setEntityPages({}); }}
                aria-label="Search entities"
              />
              <div className="dq-field">
                <label htmlFor="stale-days-entity">Older than</label>
                <select id="stale-days-entity" className="select" value={staleDays} onChange={(event) => setStaleDays(Number(event.target.value))}>
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                  <option value={180}>180 days</option>
                </select>
              </div>
            </div>
          </div>
          {loading && !staleReport && <div className="dq-empty">Checking receipts…</div>}
          {staleReport && freshnessEntityGroups.length === 0 && (
            <div className="dq-empty">
              {entityQuery.trim() ? 'No entities match that search.' : `No prevailing value is older than ${staleDays} days.`}
            </div>
          )}
          {freshnessEntityGroups.map((group) => {
            const slice = slicePage(group.items, pageFor(group.code));
            return (
            <div className="dq-type" key={group.code || 'all'}>
              <TypeHead code={group.code} count={group.items.length} singular="entity" plural="entities" score={typeScoreByCode.get(group.code)?.score} />
              <div className="dq-grid dq-fresh">
                <div />
                <div>Entity</div>
                <div>Stale</div>
                <div>Oldest</div>
              </div>
              {slice.rows.map((entity) => {
            const key = `fresh-ent-${entity.entityId}`;
            const open = openKey === key;
            return (
              <div className="dq-line" key={key}>
                <button type="button" className="dq-open dq-fresh" aria-expanded={open} onClick={() => toggle(key)}>
                  <span>{open ? '▾' : '▸'}</span>
                  <span className="dq-name">
                    {entity.entityName}
                  </span>
                  <span className="dq-num">{entity.rows.length.toLocaleString()}</span>
                  <span className="dq-num">{oldestAge(entity.rows)}d</span>
                </button>
                {open && (
                  <StaleTable
                    rows={entity.rows}
                    limit={detailLimit}
                    showAttribute
                    entityHref={entityHref(entity.domainCode, entity.entityId)}
                    onMore={() => setDetailLimit((count) => count + DETAIL_PAGE)}
                    onConfirmed={() => setRefreshToken((token) => token + 1)}
                  />
                )}
              </div>
            );
              })}
              <GroupPager page={slice.page} pageCount={slice.pageCount} onPage={(page) => setEntityPages((current) => ({ ...current, [group.code]: page }))} />
            </div>
            );
          })}
        </section>
      )}

      {view === 'measures' && section === 'consensus' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Consensus by attribute</div>
              <p>
                Active values that disagree with the golden source as of {formatDay(toDate)}. An attribute passes consensus when every other active value matches the golden source. An attribute with only the golden source is left out of the score.
              </p>
            </div>
            <div className="dq-head-tools">
              <input className="text-input" placeholder="Search attributes" value={measureQuery} onChange={(event) => setMeasureQuery(event.target.value)} aria-label="Search attributes" />
            </div>
          </div>
          {loading && !dashboard && <div className="dq-empty">Comparing sources…</div>}
          {dashboard && consensusGroups.length === 0 && (
            <div className="dq-empty">
              {measureQuery.trim()
                ? 'No conflicts match that search.'
                : scopeScore?.weights.consensusApplicable
                  ? 'Every other active value agrees with the golden source.'
                  : 'No attribute has a golden source and another active value.'}
            </div>
          )}
          {consensusGroups.map((group) => (
            <div className="dq-type" key={group.code || 'all'}>
              <TypeHead code={group.code} count={group.attributes.length} singular="attribute" score={typeScoreByCode.get(group.code)?.score} />
              <div className="dq-grid dq-hand-attr">
                <div />
                <div>Attribute</div>
                <div>Conflicts</div>
              </div>
              {group.attributes.map((attribute) => {
                const key = `cons-${group.code}-${attribute.attributeCode}`;
                const open = openKey === key;
                return (
                  <div className="dq-line" key={key}>
                    <button type="button" className="dq-open dq-hand-attr" aria-expanded={open} onClick={() => toggle(key)}>
                      <span>{open ? '▾' : '▸'}</span>
                      <span className="dq-name">{attribute.attributeName}</span>
                      <span className="dq-num">{attribute.rows.length.toLocaleString()}</span>
                    </button>
                    {open && (
                      <ConflictTable
                        rows={attribute.rows}
                        limit={detailLimit}
                        showEntity
                        onMore={() => setDetailLimit((count) => count + DETAIL_PAGE)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      )}

      {view === 'entities' && section === 'consensus' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Consensus by entity</div>
              <p>
                Records whose golden source disagrees with another active value as of {formatDay(toDate)}.
                {dashboard ? ` ${consensusEntities.length.toLocaleString()} shown.` : ''}
              </p>
            </div>
            <input
              className="text-input"
              placeholder="Search entities"
              value={entityQuery}
              onChange={(event) => { setEntityQuery(event.target.value); setEntityPages({}); }}
              aria-label="Search entities"
            />
          </div>
          {loading && !dashboard && <div className="dq-empty">Comparing sources…</div>}
          {dashboard && consensusEntityGroups.length === 0 && (
            <div className="dq-empty">
              {entityQuery.trim() ? 'No entities match that search.' : 'No golden source disagrees with another active value.'}
            </div>
          )}
          {consensusEntityGroups.map((group) => {
            const slice = slicePage(group.items, pageFor(group.code));
            return (
              <div className="dq-type" key={group.code || 'all'}>
                <TypeHead code={group.code} count={group.items.length} singular="entity" plural="entities" score={typeScoreByCode.get(group.code)?.score} />
                <div className="dq-grid dq-hand-attr">
                  <div />
                  <div>Entity</div>
                  <div>Conflicts</div>
                </div>
                {slice.rows.map((entity) => {
                  const key = `cons-ent-${entity.entityId}`;
                  const open = openKey === key;
                  return (
                    <div className="dq-line" key={key}>
                      <button type="button" className="dq-open dq-hand-attr" aria-expanded={open} onClick={() => toggle(key)}>
                        <span>{open ? '▾' : '▸'}</span>
                        <span className="dq-name">{entity.entityName}</span>
                        <span className="dq-num">{entity.rows.length.toLocaleString()}</span>
                      </button>
                      {open && (
                        <ConflictTable
                          rows={entity.rows}
                          limit={detailLimit}
                          showAttribute
                          onMore={() => setDetailLimit((count) => count + DETAIL_PAGE)}
                        />
                      )}
                    </div>
                  );
                })}
                <GroupPager page={slice.page} pageCount={slice.pageCount} onPage={(page) => setEntityPages((current) => ({ ...current, [group.code]: page }))} />
              </div>
            );
          })}
        </section>
      )}

      {view === 'entities' && section !== 'freshness' && section !== 'consensus' && (
        <section className="dq-panel">
          <div className="dq-head">
            <div>
              <div className="qm-title">Results by entity</div>
              <p>
                {section === 'availability' && `Entities with a required-attribute gap, or a gap that was resolved or introduced between ${formatDay(fromDate)} and ${formatDay(toDate)}. The score is that record's score across every check.`}
                {section === 'quality' && `Entities failing a rule, or whose rule result was resolved or introduced between ${formatDay(fromDate)} and ${formatDay(toDate)}.`}
                {section === 'trajectory' && `Entities whose values changed between ${formatDay(fromDate)} and ${formatDay(toDate)}.`}
                {section === 'handoff' && handoffScope === 'ready' && `Entities whose manual override matches the priority source as of ${formatDay(toDate)}.`}
                {section === 'handoff' && handoffScope === 'all' && `Entities with a manual override in effect as of ${formatDay(toDate)}.`}
                {summary ? ` ${filteredEntities.length.toLocaleString()} shown.` : ''}
              </p>
            </div>
            <div className="dq-head-tools">
              {section === 'handoff' && (
                <HandoffScopeToggle value={handoffScope} onChange={(next) => { setHandoffScope(next); setEntityPages({}); }} />
              )}
              <input
                className="text-input"
                placeholder="Search entities"
                value={entityQuery}
                onChange={(event) => { setEntityQuery(event.target.value); setEntityPages({}); }}
                aria-label="Search entities"
              />
            </div>
          </div>
          {!dashboard?.entities && !error && <div className="dq-empty">Loading entities…</div>}
          {comparing && entityGroups.length === 0 && section === 'trajectory' && <div className="dq-empty">Comparing {formatDay(fromDate)} to {formatDay(toDate)}…</div>}
          {!comparing && dashboard?.entities && entityGroups.length === 0 && (
            <div className="dq-empty">
              {section === 'availability' && 'No required-attribute gaps opened or closed in this period.'}
              {section === 'quality' && 'No rule results opened or closed in this period.'}
              {section === 'trajectory' && 'No entity values changed in this period.'}
              {section === 'handoff' && (handoffScope === 'ready'
                ? 'No manual override matches its priority source.'
                : `No manual override is in effect as of ${formatDay(toDate)}.`)}
            </div>
          )}
          {entityGroups.map((group) => {
            const slice = slicePage(group.items, pageFor(`ent-${group.code}`));
            return (
            <div className="dq-type" key={group.code || 'all'}>
              <TypeHead code={group.code} count={group.items.length} singular="entity" plural="entities" score={typeScoreByCode.get(group.code)?.score} />
              <div className={`dq-grid ${section === 'handoff' ? 'dq-ent-hand' : 'dq-ent-one'}`}>
                <div />
                <div>Entity</div>
                <div>Score</div>
                {section === 'handoff' && <div>{handoffScope === 'ready' ? 'Ready' : 'Overrides'}</div>}
                {section === 'availability' && <div>Missing</div>}
                {section === 'quality' && <div>Failing</div>}
                {section === 'trajectory' && <div>Changes</div>}
              </div>
              {slice.rows.map((entity) => {
            const key = `ent-${entity.id}`;
            const open = openKey === key;
            return (
              <div className="dq-line" key={key}>
                <button type="button" className={`dq-open ${section === 'handoff' ? 'dq-ent-hand' : 'dq-ent-one'}`} aria-expanded={open} onClick={() => toggle(key)}>
                  <span>{open ? '▾' : '▸'}</span>
                  <span className="dq-name">
                    {entity.entityName}
                    <span className="dq-sub">{scoreLine(entity)}</span>
                  </span>
                  <span className="dq-num">{formatPercent(scoreFromWeights(entity).score)}</span>
                  {section === 'handoff' && (
                    <span className="dq-num">
                      {(handoffScope === 'all' ? entity.overrideCount : entity.overrideMatchCount).toLocaleString()}
                      {handoffScope === 'all' && entity.overrideMatchCount > 0 && (
                        <span className="dq-sub">{entity.overrideMatchCount.toLocaleString()} ready</span>
                      )}
                    </span>
                  )}
                  {section === 'availability' && <span className="dq-num">{entity.requiredCount === 0 ? '—' : `${entity.missingCount} missing`}</span>}
                  {section === 'quality' && <span className="dq-num">{entity.ruleCount === 0 ? '—' : `${entity.failingRuleCount} failing`}</span>}
                  {section === 'trajectory' && <span className="dq-num">{entity.changeCount.toLocaleString()}</span>}
                </button>
                {open && section === 'handoff' && (
                  <div className="dq-detail">
                    {(dashboard?.overrideMatches || []).filter((match) => match.id === entity.id && (handoffScope === 'all' || match.ready)).map((match) => (
                      <div className="dq-case" key={match.attributeCode}>
                        <div>
                          <strong>{match.attributeName}</strong>
                          <span className="dq-sub">
                            {handoffScope === 'all' ? `${handoffStatusLabel(match)} · ` : ''}
                            {match.prioritySourceName
                              ? `${match.prioritySourceName} has ${displayValue(match.priorityValue)}`
                              : 'No other source'}
                            {handoffScope === 'all' ? ` · override ${displayValue(match.overrideValue)}` : ''}
                          </span>
                        </div>
                        <HandoffSources
                          entityId={match.id}
                          attributeCode={match.attributeCode}
                          asOf={toDate}
                          prioritySourceCode={match.prioritySourceCode}
                        />
                        {match.ready && (
                          <ClearOverrideButton
                            entityId={match.id}
                            attributeCode={match.attributeCode}
                            asOf={toDate}
                            onDone={() => setRefreshToken((token) => token + 1)}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {open && section === 'availability' && (
                  <div className="dq-detail">
                    {entity.missingAttributes.length === 0 ? (
                      <div className="dq-sub">{entity.requiredCount === 0 ? 'No required attributes for this entity.' : 'All required attributes are populated.'}</div>
                    ) : entity.missingAttributes.map((attribute) => (
                      <div className="dq-check" key={attribute.attributeCode}>
                        <div>
                          <div className="dq-check-name">{attribute.attributeName}</div>
                        </div>
                        <ResolveForm
                          entityId={entity.id}
                          attributeCode={attribute.attributeCode}
                          attributeName={attribute.attributeName}
                          actualValue=""
                          asOf={toDate}
                          onDone={() => setRefreshToken((token) => token + 1)}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {open && section === 'quality' && (
                  <ExceptionBoard
                    entity={entity}
                    asOf={toDate}
                    onDone={() => setRefreshToken((token) => token + 1)}
                  />
                )}
                {open && section === 'trajectory' && (
                  <div className="dq-detail">
                    {entity.changes.length === 0 ? (
                      <div className="dq-sub">No attribute values changed between {formatDay(fromDate)} and {formatDay(toDate)}.</div>
                    ) : (
                      <AppGrid
                        rows={entity.changes}
                        columns={entityChangeColumns(fromDate, toDate)}
                        getRowId={(change) => change.attributeCode}
                        autoHeight
                        emptyMessage="No changes."
                      />
                    )}
                    <div><Link href={entityHref(entity.domainCode, entity.id)}>Open entity</Link></div>
                  </div>
                )}
              </div>
            );
              })}
              <GroupPager page={slice.page} pageCount={slice.pageCount} onPage={(page) => setEntityPages((current) => ({ ...current, [`ent-${group.code}`]: page }))} />
            </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

function isBranchOpen(openKey: string | null, key: string) {
  return openKey === key || (openKey?.startsWith(`${key}::`) ?? false);
}

function oldestAge(rows: Array<{ ageDays: number }>) {
  return rows.reduce((oldest, row) => Math.max(oldest, row.ageDays), 0);
}

function groupMatchesByAttribute(matches: OverrideMatch[]) {
  const groups = new Map<string, { attributeCode: string; attributeName: string; matches: OverrideMatch[] }>();
  for (const match of matches) {
    const existing = groups.get(match.attributeCode);
    if (existing) existing.matches.push(match);
    else groups.set(match.attributeCode, { attributeCode: match.attributeCode, attributeName: match.attributeName, matches: [match] });
  }
  return [...groups.values()].sort((a, b) => b.matches.length - a.matches.length || a.attributeName.localeCompare(b.attributeName));
}

function groupConflictsByAttribute(rows: ConsensusConflict[]) {
  const groups = new Map<string, { attributeCode: string; attributeName: string; rows: ConsensusConflict[] }>();
  for (const row of rows) {
    const existing = groups.get(row.attributeCode);
    if (existing) existing.rows.push(row);
    else groups.set(row.attributeCode, { attributeCode: row.attributeCode, attributeName: row.attributeName, rows: [row] });
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.attributeName.localeCompare(b.attributeName));
}

function groupConflictsByEntity(rows: ConsensusConflict[]) {
  const groups = new Map<string, { entityId: string; entityCode: string; entityName: string; domainCode: string; rows: ConsensusConflict[] }>();
  for (const row of rows) {
    const existing = groups.get(row.id);
    if (existing) existing.rows.push(row);
    else groups.set(row.id, { entityId: row.id, entityCode: row.entityCode, entityName: row.entityName, domainCode: row.domainCode, rows: [row] });
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.entityName.localeCompare(b.entityName));
}

function conflictKey(row: ConsensusConflict) {
  return `${row.id}:${row.attributeCode}:${row.sourceCode}`;
}

function ConflictTable({
  rows,
  limit,
  showEntity,
  showAttribute,
  onMore,
}: {
  rows: ConsensusConflict[];
  limit: number;
  showEntity?: boolean;
  showAttribute?: boolean;
  onMore: () => void;
}) {
  const columns = useMemo<ColDef[]>(() => {
    const defs: ColDef[] = [];
    if (showEntity) {
      defs.push({
        colId: 'entity',
        headerName: 'Entity',
        flex: 1.2,
        minWidth: 160,
        valueGetter: (params) => params.data?.entityName || '',
        cellRenderer: (params: any) => (
          <div>
            <Link href={entityHref(params.data.domainCode, params.data.id)}>{params.data.entityName}</Link>
            <div><Link href={`/resolve?entity=${params.data.id}`}>Resolve</Link></div>
          </div>
        ),
      });
    }
    if (showAttribute) {
      defs.push({ field: 'attributeName', headerName: 'Attribute', flex: 1.1, minWidth: 150 });
    }
    defs.push(
      { field: 'goldenSourceName', headerName: 'Golden source', minWidth: 140, flex: 1 },
      { colId: 'golden', headerName: 'Golden value', minWidth: 120, cellClass: 'dq-num', valueGetter: (params) => displayValue(params.data?.goldenValue) },
      { field: 'sourceName', headerName: 'Other source', minWidth: 140, flex: 1 },
      { colId: 'other', headerName: 'Other value', minWidth: 120, cellClass: 'dq-num', valueGetter: (params) => displayValue(params.data?.value) },
    );
    return defs;
  }, [showAttribute, showEntity]);
  return (
    <div className="dq-detail">
      <AppGrid
        rows={rows.slice(0, limit)}
        columns={columns}
        getRowId={(row) => conflictKey(row)}
        autoHeight
        autoRowHeight
        emptyMessage="No conflicts."
      />
      {rows.length > limit && (
        <button type="button" className="dq-more" onClick={onMore}>
          Show more ({rows.length - limit} remaining)
        </button>
      )}
    </div>
  );
}

function groupStaleByAttribute(rows: StaleAttribute[]) {
  const groups = new Map<string, { attributeCode: string; attributeName: string; rows: StaleAttribute[] }>();
  for (const row of rows) {
    const existing = groups.get(row.attributeCode);
    if (existing) existing.rows.push(row);
    else groups.set(row.attributeCode, { attributeCode: row.attributeCode, attributeName: row.attributeName, rows: [row] });
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || oldestAge(b.rows) - oldestAge(a.rows) || a.attributeName.localeCompare(b.attributeName));
}

function groupStaleByEntity(rows: StaleAttribute[]) {
  const groups = new Map<string, { entityId: string; entityCode: string; entityName: string; domainCode: string; rows: StaleAttribute[] }>();
  for (const row of rows) {
    const existing = groups.get(row.entityId);
    if (existing) existing.rows.push(row);
    else groups.set(row.entityId, { entityId: row.entityId, entityCode: row.entityCode, entityName: row.entityName, domainCode: row.domainCode, rows: [row] });
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || oldestAge(b.rows) - oldestAge(a.rows) || a.entityName.localeCompare(b.entityName));
}

function StaleTable({
  rows,
  limit,
  showEntity,
  showAttribute,
  entityHref: recordHref,
  onMore,
  onConfirmed,
}: {
  rows: StaleAttribute[];
  limit: number;
  showEntity?: boolean;
  showAttribute?: boolean;
  entityHref?: string;
  onMore: () => void;
  onConfirmed: () => void;
}) {
  const columns = useMemo<ColDef[]>(() => {
    const defs: ColDef[] = [];
    if (showEntity) {
      defs.push({
        colId: 'entity',
        headerName: 'Entity',
        flex: 1.3,
        minWidth: 180,
        valueGetter: (params) => params.data?.entityName || '',
        cellRenderer: (params: any) => (
          <div>
            <Link href={entityHref(params.data.domainCode, params.data.entityId)}>{params.data.entityName}</Link>
          </div>
        ),
      });
    }
    if (showAttribute) {
      defs.push({
        colId: 'attribute',
        headerName: 'Attribute',
        flex: 1.2,
        minWidth: 160,
        valueGetter: (params) => params.data?.attributeName || '',
        cellRenderer: (params: any) => <div>{params.data.attributeName}</div>,
      });
    }
    defs.push(
      { field: 'sourceName', headerName: 'Source', minWidth: 140, flex: 1 },
      { colId: 'value', headerName: 'Value', minWidth: 120, cellClass: 'dq-num', valueGetter: (params) => displayValue(params.data?.value) },
      {
        colId: 'received',
        headerName: 'Last received',
        minWidth: 170,
        valueGetter: (params) => formatReceipt(params.data?.receivedAt),
      },
      {
        colId: 'age',
        headerName: 'Age',
        width: 110,
        minWidth: 96,
        cellStyle: { color: 'var(--ink-3)' },
        valueGetter: (params) => (params.data ? `${params.data.ageDays}d ago` : ''),
        comparator: (_left, _right, nodeA, nodeB) => (nodeA?.data?.ageDays ?? 0) - (nodeB?.data?.ageDays ?? 0),
      },
      {
        colId: 'confirm',
        headerName: '',
        width: 150,
        sortable: false,
        filter: false,
        cellRenderer: (params: any) => <MarkReceivedButton entityId={params.data.entityId} attributeCode={params.data.attributeCode} onDone={onConfirmed} />,
      },
    );
    return defs;
  }, [onConfirmed, showAttribute, showEntity]);
  return (
    <div className="dq-detail">
      {recordHref && <div><Link href={recordHref}>Open entity</Link></div>}
      <AppGrid
        rows={rows.slice(0, limit)}
        columns={columns}
        getRowId={(row) => `${row.entityId}-${row.attributeCode}`}
        autoHeight
        getRowHeight={() => 48}
        emptyMessage="No stale values."
      />
      {rows.length > limit && (
        <button type="button" className="dq-more" onClick={onMore}>
          Show more ({rows.length - limit} remaining)
        </button>
      )}
    </div>
  );
}

function MarkReceivedButton({ entityId, attributeCode, onDone }: { entityId: string; attributeCode: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mark = async () => {
    setBusy(true);
    setError(null);
    const result = await graphqlMutation<{ confirmAttributeReceipt: { success: boolean; errors: Array<{ message: string }> } }>(
      `mutation ConfirmAttributeReceipt($entityId: ID!, $attributeCode: String!) {
        confirmAttributeReceipt(entityId: $entityId, attributeCode: $attributeCode) {
          success
          errors { message }
        }
      }`,
      { entityId, attributeCode },
    );
    const message = result.error?.message || result.data?.confirmAttributeReceipt?.errors?.[0]?.message;
    setBusy(false);
    if (message || !result.data?.confirmAttributeReceipt?.success) {
      setError(message || 'The receipt was not updated.');
      return;
    }
    onDone();
  };
  return (
    <div>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={mark}>
        {busy ? 'Saving…' : 'Mark received'}
      </button>
      {error && <div className="dq-sub">{error}</div>}
    </div>
  );
}

function DirectionArrow({ direction, label }: { direction: 'up' | 'down' | 'flat' | 'wait'; label: string }) {
  const turn = direction === 'down' ? 180 : direction === 'flat' ? 90 : 0;
  return (
    <span className={`dq-arrow ${direction}`} title={label} aria-label={label}>
      {direction === 'wait' ? (
        <span className="dq-arrow-wait">…</span>
      ) : (
        <svg viewBox="0 0 24 24" style={{ transform: `rotate(${turn}deg)` }} aria-hidden="true">
          <path d="M12 19V5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M6 11l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function DirectionMark({
  up,
  down,
  pending,
  upLabel,
  downLabel,
}: {
  up: number;
  down: number;
  pending: boolean;
  upLabel: string;
  downLabel: string;
}) {
  if (pending) return <DirectionArrow direction="wait" label="Comparing the prior date" />;
  if (up > down) return <DirectionArrow direction="up" label={`${up.toLocaleString()} ${upLabel}, ${down.toLocaleString()} ${downLabel}`} />;
  if (down > up) return <DirectionArrow direction="down" label={`${down.toLocaleString()} ${downLabel}, ${up.toLocaleString()} ${upLabel}`} />;
  return <DirectionArrow direction="flat" label={up || down ? `${up.toLocaleString()} ${upLabel}, ${down.toLocaleString()} ${downLabel}` : 'No change since the prior date'} />;
}

function ValueDirection({ changes }: { changes: Array<{ previousValue: string | null; currentValue: string | null }> }) {
  let up = 0;
  let down = 0;
  let other = 0;
  for (const change of changes) {
    const previous = Number(String(change.previousValue ?? '').replace(/,/g, ''));
    const current = Number(String(change.currentValue ?? '').replace(/,/g, ''));
    if (Number.isFinite(previous) && Number.isFinite(current) && previous !== current) {
      if (current > previous) up += 1;
      else down += 1;
    } else if ((change.previousValue || '') !== (change.currentValue || '')) {
      other += 1;
    }
  }
  if (up > down) return <DirectionArrow direction="up" label={`${up.toLocaleString()} increased, ${down.toLocaleString()} decreased`} />;
  if (down > up) return <DirectionArrow direction="down" label={`${down.toLocaleString()} decreased, ${up.toLocaleString()} increased`} />;
  if (up || down) return <DirectionArrow direction="flat" label={`${up.toLocaleString()} increased, ${down.toLocaleString()} decreased`} />;
  if (other) return <DirectionArrow direction="flat" label={`${other.toLocaleString()} values changed`} />;
  return <DirectionArrow direction="flat" label="No change" />;
}

function ShiftTables({
  resolved,
  introduced,
  fromDate,
  toDate,
  limit,
  onMore,
}: {
  resolved: MeasureShift[];
  introduced: MeasureShift[];
  fromDate: string;
  toDate: string;
  limit: number;
  onMore: () => void;
}) {
  if (resolved.length === 0 && introduced.length === 0) return null;
  const rows = [
    ...resolved.map((row) => ({ ...row, kind: 'Resolved' as const })),
    ...introduced.map((row) => ({ ...row, kind: 'Introduced' as const })),
  ];
  return (
    <div>
      <div className="dq-section-title">Since {formatDay(fromDate)}</div>
      <AppGrid
        rows={rows.slice(0, limit)}
        columns={[
          {
            field: 'kind',
            headerName: 'Movement',
            width: 140,
            cellStyle: (params) => ({ color: params.value === 'Resolved' ? 'var(--green)' : 'var(--amber)' }),
          },
          {
            colId: 'entity',
            headerName: 'Entity',
            flex: 1.3,
            minWidth: 180,
            valueGetter: (params) => params.data?.entityName || '',
            cellRenderer: (params: any) => (
              <div>
                <Link href={entityHref(params.data.domainCode, params.data.id)}>{params.data.entityName}</Link>
              </div>
            ),
          },
          { colId: 'from', headerName: formatDay(fromDate), minWidth: 140, cellClass: 'dq-num', valueGetter: (params) => displayValue(params.data?.previousValue) },
          { colId: 'to', headerName: formatDay(toDate), minWidth: 140, cellClass: 'dq-num', valueGetter: (params) => displayValue(params.data?.currentValue) },
        ]}
        getRowId={(row) => `${row.kind}-${row.id}`}
        autoHeight
        autoRowHeight
        emptyMessage="No movement."
      />
      {rows.length > limit && (
        <button type="button" className="dq-more" onClick={onMore}>
          Show more ({rows.length - limit} remaining)
        </button>
      )}
    </div>
  );
}

function handoffStatusLabel(match: OverrideMatch) {
  if (match.ready) return 'Ready';
  if (!match.prioritySourceCode) return 'No source';
  return 'Differs';
}

function handoffStatusClass(match: OverrideMatch) {
  if (match.ready) return 'dq-status-ready';
  if (!match.prioritySourceCode) return 'dq-status-quiet';
  return 'dq-status-differs';
}

function ExceptionScopeRadios({
  name,
  value,
  onChange,
}: {
  name: string;
  value: 'exceptions' | 'all';
  onChange: (next: 'exceptions' | 'all') => void;
}) {
  return (
    <div className="dq-seg" role="radiogroup" aria-label="Rows shown" data-name={name}>
      <button type="button" role="radio" aria-checked={value === 'exceptions'} className={value === 'exceptions' ? 'active' : ''} onClick={() => onChange('exceptions')}>Exceptions</button>
      <button type="button" role="radio" aria-checked={value === 'all'} className={value === 'all' ? 'active' : ''} onClick={() => onChange('all')}>All</button>
    </div>
  );
}

function HandoffScopeToggle({
  value,
  onChange,
}: {
  value: 'ready' | 'all';
  onChange: (next: 'ready' | 'all') => void;
}) {
  return (
    <div className="dq-seg" role="group" aria-label="Overrides shown">
      <button type="button" className={value === 'ready' ? 'active' : ''} onClick={() => onChange('ready')}>Ready for handoff</button>
      <button type="button" className={value === 'all' ? 'active' : ''} onClick={() => onChange('all')}>All overrides</button>
    </div>
  );
}

function HandoffMatch({
  match,
  open,
  asOf,
  showStatus,
  onToggle,
  onDone,
}: {
  match: OverrideMatch;
  open: boolean;
  asOf: string;
  showStatus: boolean;
  onToggle: () => void;
  onDone: () => void;
}) {
  return (
    <div className="dq-line">
      <div
        className={`dq-open dq-hand dq-hand-row ${showStatus ? 'dq-hand-all' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        {showStatus && <span className={handoffStatusClass(match)}>{handoffStatusLabel(match)}</span>}
        <span className="dq-name">
          <Link href={entityHref(match.domainCode, match.id)} onClick={(event) => event.stopPropagation()}>{match.entityName}</Link>
        </span>
        <span className="dq-name">
          {match.attributeName}
          {match.overrideReason && <span className="dq-sub">{match.overrideReason}</span>}
        </span>
        <span>
          {match.prioritySourceName || 'No other source'}
        </span>
        <span className="dq-num" title={displayValue(showStatus ? match.overrideValue : match.priorityValue)}>{displayValue(showStatus ? match.overrideValue : match.priorityValue)}</span>
        {showStatus && <span className="dq-num" title={displayValue(match.priorityValue)}>{displayValue(match.priorityValue)}</span>}
        <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          {match.ready && (
            <ClearOverrideButton
              entityId={match.id}
              attributeCode={match.attributeCode}
              asOf={asOf}
              onDone={onDone}
            />
          )}
        </span>
      </div>
      {open && (
        <div className="dq-detail">
          <HandoffSources
            entityId={match.id}
            attributeCode={match.attributeCode}
            asOf={asOf}
            prioritySourceCode={match.prioritySourceCode}
          />
        </div>
      )}
    </div>
  );
}

interface LineageSource {
  source: string;
  sourceName: string;
  value: string | null;
  precedenceRank: number;
  validFrom: string;
  validTo: string;
  confidenceScore: number | null;
}

function HandoffSources({
  entityId,
  attributeCode,
  asOf,
  prioritySourceCode,
}: {
  entityId: string;
  attributeCode: string;
  asOf: string;
  prioritySourceCode: string | null;
}) {
  const [rows, setRows] = useState<LineageSource[] | null>(null);
  const [rule, setRule] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    graphqlQuery<{
      fieldLineage: Array<{
        attributeCode: string;
        resolutionRule: string | null;
        competingValues: LineageSource[];
      }>;
    }>(FIELD_LINEAGE_QUERY, { entityId, asOfDate: asOf, knowledgeDate: null }, 'network-only')
      .then(({ data, error: queryError }) => {
        if (cancelled) return;
        if (queryError || !data?.fieldLineage) {
          setError(queryError?.message || 'Could not load source values.');
          setRows([]);
          return;
        }
        const field = data.fieldLineage.find((item) => item.attributeCode === attributeCode);
        const sources = [...(field?.competingValues || [])].sort((a, b) => a.precedenceRank - b.precedenceRank);
        setRule(field?.resolutionRule || null);
        setRows(sources);
      });
    return () => { cancelled = true; };
  }, [entityId, attributeCode, asOf]);

  if (error) return <div className="dq-empty">{error}</div>;
  if (!rows) return <div className="dq-empty">Loading source values…</div>;
  if (rows.length === 0) return <div className="dq-empty">No source values are stored for this attribute.</div>;

  return (
    <div className="sa-drilldown">
      {rule && <p className="dq-sub">{rule}</p>}
      <div className="sa-drill-table dq-source-table">
        <div className="sa-drill-thead">
          <div className="sa-drill-th" />
          <div className="sa-drill-th">Source</div>
          <div className="sa-drill-th">Value</div>
          <div className="sa-drill-th">Precedence</div>
          <div className="sa-drill-th">Valid from</div>
          <div className="sa-drill-th">Status</div>
        </div>
        {rows.map((row, index) => {
          const manual = row.source.toUpperCase() === 'MANUAL';
          const priority = prioritySourceCode != null && row.source.toUpperCase() === prioritySourceCode.toUpperCase();
          const hasValue = row.value != null && row.value !== '';
          return (
            <div key={`${row.source}-${index}`} className={`sa-drill-trow ${manual ? 'winner' : 'eligible'}`}>
              <div className="sa-drill-td sa-drill-row-num">{index + 1}</div>
              <div className="sa-drill-td">{row.sourceName || row.source}</div>
              <div className="sa-drill-td sa-drill-value">{hasValue ? displayValue(row.value) : '—'}</div>
              <div className="sa-drill-td">{row.precedenceRank}</div>
              <div className="sa-drill-td">{row.validFrom || '—'}</div>
              <div className="sa-drill-td sa-drill-status">
                {manual && <span className="sa-status-badge winner">Override</span>}
                {priority && <span className="sa-status-badge eligible">Priority source</span>}
                {!manual && !priority && hasValue && <span className="sa-status-badge no-data">Other source</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ClearOverrideButton({
  entityId,
  attributeCode,
  asOf,
  onDone,
}: {
  entityId: string;
  attributeCode: string;
  asOf: string;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function clear() {
    setBusy(true);
    setError(null);
    const { data, error: mutationError } = await graphqlMutation<{ clearManualOverride: { success: boolean; errors: Array<{ message: string }> } }>(
      CLEAR_MANUAL_OVERRIDE_MUTATION,
      { input: { entityId, attributeCode, asOf } }
    );
    const result = data?.clearManualOverride;
    if (mutationError || !result?.success) {
      setError(mutationError?.message || result?.errors?.[0]?.message || 'Could not clear the override.');
      setBusy(false);
      return;
    }
    setBusy(false);
    setConfirming(false);
    onDone();
  }

  return (
    <span className="dq-resolve">
      {confirming ? (
        <>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={clear}>{busy ? 'Clearing…' : 'Confirm clear'}</button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        </>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>Clear override</button>
      )}
      {error && <span className="dq-sub" style={{ color: 'var(--red)' }}>{error}</span>}
    </span>
  );
}

function severityRank(severity: string) {
  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const index = order.indexOf(severity.toUpperCase());
  return index === -1 ? order.length : index;
}

function isCritical(severity: string) {
  const key = severity.toUpperCase();
  return key === 'CRITICAL' || key === 'HIGH';
}

type QualityEntity = NonNullable<Dashboard['entities']>[number];

function ExceptionBoard({ entity, asOf, onDone }: { entity: QualityEntity; asOf: string; onDone: () => void }) {
  const [tab, setTab] = useState<'open' | 'resolved' | 'all'>('open');
  const openRules = [...entity.failingRules].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.ruleName.localeCompare(b.ruleName));
  const resolvedRules = entity.acceptedRules ?? [];
  const critical = openRules.filter((rule) => isCritical(rule.severity)).length;
  const warning = openRules.length - critical;
  const rows = tab === 'resolved' ? [] : openRules;
  const resolved = tab === 'open' ? [] : resolvedRules;

  return (
    <div className="ex-card">
      <div className="ex-head">
        <div>
          <div className="ex-title">{entity.entityName}</div>
        </div>
        <div className="ex-pills">
          <span className="ex-pill critical">{critical} critical</span>
          <span className="ex-pill warning">{warning} warning</span>
          <span className="ex-pill resolved">{resolvedRules.length} resolved</span>
        </div>
      </div>
      <div className="ex-tabs">
        <div className="dq-seg" role="group" aria-label="Exception status">
          <button type="button" className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>Needs action</button>
          <button type="button" className={tab === 'resolved' ? 'active' : ''} onClick={() => setTab('resolved')}>Resolved</button>
          <button type="button" className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>All</button>
        </div>
        <span className="dq-sub">Sorted by severity</span>
      </div>
      <div className="ex-grid ex-grid-head">
        <div>Rule</div>
        <div>Actual</div>
        <div>Corrected value</div>
      </div>
      {rows.length === 0 && resolved.length === 0 && (
        <div className="dq-empty">{tab === 'resolved' ? 'Nothing has been waived or marked as not an issue.' : 'Nothing needs action.'}</div>
      )}
      {rows.map((rule) => (
        <ExceptionRow
          key={rule.ruleId}
          entityId={entity.id}
          ruleId={rule.ruleId}
          ruleName={rule.ruleName}
          severity={rule.severity}
          attributeCode={rule.attributeCode}
          actualValue={rule.actualValue}
          asOf={asOf}
          onDone={onDone}
        />
      ))}
      {resolved.map((rule) => (
        <div className="ex-grid ex-row" key={rule.ruleId}>
          <div>
            <span className={`sev-dot ${isCritical(rule.severity) ? 'sev-high' : 'sev-med'}`} />
            <span className="ex-rule">{rule.ruleName}</span>
          </div>
          <div>
            <div className="dq-sub">{rule.status === 'FALSE_POSITIVE' ? 'Not an issue' : 'Waived'}</div>
            <div className="dq-sub">{rule.notes || '—'}</div>
          </div>
          <div>
            <button type="button" className="btn btn-sm" onClick={() => reopenRule(entity.id, rule.ruleId, asOf, onDone)}>Reopen</button>
          </div>
        </div>
      ))}
      <div className="ex-foot">Edits stay in the row until you save. Waive and Not an issue ask for a short reason and are kept with the exception.</div>
    </div>
  );
}

async function reopenRule(entityId: string, ruleId: string, asOf: string, onDone: () => void) {
  await graphqlMutation(
    `mutation RecordDQDisposition($input: RecordDQDispositionInput!) {
      recordDQDisposition(input: $input) { success errors { message } }
    }`,
    { input: { ruleId, entityId, status: 'OPEN', resolutionNotes: 'Reopened from the exception grid.', asOf } }
  );
  onDone();
}

function ExceptionRow({ entityId, ruleId, ruleName, severity, attributeCode, actualValue, asOf, href, onDone }: {
  entityId: string;
  ruleId: string;
  ruleName: string;
  severity: string;
  attributeCode: string | null;
  actualValue: string | null;
  asOf: string;
  href?: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState('');
  const [prompt, setPrompt] = useState<'WAIVED' | 'FALSE_POSITIVE' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    if (!attributeCode || !value.trim()) {
      setMessage('Enter a corrected value.');
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await graphqlMutation<{ submitManualOverride: { success: boolean; errors: Array<{ message: string }> } }>(
      `mutation CorrectQualityValue($input: ManualOverrideInput!) {
        submitManualOverride(input: $input) { success errors { message } }
      }`,
      {
        input: {
          entityId,
          attributeCode,
          value: value.trim(),
          validFrom: asOf,
          overrideReason: 'Corrected from the data quality review',
        },
      }
    );
    const error = result.error?.message || result.data?.submitManualOverride?.errors?.[0]?.message;
    setBusy(false);
    if (error || !result.data?.submitManualOverride?.success) {
      setMessage(error || 'The correction was not saved.');
      return;
    }
    onDone();
  };

  const confirm = async () => {
    if (!prompt) return;
    if (!note.trim()) {
      setMessage('Add a short reason.');
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await graphqlMutation<{ recordDQDisposition: { success: boolean; errors: Array<{ message: string }> } }>(
      `mutation RecordDQDisposition($input: RecordDQDispositionInput!) {
        recordDQDisposition(input: $input) { success errors { message } }
      }`,
      { input: { ruleId, entityId, status: prompt, resolutionNotes: note.trim(), asOf } }
    );
    const error = result.error?.message || result.data?.recordDQDisposition?.errors?.[0]?.message;
    setBusy(false);
    if (error || !result.data?.recordDQDisposition?.success) {
      setMessage(error || 'That decision was not saved.');
      return;
    }
    onDone();
  };

  return (
    <div className="ex-grid ex-row">
      <div>
        <span className={`sev-dot ${isCritical(severity) ? 'sev-high' : 'sev-med'}`} />
        {href ? <Link href={href} className="ex-rule">{ruleName}</Link> : <span className="ex-rule">{ruleName}</span>}
      </div>
      <div className="ex-actual">{displayValue(actualValue)}</div>
      <div className="ex-edit">
        {prompt ? (
          <>
            <input
              className="text-input"
              value={note}
              placeholder={prompt === 'WAIVED' ? 'Why waive this?' : 'Why is this not an issue?'}
              onChange={(event) => setNote(event.target.value)}
              aria-label="Reason"
            />
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={confirm}>Confirm</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setPrompt(null); setMessage(null); }}>Cancel</button>
          </>
        ) : (
          <>
            <AttributeValueInput
              attributeCode={attributeCode}
              className="text-input"
              value={value}
              placeholder="Enter a corrected value"
              onChange={setValue}
              ariaLabel={`Corrected value for ${ruleName}`}
            />
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setPrompt('WAIVED'); setMessage(null); }}>Waive</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setPrompt('FALSE_POSITIVE'); setMessage(null); }}>Not an issue</button>
          </>
        )}
        {message && <div className="dq-sub">{message}</div>}
      </div>
    </div>
  );
}

function AvailabilityDetail({ attributeCode, attributeName, domainCode, entityId, fromDate, toDate, knownAt, refreshToken, limit, onMore, onDone }: {
  attributeCode: string;
  attributeName: string;
  domainCode: string | null;
  entityId?: string;
  fromDate: string;
  toDate: string;
  knownAt: string | null;
  refreshToken: number;
  limit: number;
  onMore: () => void;
  onDone: () => void;
}) {
  const [detail, setDetail] = useState<AvailabilityDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    graphqlQuery<{ dqAvailabilityDetail: AvailabilityDetailData }>(
      DQ_AVAILABILITY_DETAIL_QUERY,
      { attributeCode, domainCode: domainCode || null, fromDate, toDate, knowledgeDate: knownAt, entityId: entityId || null },
      'network-only',
      controller.signal,
    ).then((result) => {
      if (result.aborted || controller.signal.aborted) return;
      if (result.error || !result.data?.dqAvailabilityDetail) {
        setError(qualityError(result.error?.message, 'Could not load the entities for this attribute.'));
        return;
      }
      setDetail(result.data.dqAvailabilityDetail);
    });
    return () => controller.abort();
  }, [attributeCode, domainCode, entityId, fromDate, toDate, knownAt, refreshToken]);

  if (error) return <div className="dq-detail"><div className="dq-error">{error}</div></div>;
  if (!detail) return <div className="dq-detail"><div className="dq-empty">Loading entities…</div></div>;
  return (
    <div className="dq-detail">
      {detail.missingEntities.length === 0 ? (
        <div className="dq-empty">Every entity that requires this attribute has a value.</div>
      ) : (
        <EntityTable
          rows={detail.missingEntities}
          limit={limit}
          attributeCode={attributeCode}
          attributeName={attributeName}
          asOf={toDate}
          onDone={onDone}
          onMore={onMore}
        />
      )}
      <ShiftTables
        resolved={detail.resolvedEntities}
        introduced={detail.introducedEntities}
        fromDate={fromDate}
        toDate={toDate}
        limit={limit}
        onMore={onMore}
      />
    </div>
  );
}

function EntityTable({ rows, limit, attributeCode, attributeName, asOf, onDone, onMore }: {
  rows: EntityRef[];
  limit: number;
  attributeCode: string;
  attributeName: string;
  asOf: string;
  onDone: () => void;
  onMore: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkValue, setBulkValue] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const matching = needle ? rows.filter((entity) => entity.entityName.toLowerCase().includes(needle)) : rows;
  const shown = matching.slice(0, limit);
  const selectedMatching = matching.filter((entity) => selected.has(entity.id));
  const allSelected = matching.length > 0 && selectedMatching.length === matching.length;

  const toggleOne = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const entity of matching) {
        if (allSelected) next.delete(entity.id);
        else next.add(entity.id);
      }
      return next;
    });
  };

  const saveSelected = async () => {
    const value = bulkValue.trim();
    if (!value) {
      setBulkMessage('Choose a value to apply.');
      return;
    }
    const targets = selectedMatching;
    if (targets.length === 0) return;
    setBulkBusy(true);
    setBulkMessage(null);
    const outcomes = await Promise.all(targets.map(async (entity) => {
      const result = await graphqlMutation<{ submitManualOverride: { success: boolean; errors: Array<{ message: string }> } }>(
        `mutation CorrectQualityValue($input: ManualOverrideInput!) {
          submitManualOverride(input: $input) { success errors { message } }
        }`,
        {
          input: {
            entityId: entity.id,
            attributeCode,
            value,
            validFrom: asOf,
            overrideReason: 'Corrected from the data quality review',
          },
        }
      );
      const error = result.error?.message || result.data?.submitManualOverride?.errors?.[0]?.message;
      return { id: entity.id, ok: !error && Boolean(result.data?.submitManualOverride?.success), error };
    }));
    setBulkBusy(false);
    const failed = outcomes.filter((outcome) => !outcome.ok);
    setSelected(new Set(failed.map((outcome) => outcome.id)));
    if (failed.length > 0) {
      setBulkMessage(`${outcomes.length - failed.length} saved, ${failed.length} failed: ${failed[0].error || 'not saved'}`);
    } else {
      setBulkValue('');
    }
    onDone();
  };

  return (
    <>
      <div className="dq-bulk">
        <input
          className="text-input"
          placeholder={`Search ${rows.length.toLocaleString()} entities`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search entities"
        />
        <label className="dq-bulk-all">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={matching.length === 0} />
          Select all{needle ? ' matching' : ''} ({matching.length.toLocaleString()})
        </label>
        {selectedMatching.length > 0 && (
          <div className="dq-bulk-apply">
            <AttributeValueInput
              attributeCode={attributeCode}
              className="select"
              value={bulkValue}
              onChange={setBulkValue}
              ariaLabel={`Set ${attributeName} for selected`}
            />
            <button type="button" className="btn btn-sm btn-primary" disabled={bulkBusy || !bulkValue.trim()} onClick={saveSelected}>
              {bulkBusy ? 'Saving…' : `Save ${selectedMatching.length.toLocaleString()} correction${selectedMatching.length === 1 ? '' : 's'}`}
            </button>
          </div>
        )}
        {bulkMessage && <span className="dq-sub">{bulkMessage}</span>}
      </div>
      {matching.length === 0 && <div className="dq-empty">No entities match that search.</div>}
      {shown.length > 0 && (
        <div className="dq-fix-row dq-fix-head" aria-hidden="true">
          <span />
          <span>Entity</span>
          <span>{attributeName}</span>
        </div>
      )}
      {shown.map((entity) => (
        <div className="dq-fix-row" key={entity.id}>
          <input type="checkbox" checked={selected.has(entity.id)} onChange={() => toggleOne(entity.id)} aria-label={`Select ${entity.entityName}`} />
          <span className="dq-fix-name">
            <Link href={entityHref(entity.domainCode, entity.id)}>{entity.entityName}</Link>
            <span className="dq-sub">Required and blank</span>
          </span>
          <ResolveForm
            entityId={entity.id}
            attributeCode={attributeCode}
            attributeName={attributeName}
            actualValue=""
            asOf={asOf}
            onDone={onDone}
          />
        </div>
      ))}
      {matching.length > shown.length && (
        <button type="button" className="dq-more" onClick={onMore}>Show more ({matching.length - shown.length} remaining)</button>
      )}
    </>
  );
}

function ResolveForm({ entityId, ruleId, attributeCode, attributeName, actualValue, asOf, reopenOnly, onDone }: {
  entityId: string;
  ruleId?: string;
  attributeCode: string | null;
  attributeName: string | null;
  actualValue: string | null;
  asOf: string;
  reopenOnly?: boolean;
  onDone: () => void;
}) {
  const [value, setValue] = useState(actualValue || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const correct = async () => {
    if (!attributeCode) return;
    setBusy('save');
    setMessage(null);
    const result = await graphqlMutation<{ submitManualOverride: { success: boolean; errors: Array<{ message: string }> } }>(
      `mutation CorrectQualityValue($input: ManualOverrideInput!) {
        submitManualOverride(input: $input) { success errors { message } }
      }`,
      {
        input: {
          entityId,
          attributeCode,
          value,
          validFrom: asOf,
          overrideReason: 'Corrected from the data quality review',
        },
      }
    );
    const error = result.error?.message || result.data?.submitManualOverride?.errors?.[0]?.message;
    setBusy(null);
    if (error || !result.data?.submitManualOverride?.success) {
      setMessage(error || 'The correction was not saved.');
      return;
    }
    onDone();
  };

  const dispose = async (status: 'WAIVED' | 'FALSE_POSITIVE' | 'OPEN') => {
    if (!ruleId) return;
    if (status !== 'OPEN' && !note.trim()) {
      setMessage('Add a short note so the next person knows why this was accepted.');
      return;
    }
    setBusy(status);
    setMessage(null);
    const result = await graphqlMutation<{ recordDQDisposition: { success: boolean; errors: Array<{ message: string }> } }>(
      `mutation RecordDQDisposition($input: RecordDQDispositionInput!) {
        recordDQDisposition(input: $input) { success errors { message } }
      }`,
      { input: { ruleId, entityId, status, resolutionNotes: note.trim() || null, asOf } }
    );
    const error = result.error?.message || result.data?.recordDQDisposition?.errors?.[0]?.message;
    setBusy(null);
    if (error || !result.data?.recordDQDisposition?.success) {
      setMessage(error || 'That decision was not saved.');
      return;
    }
    onDone();
  };

  if (reopenOnly) {
    return (
      <div className="dq-resolve">
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => dispose('OPEN')}>Reopen</button>
        {message && <span className="dq-sub">{message}</span>}
      </div>
    );
  }

  return (
    <div className="dq-resolve">
      {attributeCode && (
        <label>
          <AttributeValueInput
            attributeCode={attributeCode}
            className="select"
            value={value}
            onChange={setValue}
            ariaLabel={`Corrected ${attributeName || attributeCode}`}
          />
        </label>
      )}
      <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null || !attributeCode} onClick={correct}>
        {busy === 'save' ? 'Saving…' : 'Save correction'}
      </button>
      {ruleId && (
        <>
          <label>
            Note
            <input className="text-input" value={note} placeholder="Why this is acceptable" onChange={(event) => setNote(event.target.value)} />
          </label>
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => dispose('WAIVED')}>Waive</button>
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => dispose('FALSE_POSITIVE')}>Not an issue</button>
        </>
      )}
      {message && <span className="dq-sub">{message}</span>}
    </div>
  );
}

function trajectoryChangeColumns(fromDate: string, toDate: string): ColDef[] {
  return [
    {
      colId: 'entity',
      headerName: 'Entity',
      flex: 1.3,
      minWidth: 180,
      cellRenderer: (params: any) => (
        <div>
          <Link href={entityHref(params.data.domainCode, params.data.id)}>{params.data.entityName}</Link>
        </div>
      ),
    },
    { colId: 'from', headerName: formatDay(fromDate), minWidth: 130, cellClass: 'dq-num', valueGetter: (params) => displayValue(params.data?.previousValue) },
    { colId: 'to', headerName: formatDay(toDate), minWidth: 130, cellClass: 'dq-num', valueGetter: (params) => displayValue(params.data?.currentValue) },
    { colId: 'direction', headerName: '', width: 90, sortable: false, filter: false, cellRenderer: (params: any) => <ValueDirection changes={[params.data]} /> },
  ];
}

function entityChangeColumns(fromDate: string, toDate: string): ColDef[] {
  return [
    { field: 'attributeName', headerName: 'Attribute', flex: 1, minWidth: 160 },
    { colId: 'from', headerName: formatDay(fromDate), minWidth: 130, cellClass: 'dq-num', valueGetter: (params) => displayValue(params.data?.previousValue) },
    { colId: 'to', headerName: formatDay(toDate), minWidth: 130, cellClass: 'dq-num', valueGetter: (params) => displayValue(params.data?.currentValue) },
    { colId: 'direction', headerName: '', width: 90, sortable: false, filter: false, cellRenderer: (params: any) => <ValueDirection changes={[params.data]} /> },
  ];
}
