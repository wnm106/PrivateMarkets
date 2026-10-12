'use client';

import { useState } from 'react';
import type { EntityData } from './types';
import { SourceAttributedFieldRow, type FieldData } from './SourceAttributedFieldRow';
import { sources, type SourceKey } from '@/lib/data';

export interface TemplateAttribute {
  attributeCode: string;
  attributeName: string;
  required: boolean;
  displaySection: string;
  sortOrder: number;
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
}

export function GoldenRecordSections({
  entity,
  templateAttributes = [],
  lineageData = [],
  onAddAttribute,
  onSourceChange,
  onValueChange,
  onAddSourceValue,
}: GoldenRecordSectionsProps) {
  const [showAddAttribute, setShowAddAttribute] = useState(false);
  const [selectedAttrCode, setSelectedAttrCode] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newSource, setNewSource] = useState<SourceKey>('manual');

  const attributes = entity.attributes || {};
  const attributeEntries = Object.entries(attributes);

  const missingAttributes = templateAttributes.filter(
    (ta) => !attributes[ta.attributeCode]
  );

  const lineageMap = new Map<string, LineageData>();
  lineageData.forEach((ld) => lineageMap.set(ld.attributeCode, ld));

  const handleAddAttribute = () => {
    if (selectedAttrCode && onAddAttribute) {
      onAddAttribute(selectedAttrCode, newValue, newSource);
      setSelectedAttrCode('');
      setNewValue('');
      setNewSource('manual');
      setShowAddAttribute(false);
    }
  };

  const handleSourceChange = (labelOrCode: string, newSrc: SourceKey) => {
    // The SourceAttributedFieldRow passes attributeCode if available, otherwise label
    // We need to pass the attribute code to the parent for proper identification
    onSourceChange?.(labelOrCode, newSrc);
  };

  const handleDrilldown = (_label: string) => {
    // Inline drilldown is handled by SourceAttributedFieldRow
  };

  if (attributeEntries.length === 0 && missingAttributes.length === 0) {
    return (
      <div className="field-section">
        <div className="field-section-head">
          <div className="field-section-name">Attributes</div>
          <div className="field-section-count">0 fields</div>
        </div>
        <div style={{ padding: '20px', color: 'var(--ink-3)', textAlign: 'center' }}>
          No attributes available for this entity.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="field-section">
        <div className="field-section-head">
          <div className="field-section-name">Entity Attributes</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div className="field-section-count">{attributeEntries.length} fields</div>
            {missingAttributes.length > 0 && onAddAttribute && (
              <button
                className="btn btn-sm"
                onClick={() => setShowAddAttribute(!showAddAttribute)}
                style={{ fontSize: '11px', padding: '4px 10px' }}
              >
                {showAddAttribute ? 'Cancel' : '+ Add Attribute'}
              </button>
            )}
          </div>
        </div>

        {showAddAttribute && missingAttributes.length > 0 && (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-alt)' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: 'var(--ink-2)' }}>
              Add Attribute ({missingAttributes.length} available from template)
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                className="select"
                value={selectedAttrCode}
                onChange={(e) => setSelectedAttrCode(e.target.value)}
                style={{ minWidth: '200px' }}
              >
                <option value="">Select attribute...</option>
                {missingAttributes.map((ta) => (
                  <option key={ta.attributeCode} value={ta.attributeCode}>
                    {ta.attributeName} ({ta.attributeCode}){ta.required ? ' *' : ''}
                  </option>
                ))}
              </select>
              <input
                className="text-input"
                placeholder="Value"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                style={{ minWidth: '150px' }}
              />
              <select
                className="select"
                value={newSource}
                onChange={(e) => setNewSource(e.target.value as SourceKey)}
                style={{ minWidth: '120px' }}
              >
                {Object.entries(sources).map(([key, src]) => (
                  <option key={key} value={key}>{src.name}</option>
                ))}
              </select>
              <button
                className="btn btn-sm btn-primary"
                onClick={handleAddAttribute}
                disabled={!selectedAttrCode}
                style={{ fontSize: '11px' }}
              >
                Add
              </button>
            </div>
          </div>
        )}

        {attributeEntries.map(([key, attr]) => {
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
            />
          );
        })}
      </div>

      {entity.parentRelationships && entity.parentRelationships.length > 0 && (
        <div className="field-section" style={{ marginTop: '24px' }}>
          <div className="field-section-head">
            <div className="field-section-name">Parent Relationships</div>
            <div className="field-section-count">{entity.parentRelationships.length}</div>
          </div>
          {entity.parentRelationships.map((rel, idx) => (
            <div key={idx} className="field-row" style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: '13px' }}>{rel.relationshipType}</div>
                  <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '2px' }}>
                    {rel.parentDomainCode}
                  </div>
                </div>
                <div style={{ fontSize: '14px', color: 'var(--ink-1)' }}>
                  {rel.parentEntityName} ({rel.parentEntityCode})
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {entity.childRelationships && entity.childRelationships.length > 0 && (
        <div className="field-section" style={{ marginTop: '24px' }}>
          <div className="field-section-head">
            <div className="field-section-name">Child Relationships</div>
            <div className="field-section-count">{entity.childRelationships.length}</div>
          </div>
          {entity.childRelationships.map((rel, idx) => (
            <div key={idx} className="field-row" style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: '13px' }}>{rel.relationshipType}</div>
                  <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '2px' }}>
                    {rel.childDomainCode}
                  </div>
                </div>
                <div style={{ fontSize: '14px', color: 'var(--ink-1)' }}>
                  {rel.childEntityName} ({rel.childEntityCode})
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
