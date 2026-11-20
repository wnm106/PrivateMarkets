'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EntityData } from './types';
import { SourceAttributedFieldRow, type FieldData } from './SourceAttributedFieldRow';
import { type SourceKey } from '@/lib/data';
import { useTemporalStore } from '@/lib/store';
import { ATTRIBUTE_SECTIONS_QUERY, INTERSECTION_TYPES_QUERY, RELATIONSHIP_TYPES_QUERY, graphqlQuery } from '@/lib/graphql';
import { EntityReports } from '@/components/reporting/EntityReports';
import { DataQualityDashboard } from '@/components/quality/DataQualityDashboard';
import { RelationshipEntityGrids } from './RelationshipEntityGrids';
import { RecordTemplateChoices } from './RecordTemplateChoices';
import { RecordDocuments } from '@/components/documents/RecordDocuments';
import { classifyRecordRelationships, singularRelatedRefs } from '@/lib/relationship-grids';
import { definingParentDomains, toParentLinkCounts, type ParentLinkCount, type ParentRelationshipType } from '@/lib/parent-entities';
import { supabaseBrowserClient } from '@/lib/supabase-browser';
import { attributeSectionLinks, fieldsForVisibility, groupForDisplay, type AttributeSectionOrder, type FieldVisibility } from '@/lib/attribute-layout';
import { decompileCalcExpression } from '@/lib/calc-expression';
import { usePublishTabs, useWarmTabs } from '@/lib/view-context';
import { RecordValuesProvider } from '@/components/forms/RecordValues';

export interface TemplateAttribute {
  attributeCode: string;
  attributeName: string;
  required: boolean;
  displaySection: string;
  sortOrder: number;
  spanColumns?: number | null;
  spanRows?: number | null;
  dataType?: string;
  isDerived?: boolean;
  derivationFormula?: string | null;
  isEditable?: boolean;
}

export interface LineageData {
  attributeCode: string;
  attributeName: string;
  currentValue: string;
  competingValues: Array<{
    source: string;
    sourceName: string;
    value: string;
    precedenceRank: number;
    validFrom: string;
    validTo: string;
    confidenceScore: number | null;
    receivedAt?: string | null;
  }>;
  resolutionRule: string;
  lastUpdated: string | null;
}

interface GoldenRecordSectionsProps {
  entity: EntityData;
  templateAttributes?: TemplateAttribute[];
  lineageData?: LineageData[];
  onAddAttribute?: (attributeCode: string, value: string, source: SourceKey) => void;
  onSourceChange?: (attributeCode: string, newSource: SourceKey) => void;
  onValueChange?: (attributeCode: string, newValue: string) => void;
  /** Saves several fields in one change, such as the levels above a picked GICS value. */
  onValuesChange?: (changes: Record<string, string>) => void | Promise<void>;
  onAddSourceValue?: (attributeCode: string, source: SourceKey, value: string) => void;
  onDeleteSourceValue?: (attributeCode: string, sourceCode: string) => void;
  asOfDate?: string;
  lineageLoaded?: boolean;
  /** Reads the record's values again, after a version is deleted from a timeline. */
  onReload?: () => void | Promise<void>;
}

function formulaLabel(formula: string | null | undefined): string {
  if (!formula) return 'Calculated';
  const shown = decompileCalcExpression(formula.replace(/^CALC_SPEC:/, ''));
  return shown || 'Calculated';
}

const DERIVED_ATTRIBUTE_QUERY = `
  query DerivedAttributes($domainCode: String!) {
    attributeRegister(domainCode: $domainCode) {
      attributeCode
      isDerived
      derivationFormula
    }
  }
`;

export function GoldenRecordSections({
  entity,
  templateAttributes = [],
  lineageData = [],
  onAddAttribute,
  onSourceChange,
  onValueChange,
  onValuesChange,
  onAddSourceValue,
  onDeleteSourceValue,
  asOfDate,
  lineageLoaded = false,
  onReload,
}: GoldenRecordSectionsProps) {
  const calcRefreshKey = lineageData
    .map((row) => `${row.attributeCode}:${row.currentValue ?? ''}:${row.lastUpdated ?? ''}`)
    .join('|');
  const [tab, setTab] = useState<'attributes' | 'dashboards' | 'quality' | 'relationships' | 'documents'>('attributes');
  const [relationshipCatalog, setRelationshipCatalog] = useState<{
    types: ParentRelationshipType[];
    linkCounts: ParentLinkCount[];
    parentDomains: string[];
  } | null>(null);
  const [derivedFormulas, setDerivedFormulas] = useState<Record<string, string>>({});
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const domainCode = entity.domainCode || '';
  const [sectionState, setSectionState] = useState<{ domainCode: string; sections: AttributeSectionOrder[] | null }>({
    domainCode,
    sections: domainCode ? null : [],
  });
  if (sectionState.domainCode !== domainCode) {
    setSectionState({ domainCode, sections: domainCode ? null : [] });
  }
  const sections = sectionState.domainCode === domainCode ? sectionState.sections : null;

  useEffect(() => {
    const domainCode = entity.domainCode;
    if (!domainCode) return;
    let cancelled = false;
    graphqlQuery<
      { attributeRegister: Array<{ attributeCode: string; isDerived?: boolean; derivationFormula?: string | null }> },
      { domainCode: string }
    >(DERIVED_ATTRIBUTE_QUERY, { domainCode }, 'network-only').then((result) => {
      if (cancelled) return;
      const formulas: Record<string, string> = {};
      for (const attribute of result.data?.attributeRegister || []) {
        if (!attribute.isDerived && !attribute.derivationFormula) continue;
        formulas[attribute.attributeCode] = formulaLabel(attribute.derivationFormula);
      }
      setDerivedFormulas(formulas);
    });
    return () => { cancelled = true; };
  }, [entity.domainCode]);

  useEffect(() => {
    if (!domainCode) return;
    let cancelled = false;
    graphqlQuery<{ attributeSections: AttributeSectionOrder[] }, { domainCode: string }>(
      ATTRIBUTE_SECTIONS_QUERY,
      { domainCode },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      const next = result.data?.attributeSections || [];
      setSectionState((current) => (current.domainCode === domainCode ? { domainCode, sections: next } : current));
    }).catch(() => {
      if (cancelled) return;
      setSectionState((current) => (current.domainCode === domainCode ? { domainCode, sections: [] } : current));
    });
    return () => { cancelled = true; };
  }, [domainCode]);

  useEffect(() => {
    let cancelled = false;
    setRelationshipCatalog(null);
    Promise.all([
      graphqlQuery<{ relationshipTypes: ParentRelationshipType[] }, Record<string, never>>(
        RELATIONSHIP_TYPES_QUERY,
        {},
        'network-only',
      ),
      graphqlQuery<
        { intersectionTypes: Array<{ intersectionCode: string; isActive: boolean; members: Array<{ domainCode: string }> }> },
        Record<string, never>
      >(INTERSECTION_TYPES_QUERY, {}, 'network-only'),
      supabaseBrowserClient().rpc('relationship_link_counts'),
    ]).then(([relationships, intersections, counts]) => {
      if (cancelled) return;
      setRelationshipCatalog({
        types: relationships.data?.relationshipTypes || [],
        linkCounts: counts.error ? [] : toParentLinkCounts((counts.data || []) as Array<Record<string, unknown>>),
        parentDomains: definingParentDomains(entity.domainCode, intersections.data?.intersectionTypes || []),
      });
    }).catch(() => {
      if (!cancelled) setRelationshipCatalog({ types: [], linkCounts: [], parentDomains: [] });
    });
    return () => { cancelled = true; };
  }, [entity.domainCode]);

  const attributes = entity.attributes || {};
  const assignedCodes = new Set(templateAttributes.map((attribute) => attribute.attributeCode));
  // Stored values can exist for attributes owned by another entity type. Once the
  // assignment catalog is loaded, only show attributes assigned to this entity.
  const attributeEntries = Object.entries(attributes).filter(([key]) =>
    assignedCodes.size === 0 || assignedCodes.has(key)
  );
  const populatedEntries = attributeEntries.filter(([, attr]) => hasStoredValue(attr));
  const temporalEntries = lineageData
    .filter((lineage) => hasStoredValue(lineage.currentValue))
    .filter((lineage) => assignedCodes.size === 0 || assignedCodes.has(lineage.attributeCode))
    .map((lineage) => [lineage.attributeCode, { value: lineage.currentValue }] as [string, { value: string }]);
  const displayEntries = lineageLoaded ? temporalEntries : populatedEntries;
  const lineageMap = new Map<string, LineageData>();
  lineageData.forEach((ld) => lineageMap.set(ld.attributeCode, ld));

  // What each field shows, so dependent fields can read the field above them.
  const recordValues: Record<string, string> = {};
  for (const [code, stored] of Object.entries(attributes)) {
    const raw = stored && typeof stored === 'object' && 'value' in stored ? (stored as { value: unknown }).value : stored;
    if (!lineageLoaded && hasStoredValue(raw)) recordValues[code] = String(raw);
  }
  for (const lineage of lineageData) {
    if (hasStoredValue(lineage.currentValue)) recordValues[lineage.attributeCode] = String(lineage.currentValue);
  }

  const listedAttributes: TemplateAttribute[] = [];
  const listedCodes = new Set<string>();
  for (const attribute of templateAttributes) {
    listedCodes.add(attribute.attributeCode);
    listedAttributes.push(attribute);
  }
  for (const [key] of attributeEntries) {
    if (listedCodes.has(key)) continue;
    listedAttributes.push({
      attributeCode: key,
      attributeName: lineageMap.get(key)?.attributeName || key,
      required: false,
      displaySection: 'General',
      sortOrder: 10000,
    });
  }

  const handleSourceChange = (labelOrCode: string, newSrc: SourceKey) => {
    // The SourceAttributedFieldRow passes attributeCode if available, otherwise label
    // We need to pass the attribute code to the parent for proper identification
    onSourceChange?.(labelOrCode, newSrc);
  };

  const handleDrilldown = (_label: string) => {
    // Inline drilldown is handled by SourceAttributedFieldRow
  };

  const parentRelationships = entity.parentRelationships || [];
  const childRelationships = entity.childRelationships || [];
  const related = classifyRecordRelationships(
    entity.domainCode,
    parentRelationships.map((rel) => ({
      entityId: rel.parentEntityId,
      domainCode: rel.parentDomainCode,
      relationshipCode: rel.relationshipCode,
      members: rel.members,
    })),
    childRelationships.map((rel) => ({
      entityId: rel.childEntityId,
      domainCode: rel.childDomainCode,
      relationshipCode: rel.relationshipCode,
      members: rel.members,
    })),
  );
  const shown = relationshipCatalog
    ? {
        parents: singularRelatedRefs(entity.domainCode, related.parents, relationshipCatalog.types, relationshipCatalog.linkCounts, relationshipCatalog.parentDomains),
        children: singularRelatedRefs(entity.domainCode, related.children, relationshipCatalog.types, relationshipCatalog.linkCounts, relationshipCatalog.parentDomains),
      }
    : null;
  const relationshipCount = shown ? shown.parents.length + shown.children.length : null;

  // The assistant sees every tab of the record, not only the open one. Documents,
  // dashboards and data quality are mounted hidden below and publish themselves.
  const warmed = useWarmTabs(['documents', 'dashboards', 'quality'], tab);
  const shownIds = shown ? new Set([...shown.parents, ...shown.children].map((ref) => ref.entityId)) : null;
  usePublishTabs({
    attributes: {
      label: 'Attributes',
      purpose: `The ${entity.domainCode || 'record'}'s attribute values as of the selected dates, with the source that supplied each.`,
      howToRead: 'A blank value means nothing was known at the selected As Of and Knowledge dates. calculated attributes are derived from others and cannot be edited. source is the system the prevailing value came from.',
      data: lineageLoaded || displayEntries.length > 0 ? {
        record: entity.entityName,
        code: entity.entityCode,
        count: displayEntries.length,
        attributes: listedAttributes.slice(0, 200).map((attribute) => {
          const lineage = lineageMap.get(attribute.attributeCode);
          const stored = attributes[attribute.attributeCode];
          const storedValue = stored && typeof stored === 'object' && 'value' in stored ? stored.value : stored;
          const value = lineageLoaded ? lineage?.currentValue : (lineage?.currentValue ?? storedValue);
          return {
            name: attribute.attributeName || attribute.attributeCode,
            section: attribute.displaySection || 'General',
            value: hasStoredValue(value) ? String(value) : null,
            required: attribute.required,
            calculated: Boolean(derivedFormulas[attribute.attributeCode] || attribute.isDerived),
            source: lineage?.competingValues?.find((item) => item.value === lineage.currentValue)?.sourceName || null,
          };
        }).filter((row) => row.value !== null || row.required),
      } : null,
    },
    relationships: {
      label: 'Relationships',
      purpose: `The records this ${entity.domainCode || 'record'} is linked to, above it (parents) and below it (children).`,
      howToRead: 'parents are records this one belongs to or depends on; children are records that belong to it. Only the relationships this record type uses are listed.',
      data: shownIds ? {
        parents: (entity.parentRelationships || []).filter((rel) => shownIds.has(rel.parentEntityId)).slice(0, 100).map((rel) => ({
          relationship: rel.relationshipType, domain: rel.parentDomainCode, name: rel.parentEntityName, code: rel.parentEntityCode, primary: rel.isPrimary,
        })),
        children: (entity.childRelationships || []).filter((rel) => shownIds.has(rel.childEntityId)).slice(0, 100).map((rel) => ({
          relationship: rel.relationshipType, domain: rel.childDomainCode, name: rel.childEntityName, code: rel.childEntityCode, primary: rel.isPrimary,
        })),
      } : null,
    },
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: '4px', borderBottom: '2px solid var(--line)', marginBottom: '16px' }}>
        <SectionTab
          label={`Attributes (${displayEntries.length})`}
          active={tab === 'attributes'}
          onClick={() => setTab('attributes')}
        />
        <SectionTab
          label="Dashboards"
          active={tab === 'dashboards'}
          onClick={() => setTab('dashboards')}
        />
        <SectionTab
          label="Data quality"
          active={tab === 'quality'}
          onClick={() => setTab('quality')}
        />
        <SectionTab
          label={relationshipCount == null ? 'Relationships' : `Relationships (${relationshipCount})`}
          active={tab === 'relationships'}
          onClick={() => setTab('relationships')}
        />
        <SectionTab
          label="Documents"
          active={tab === 'documents'}
          onClick={() => setTab('documents')}
        />
      </div>

      {warmed.has('documents') && (
        <div hidden={tab !== 'documents'}>
          <RecordDocuments entityId={entity.id} entityName={entity.entityName} />
        </div>
      )}
      {warmed.has('dashboards') && (
        <div hidden={tab !== 'dashboards'}>
          <EntityReports domainCode={entity.domainCode} entityId={entity.id} asOfDate={asOfDate} embedded />
        </div>
      )}
      {warmed.has('quality') && (
        <div hidden={tab !== 'quality'}>
          <DataQualityDashboard embedded active={tab === 'quality'} domainCode={entity.domainCode} entityId={entity.id} />
        </div>
      )}
      {tab === 'documents' || tab === 'dashboards' || tab === 'quality' ? null : tab === 'relationships' ? (
        !shown ? (
          <div className="field-section" aria-busy="true">
            <div style={{ padding: '16px 20px', color: 'var(--ink-3)', fontSize: '13px' }}>Loading…</div>
          </div>
        ) : (
          <>
            <RecordTemplateChoices entityId={entity.id} asOfDate={asOfDate} />
            <RelationshipEntityGrids
              entityId={entity.id}
              asOfDate={asOfDate}
              parents={shown.parents}
              children={shown.children}
            />
          </>
        )
      ) : !sections ? (
        <div className="field-section" aria-busy="true">
          <div style={{ padding: '16px 20px', color: 'var(--ink-3)', fontSize: '13px' }}>
            Loading…
          </div>
        </div>
      ) : (
        <RecordValuesProvider values={recordValues} saveMany={onValuesChange} reload={onReload}>
        <AttributeSections
          sections={sections}
          items={listedAttributes.map((templateAttr) => {
          const key = templateAttr.attributeCode;
          const lineage = lineageMap.get(key);
          const stored = attributes[key];
          const attrValue = stored && typeof stored === 'object' && 'value' in stored ? stored.value : stored;
          const attrSource = stored && typeof stored === 'object'
            ? ((stored as any).source_code || (stored as any).source || '')
            : '';

          // Lineage is what was true at this as-of and knowledge time. A missing row is a
          // blank. Do not fill it from the value that is open on the record today.
          const resolvedValue = lineageLoaded ? lineage?.currentValue : (lineage?.currentValue ?? attrValue);
          const hasValue = resolvedValue !== null && resolvedValue !== undefined && resolvedValue !== '' && resolvedValue !== '—';
          const resolvedSource = hasValue
            ? (lineage?.competingValues?.find(cv => cv.value === lineage.currentValue)?.source ?? attrSource)
            : '';

          // Resolve display label from template attributes, fall back to attribute code
          const displayLabel = templateAttr.attributeName || key;
          const formula = derivedFormulas[key] || (templateAttr?.isDerived ? formulaLabel(templateAttr.derivationFormula) : undefined);
          const calculated = Boolean(formula);

          // The formula mark stays on the row. The pill names the source that
          // actually supplied the number, including a feed stored on a calculated attribute.
          const normalizedSource = !hasValue
            ? ''
            : (typeof resolvedSource === 'string' && resolvedSource
              ? resolvedSource.toLowerCase()
              : (calculated ? 'calculated' : ''));
          const storedSourceName = (
            lineage?.competingValues?.find((cv) => cv.value === lineage.currentValue)
            || lineage?.competingValues?.find((cv) => String(cv.source).toLowerCase() === String(resolvedSource).toLowerCase())
          )?.sourceName;

          const fieldData: FieldData = {
            label: displayLabel,
            attributeCode: key,
            dataType: templateAttr?.dataType,
            value: resolvedValue !== null && resolvedValue !== undefined && resolvedValue !== '' ? String(resolvedValue) : '—',
            source: normalizedSource,
            calculated,
            formula,
            storedSourceName,
            precedenceRank: lineage?.competingValues?.find(cv => {
              const normCv = typeof cv.source === 'string' ? cv.source.toLowerCase() : 'manual';
              return normCv === normalizedSource;
            })?.precedenceRank,
            receivedAt: lineage?.competingValues?.find(cv => {
              const normCv = typeof cv.source === 'string' ? cv.source.toLowerCase() : 'manual';
              return normCv === normalizedSource;
            })?.receivedAt,
            competingValues: lineage
              ? (lineage.competingValues || []).map(cv => {
                const normalizedCvSource = (typeof cv.source === 'string' ? cv.source.toLowerCase() : 'manual');
                return {
                  source: normalizedCvSource,
                  sourceName: cv.sourceName,
                  value: cv.value,
                  precedenceRank: cv.precedenceRank,
                  validFrom: cv.validFrom,
                  validTo: cv.validTo,
                  confidenceScore: cv.confidenceScore,
                  receivedAt: cv.receivedAt,
                };
              })
              : (lineageLoaded ? [] : undefined),
            resolutionRule: formula || lineage?.resolutionRule,
            editable: templateAttr.isEditable !== false,
          };

          return {
            key,
            section: templateAttr.displaySection || 'General',
            sortOrder: templateAttr.sortOrder ?? 0,
            name: displayLabel,
            populated: hasValue,
            required: templateAttr.required === true,
            node: (
              <SourceAttributedFieldRow
                field={fieldData}
                required={templateAttr.required === true}
                onDrilldown={handleDrilldown}
                onSourceChange={handleSourceChange}
                onValueChange={onValueChange}
                onAddSourceValue={onAddSourceValue}
                onDeleteSourceValue={onDeleteSourceValue}
                asOfDate={asOfDate}
                knowledgeDate={knowledgeDate}
                entityId={entity.id}
                calcRefreshKey={calcRefreshKey}
              />
            ),
          };
        })}
        />
        </RecordValuesProvider>
      )}
    </div>
  );
}

function scrollParent(node: HTMLElement): HTMLElement | Window {
  let parent = node.parentElement;
  while (parent) {
    const overflow = getComputedStyle(parent).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && parent.scrollHeight > parent.clientHeight + 1) return parent;
    parent = parent.parentElement;
  }
  return window;
}

interface AttributeDisplayNode {
  key: string;
  section: string;
  sortOrder: number;
  name: string;
  populated: boolean;
  required: boolean;
  node: ReactNode;
}

const FIELD_VISIBILITY: Array<{ value: FieldVisibility; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'required', label: 'Required' },
  { value: 'populated', label: 'Populated' },
  { value: 'missing', label: 'Missing' },
];

function AttributeSections({
  sections,
  items,
}: {
  sections: AttributeSectionOrder[];
  items: AttributeDisplayNode[];
}) {
  const [visibility, setVisibility] = useState<FieldVisibility>('all');
  const shown = fieldsForVisibility(items, visibility);
  const groups = groupForDisplay(shown, sections);
  const links = attributeSectionLinks(groups.map((group) => group.section));
  const sectionNav = links;
  const sectionNavKey = sectionNav.map((item) => encodeURIComponent(item.id)).join('\n');
  const [activeSection, setActiveSection] = useState('');
  const jumpLock = useRef(0);
  const active = sectionNav.some((item) => item.id === activeSection) ? activeSection : (sectionNav[0]?.id || '');
  const showNav = sectionNav.length > 1;
  const populatedCount = items.filter((item) => item.populated).length;
  const visibilityCount: Record<FieldVisibility, number> = {
    all: items.length,
    required: items.filter((item) => item.required).length,
    populated: populatedCount,
    missing: items.length - populatedCount,
  };

  useEffect(() => {
    const ids = sectionNavKey ? sectionNavKey.split('\n').map((id) => decodeURIComponent(id)) : [];
    const nodes = ids
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => Boolean(node));
    if (!nodes.length) return undefined;
    const scroller = scrollParent(nodes[0]);
    const update = () => {
      if (performance.now() < jumpLock.current) return;
      const edge = scroller instanceof HTMLElement ? scroller.getBoundingClientRect().top : 0;
      const line = edge + 24;
      let current = nodes[0];
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= line) current = node;
      }
      let atBottom = false;
      if (scroller instanceof HTMLElement && scroller.scrollHeight > scroller.clientHeight + 1) {
        atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      }
      setActiveSection((atBottom ? nodes[nodes.length - 1] : current).id);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, [sectionNavKey]);

  const jump = (id: string) => {
    jumpLock.current = performance.now() + 800;
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const emptyLabel = items.length === 0
    ? 'No attribute values yet.'
    : visibility === 'required'
      ? 'No required fields on this record type.'
      : visibility === 'populated'
        ? 'No populated fields.'
        : 'No missing fields.';

  const filter = (
    <div className="attr-field-filter">
      <div className="rb-seg small" role="radiogroup" aria-label="Which fields to show">
        {FIELD_VISIBILITY.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={visibility === option.value}
            className={visibility === option.value ? 'on' : ''}
            onClick={() => setVisibility(option.value)}
          >
            {option.label}
            <span className="attr-field-filter-count">{visibilityCount[option.value]}</span>
          </button>
        ))}
      </div>
    </div>
  );

  const body = (
    <>
      {shown.length === 0 && (
        <div className="field-section">
          <div style={{ padding: '16px 20px', color: 'var(--ink-3)', fontSize: '13px' }}>
            {emptyLabel}
          </div>
        </div>
      )}
      {groups.map((group, index) => (
        <div className="field-section" id={links[index]?.id} key={links[index]?.id || group.section}>
          <div className="field-section-head">
            <div className="field-section-name">{group.section}</div>
            <div className="field-section-count">{group.items.length}</div>
          </div>
          {group.items.map((item) => (
            <div key={item.key}>{item.node}</div>
          ))}
        </div>
      ))}
    </>
  );

  const sectionsView = showNav ? (
    <div className="attr-sections">
      <nav className="attr-sections-nav" aria-label="Attribute sections">
        {sectionNav.map((item) => (
          <button
            key={item.id}
            type="button"
            className={active === item.id ? 'on' : ''}
            aria-current={active === item.id ? 'location' : undefined}
            onClick={() => jump(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div>{body}</div>
    </div>
  ) : body;

  return (
    <>
      {filter}
      {sectionsView}
    </>
  );
}

function hasStoredValue(attr: unknown): boolean {
  const value = attr && typeof attr === 'object' && 'value' in attr ? (attr as { value: unknown }).value : attr;
  return value !== null && value !== undefined && value !== '' && value !== '—';
}

function SectionTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '10px 16px',
        fontSize: '13px',
        fontWeight: active ? 600 : 500,
        color: active ? 'var(--accent)' : 'var(--ink-2)',
        background: 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
        marginBottom: '-2px',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}
