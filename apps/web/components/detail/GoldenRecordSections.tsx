'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EntityData } from './types';
import { SourceAttributedFieldRow, type FieldData } from './SourceAttributedFieldRow';
import { type SourceKey } from '@/lib/data';
import { useTemporalStore } from '@/lib/store';
import { ATTRIBUTE_SECTIONS_QUERY, INTERSECTION_TYPES_QUERY, RELATIONSHIP_TYPES_QUERY, graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { DisplayLayoutView, type DisplayCellData, type ResolvedLayoutView } from './DisplayLayoutView';
import { EntityReports } from '@/components/reporting/EntityReports';
import { DataQualityDashboard } from '@/components/quality/DataQualityDashboard';
import { RelationshipEntityGrids } from './RelationshipEntityGrids';
import { classifyRecordRelationships, singularRelatedRefs } from '@/lib/relationship-grids';
import { definingParentDomains, toParentLinkCounts, type ParentLinkCount, type ParentRelationshipType } from '@/lib/parent-entities';
import { supabaseBrowserClient } from '@/lib/supabase-browser';
import { attributeSectionLinks, groupForDisplay, type AttributeSectionOrder } from '@/lib/attribute-layout';
import { decompileCalcExpression } from '@/lib/calc-expression';

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
  onAddSourceValue?: (attributeCode: string, source: SourceKey, value: string) => void;
  onDeleteSourceValue?: (attributeCode: string, sourceCode: string) => void;
  asOfDate?: string;
  lineageLoaded?: boolean;
}

function formulaLabel(formula: string | null | undefined): string {
  if (!formula) return 'Calculated';
  const shown = decompileCalcExpression(formula.replace(/^CALC_SPEC:/, ''));
  return shown || 'Calculated';
}

const ENTITY_DISPLAY_QUERY = `
  query EntityDisplay($entityId: ID!, $asOfDate: Date, $knowledgeDate: DateTime, $controls: JSON) {
    entityDisplay(entityId: $entityId, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate, controls: $controls) {
      fiscalYearEndMonth
      layouts {
        id
        layoutName
        htmlTemplate
        parameters { name label type binds multi defaultValue options { value label sets } }
        effectiveControls
        periods { key label periodStart periodEnd grain entityId }
        rows {
          attributeCode
          cells { periodKey basis value readOnly entityId periodStart periodEnd periodGrain }
        }
      }
    }
  }
`;

const DERIVED_ATTRIBUTE_QUERY = `
  query DerivedAttributes($domainCode: String!) {
    attributeRegister(domainCode: $domainCode) {
      attributeCode
      isDerived
      derivationFormula
    }
  }
`;

const SAVE_DISPLAY_VALUE_MUTATION = `
  mutation SaveDisplayValue($input: SaveDisplayValueInput!) {
    saveDisplayValue(input: $input) {
      success
      errors { message }
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
  onAddSourceValue,
  onDeleteSourceValue,
  asOfDate,
  lineageLoaded = false,
}: GoldenRecordSectionsProps) {
  const calcRefreshKey = lineageData
    .map((row) => `${row.attributeCode}:${row.currentValue ?? ''}:${row.lastUpdated ?? ''}`)
    .join('|');
  const [tab, setTab] = useState<'attributes' | 'dashboards' | 'quality' | 'relationships'>('attributes');
  const [relationshipCatalog, setRelationshipCatalog] = useState<{
    types: ParentRelationshipType[];
    linkCounts: ParentLinkCount[];
    parentDomains: string[];
  } | null>(null);
  const [controls, setControls] = useState<Record<string, string> | null>(null);
  const [displayVersion, setDisplayVersion] = useState(0);
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
  const layoutKey = `${entity.id}\0${asOfDate ?? ''}\0${knowledgeDate ?? ''}`;
  const [layoutState, setLayoutState] = useState<{ key: string; layouts: ResolvedLayoutView[] | null }>({
    key: layoutKey,
    layouts: null,
  });
  if (layoutState.key !== layoutKey) {
    setLayoutState({ key: layoutKey, layouts: null });
  }
  const layouts = layoutState.key === layoutKey ? layoutState.layouts : null;

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
    setControls(null);
  }, [entity.id]);

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

  useEffect(() => {
    let cancelled = false;
    graphqlQuery<{ entityDisplay: { layouts: ResolvedLayoutView[] } }, { entityId: string; asOfDate?: string; knowledgeDate?: string; controls: Record<string, string> }>(
      ENTITY_DISPLAY_QUERY,
      { entityId: entity.id, asOfDate, knowledgeDate, controls: controls ?? {} },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      const next = result.error ? [] : (result.data?.entityDisplay?.layouts ?? []);
      setLayoutState((current) => (current.key === layoutKey ? { key: layoutKey, layouts: next } : current));
    }).catch(() => {
      if (cancelled) return;
      setLayoutState((current) => (current.key === layoutKey ? { key: layoutKey, layouts: [] } : current));
    });
    return () => { cancelled = true; };
  }, [entity.id, asOfDate, knowledgeDate, controls, displayVersion, layoutKey]);

  const attributes = entity.attributes || {};
  const assignedCodes = new Set(templateAttributes.map((attribute) => attribute.attributeCode));
  const layoutCodes = new Set((layouts ?? []).flatMap((layout) => layout.rows.map((row) => row.attributeCode)));
  // Stored values can exist for attributes owned by another entity type. Once the
  // assignment catalog is loaded, only show attributes assigned to this entity.
  const attributeEntries = Object.entries(attributes).filter(([key]) =>
    (assignedCodes.size === 0 || assignedCodes.has(key)) && !layoutCodes.has(key)
  );
  const populatedEntries = attributeEntries.filter(([, attr]) => hasStoredValue(attr));
  const temporalEntries = lineageData
    .filter((lineage) => hasStoredValue(lineage.currentValue))
    .filter((lineage) => assignedCodes.size === 0 || assignedCodes.has(lineage.attributeCode))
    .filter((lineage) => !layoutCodes.has(lineage.attributeCode))
    .map((lineage) => [lineage.attributeCode, { value: lineage.currentValue }] as [string, { value: string }]);
  const displayEntries = lineageLoaded ? temporalEntries : populatedEntries;
  const lineageMap = new Map<string, LineageData>();
  lineageData.forEach((ld) => lineageMap.set(ld.attributeCode, ld));

  const listedAttributes: TemplateAttribute[] = [];
  const listedCodes = new Set<string>();
  for (const attribute of templateAttributes) {
    if (layoutCodes.has(attribute.attributeCode)) continue;
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
      </div>

      {tab === 'dashboards' ? (
        <EntityReports domainCode={entity.domainCode} entityId={entity.id} asOfDate={asOfDate} embedded />
      ) : tab === 'quality' ? (
        <DataQualityDashboard embedded domainCode={entity.domainCode} entityId={entity.id} />
      ) : tab === 'relationships' ? (
        !shown ? (
          <div className="field-section" aria-busy="true">
            <div style={{ padding: '16px 20px', color: 'var(--ink-3)', fontSize: '13px' }}>Loading…</div>
          </div>
        ) : (
          <RelationshipEntityGrids
            entityId={entity.id}
            asOfDate={asOfDate}
            parents={shown.parents}
            children={shown.children}
          />
        )
      ) : !sections || !layouts ? (
        <div className="field-section" aria-busy="true">
          <div style={{ padding: '16px 20px', color: 'var(--ink-3)', fontSize: '13px' }}>
            Loading…
          </div>
        </div>
      ) : (
        <AttributeSections
          layouts={layouts}
          sections={sections}
          controls={controls ?? {}}
          onControlsChange={setControls}
          onSaveCell={async (attributeCode, cell, value) => {
            const result = await graphqlMutation<{ saveDisplayValue: { success: boolean; errors: Array<{ message: string }> } }, { input: Record<string, string | null> }>(
              SAVE_DISPLAY_VALUE_MUTATION,
              {
                input: {
                  entityId: cell.entityId || entity.id,
                  attributeCode,
                  value,
                  periodStart: cell.periodStart,
                  periodEnd: cell.periodEnd,
                  periodGrain: cell.periodGrain || null,
                  statementBasis: cell.basis || null,
                },
              },
            );
            const saveError = result.error?.message || result.data?.saveDisplayValue?.errors?.[0]?.message;
            if (saveError || !result.data?.saveDisplayValue?.success) throw new Error(saveError || 'Save failed');
            setDisplayVersion((version) => version + 1);
          }}
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
            node: (
              <SourceAttributedFieldRow
                field={fieldData}
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
  node: ReactNode;
}

function AttributeSections({
  layouts,
  sections,
  controls,
  onControlsChange,
  onSaveCell,
  items,
}: {
  layouts: ResolvedLayoutView[];
  sections: AttributeSectionOrder[];
  controls: Record<string, string>;
  onControlsChange: (next: Record<string, string>) => void;
  onSaveCell: (attributeCode: string, cell: DisplayCellData, value: string) => Promise<void>;
  items: AttributeDisplayNode[];
}) {
  const groups = groupForDisplay(items, sections);
  const links = attributeSectionLinks(groups.map((group) => group.section));
  const sectionNav = [
    ...layouts.map((layout) => ({
      id: `attr-layout-${layout.id}`,
      label: layout.layoutName?.trim() || 'Statement',
    })),
    ...links,
  ];
  const sectionNavKey = sectionNav.map((item) => encodeURIComponent(item.id)).join('\n');
  const [activeSection, setActiveSection] = useState('');
  const jumpLock = useRef(0);
  const active = sectionNav.some((item) => item.id === activeSection) ? activeSection : (sectionNav[0]?.id || '');
  const showNav = sectionNav.length > 1;

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

  const body = (
    <>
      {layouts.map((layout) => (
        <DisplayLayoutView
          key={layout.id}
          anchorId={`attr-layout-${layout.id}`}
          layout={layout}
          controls={controls}
          onControlsChange={onControlsChange}
          onSaveCell={onSaveCell}
        />
      ))}
      {items.length === 0 && (
        <div className="field-section">
          <div style={{ padding: '16px 20px', color: 'var(--ink-3)', fontSize: '13px' }}>
            No attribute values yet.
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

  if (!showNav) return body;

  return (
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
