'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import type { EntityData } from './types';
import { SourceAttributedFieldRow, type FieldData } from './SourceAttributedFieldRow';
import { sources, type SourceKey } from '@/lib/data';
import { useTemporalStore } from '@/lib/store';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { DisplayLayoutView, type ResolvedLayoutView } from './DisplayLayoutView';

export interface TemplateAttribute {
  attributeCode: string;
  attributeName: string;
  required: boolean;
  displaySection: string;
  sortOrder: number;
  dataType?: string;
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
  }>;
  resolutionRule: string;
  lastUpdated: string;
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
  const [tab, setTab] = useState<'attributes' | 'relationships'>('attributes');
  const [layouts, setLayouts] = useState<ResolvedLayoutView[]>([]);
  const [controls, setControls] = useState<Record<string, string> | null>(null);
  const [displayVersion, setDisplayVersion] = useState(0);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);

  useEffect(() => {
    setControls(null);
  }, [entity.id]);

  useEffect(() => {
    let cancelled = false;
    graphqlQuery<{ entityDisplay: { layouts: ResolvedLayoutView[] } }, { entityId: string; asOfDate?: string; knowledgeDate?: string; controls: Record<string, string> }>(
      ENTITY_DISPLAY_QUERY,
      { entityId: entity.id, asOfDate, knowledgeDate, controls: controls ?? {} },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      setLayouts(result.error ? [] : (result.data?.entityDisplay?.layouts ?? []));
    }).catch(() => {
      if (!cancelled) setLayouts([]);
    });
    return () => { cancelled = true; };
  }, [entity.id, asOfDate, knowledgeDate, controls, displayVersion]);

  const attributes = entity.attributes || {};
  const assignedCodes = new Set(templateAttributes.map((attribute) => attribute.attributeCode));
  const layoutCodes = new Set(layouts.flatMap((layout) => layout.rows.map((row) => row.attributeCode)));
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
  const populatedCodes = new Set(displayEntries.map(([key]) => key));
  const availableAttributes = templateAttributes
    .filter((attribute) => !populatedCodes.has(attribute.attributeCode))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.attributeName.localeCompare(b.attributeName));

  const lineageMap = new Map<string, LineageData>();
  lineageData.forEach((ld) => lineageMap.set(ld.attributeCode, ld));

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
  const relationshipCount = parentRelationships.length + childRelationships.length;

  return (
    <div>
      <div style={{ display: 'flex', gap: '4px', borderBottom: '2px solid var(--line)', marginBottom: '16px' }}>
        <SectionTab
          label={`Attributes (${populatedEntries.length})`}
          active={tab === 'attributes'}
          onClick={() => setTab('attributes')}
        />
        <SectionTab
          label={`Relationships (${relationshipCount})`}
          active={tab === 'relationships'}
          onClick={() => setTab('relationships')}
        />
      </div>

      {tab === 'relationships' ? (
        <div>
          <RelationshipList
            title="Parent Relationships"
            count={parentRelationships.length}
            emptyText="No parent relationships."
            rows={parentRelationships.map((rel, index) => ({
              key: `${rel.relationshipCode}-${rel.parentEntityCode}-${index}`,
              type: rel.relationshipType || rel.relationshipCode,
              domain: rel.parentDomainCode,
              name: rel.parentEntityName,
              code: rel.parentEntityCode,
              entityId: rel.parentEntityId,
              members: rel.members || [],
            }))}
          />
          <RelationshipList
            title="Child Relationships"
            count={childRelationships.length}
            emptyText="No child relationships."
            rows={childRelationships.map((rel, index) => ({
              key: `${rel.relationshipCode}-${rel.childEntityCode}-${index}`,
              type: rel.relationshipType || rel.relationshipCode,
              domain: rel.childDomainCode,
              name: rel.childEntityName,
              code: rel.childEntityCode,
              entityId: rel.childEntityId,
              members: rel.members || [],
            }))}
          />
        </div>
      ) : (
      <div>
        {layouts.map((layout) => (
          <DisplayLayoutView
            key={layout.id}
            layout={layout}
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
          />
        ))}
      <div className="field-section">
        <div className="field-section-head">
          <div className="field-section-name">Entity Attributes</div>
          <div className="field-section-count">{displayEntries.length} populated</div>
        </div>

        {displayEntries.length === 0 && (
          <div style={{ padding: '16px 20px', color: 'var(--ink-3)', fontSize: '13px' }}>
            No attribute values yet.
          </div>
        )}

        {displayEntries.map(([key, attr]) => {
          const lineage = lineageMap.get(key);
          // Support both nested { value, source/source_code } and flat string/number values
          const attrValue = attr && typeof attr === 'object' && 'value' in attr ? attr.value : attr;
          const attrSource = attr && typeof attr === 'object'
            ? ((attr as any).source_code || (attr as any).source)
            : 'manual';

          // Prefer lineage.currentValue (resolved by fieldLineage resolver) over entity.attributes
          // because the resolver correctly skips null/empty values when picking the golden source
          const resolvedValue = lineage?.currentValue ?? attrValue;
          const resolvedSource = lineage?.currentValue !== undefined && lineage?.currentValue !== null
            ? (lineage.competingValues?.find(cv => cv.value === lineage.currentValue)?.source ?? attrSource)
            : attrSource;

          // Resolve display label from template attributes, fall back to attribute code
          const templateAttr = templateAttributes.find(ta => ta.attributeCode === key);
          const displayLabel = templateAttr?.attributeName || key;

          // Normalize source_code to a valid SourceKey (lowercase)
          const normalizedSource = (typeof resolvedSource === 'string' ? resolvedSource.toLowerCase() : 'manual') as SourceKey;
          const validSource: SourceKey = normalizedSource in sources ? normalizedSource : 'manual';

          const fieldData: FieldData = {
            label: displayLabel,
            attributeCode: key,
            dataType: templateAttr?.dataType,
            value: resolvedValue !== null && resolvedValue !== undefined && resolvedValue !== '' ? String(resolvedValue) : '—',
            source: validSource,
            precedenceRank: lineage?.competingValues?.find(cv => {
              const normCv = typeof cv.source === 'string' ? cv.source.toLowerCase() : 'manual';
              return normCv === validSource;
            })?.precedenceRank,
            competingValues: lineage?.competingValues?.map(cv => {
              const normalizedCvSource = (typeof cv.source === 'string' ? cv.source.toLowerCase() : 'manual');
              const validCvSource: SourceKey = normalizedCvSource in sources ? normalizedCvSource as SourceKey : 'manual';
              return {
                source: validCvSource,
                sourceName: cv.sourceName,
                value: cv.value,
                precedenceRank: cv.precedenceRank,
                validFrom: cv.validFrom,
                validTo: cv.validTo,
                confidenceScore: cv.confidenceScore,
              };
            }),
            resolutionRule: lineage?.resolutionRule,
          };

          return (
            <SourceAttributedFieldRow
              key={key}
              field={fieldData}
              onDrilldown={handleDrilldown}
              onSourceChange={handleSourceChange}
              onValueChange={onValueChange}
              onAddSourceValue={onAddSourceValue}
              onDeleteSourceValue={onDeleteSourceValue}
              asOfDate={asOfDate}
            />
          );
        })}

        {availableAttributes.length > 0 && (
          <>
            <div className="field-section-head" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="field-section-name">Available attributes</div>
              <div className="field-section-count">{availableAttributes.length} to enter</div>
            </div>
            {availableAttributes.map((attribute) => (
              <AvailableAttributeRow
                key={attribute.attributeCode}
                attribute={attribute}
                onSave={(value) => onAddAttribute?.(attribute.attributeCode, value, 'manual')}
              />
            ))}
          </>
        )}
      </div>
      </div>
      )}
    </div>
  );
}

function hasStoredValue(attr: unknown): boolean {
  const value = attr && typeof attr === 'object' && 'value' in attr ? (attr as { value: unknown }).value : attr;
  return value !== null && value !== undefined && value !== '' && value !== '—';
}

function AvailableAttributeRow({
  attribute,
  onSave,
}: {
  attribute: TemplateAttribute;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState('');

  const save = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSave(trimmed);
  };

  return (
    <div className="sa-field-row" style={{ cursor: 'default' }}>
      <div className="sa-field-label">
        {attribute.attributeName}
        {attribute.required && <span style={{ color: 'var(--red)' }}>*</span>}
      </div>
      <input
        className="text-input"
        value={value}
        placeholder="Enter a value"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save();
        }}
        style={{ fontSize: '13px', padding: '6px 8px' }}
      />
      <button className="btn btn-sm" type="button" onClick={save} disabled={!value.trim()} style={{ justifySelf: 'end' }}>
        Save
      </button>
    </div>
  );
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

function RelationshipList({
  title,
  count,
  emptyText,
  rows,
}: {
  title: string;
  count: number;
  emptyText: string;
  rows: Array<{
    key: string;
    type: string;
    domain: string;
    name: string;
    code: string;
    entityId?: string;
    members: Array<{ entityId: string; entityCode: string; entityName: string; domainCode: string }>;
  }>;
}) {
  return (
    <div className="field-section" style={{ marginBottom: '16px' }}>
      <div className="field-section-head">
        <div className="field-section-name">{title}</div>
        <div className="field-section-count">{count}</div>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: '16px 20px', color: 'var(--ink-3)', fontSize: '13px' }}>{emptyText}</div>
      ) : (
        <>
          <div style={relationshipGridStyle}>
            <span style={relationshipHeadStyle}>Relationship</span>
            <span style={relationshipHeadStyle}>Type</span>
            <span style={relationshipHeadStyle}>Entity</span>
          </div>
          {rows.map((row) => (
            <div key={row.key} style={{ ...relationshipGridStyle, borderTop: '1px solid var(--line)' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap' }}>{row.type}</span>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>{row.domain}</span>
              <span style={{ fontSize: '13px', minWidth: 0 }}>
                {row.members.length > 0 ? (
                  <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span>
                      {row.members.map((member, index) => (
                        <span key={member.entityId}>
                          {index > 0 && <span style={{ color: 'var(--ink-3)' }}> · </span>}
                          <Link href={entityPageHref(member.domainCode, member.entityId)} className="relationship-entity-link">
                            {member.entityName}
                          </Link>
                        </span>
                      ))}
                    </span>
                    {row.entityId ? (
                      <Link href={entityPageHref(row.domain, row.entityId)} style={{ fontSize: '11px', color: 'var(--ink-3)', fontWeight: 400 }}>
                        {row.name} ({row.code})
                      </Link>
                    ) : (
                      <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>{row.name} ({row.code})</span>
                    )}
                  </span>
                ) : row.entityId ? (
                  <Link href={entityPageHref(row.domain, row.entityId)} className="relationship-entity-link">
                    {row.name} <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}>({row.code})</span>
                  </Link>
                ) : (
                  <>{row.name} <span style={{ color: 'var(--ink-3)' }}>({row.code})</span></>
                )}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

const DOMAIN_ROUTES: Record<string, string> = {
  FUND: 'funds',
  ISSUER: 'issuers',
  SECURITY: 'securities',
  DEAL: 'deals',
  INVESTOR: 'investors',
  PRICE: 'prices',
  POSITION: 'positions',
};

function entityPageHref(domainCode: string, entityId: string): string {
  const route = DOMAIN_ROUTES[domainCode?.toUpperCase()] || `${(domainCode || 'entity').toLowerCase()}s`;
  return `/${route}/${entityId}`;
}

const relationshipGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(220px, 1.1fr) minmax(120px, 160px) minmax(320px, 2fr)',
  gap: '16px',
  alignItems: 'center',
  padding: '8px 20px',
};

const relationshipHeadStyle: CSSProperties = {
  fontSize: '10px',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};
