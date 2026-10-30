'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { graphqlQuery, graphqlMutation, INTERSECTION_QUERY, ENTITY_QUERY, FIELD_LINEAGE_QUERY, ENTITY_ACTIVITY_QUERY, ATTRIBUTE_REGISTER_QUERY, UPDATE_ENTITY_MUTATION, ADD_COMPETING_SOURCE_MUTATION, DELETE_COMPETING_SOURCE_MUTATION, DATA_SOURCE_QUERY } from '@/lib/graphql';
import { GoldenRecordHeader } from '@/components/detail/GoldenRecordHeader';
import { GoldenRecordSections, type TemplateAttribute, type LineageData } from '@/components/detail/GoldenRecordSections';
import { SourceContributionPanel } from '@/components/detail/SourceContributionPanel';
import { ActiveConflictsPanel } from '@/components/detail/ActiveConflictsPanel';
import { ActivityFeedPanel } from '@/components/detail/ActivityFeedPanel';
import { sources, type SourceKey } from '@/lib/data';
import { getDomainConfig } from '@/lib/mock-data';
import { useTemporalStore } from '@/lib/store';
import { entityViewFocus, usePublishViewContext } from '@/lib/view-context';
import type { EntityData, ConflictData, SourceContributionData, ActivityData } from '@/components/detail/types';

interface IntersectionMember {
  memberRole: string;
  entityId: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
}

interface IntersectionData {
  id: string;
  intersectionCode: string;
  intersectionTypeCode: string;
  intersectionTypeName: string;
  members: IntersectionMember[];
  attributes: Record<string, any>;
  validFrom: string;
  validTo: string;
  metadata?: any;
  createdAt: string;
  updatedAt: string;
}

export default function PositionDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const domainConfig = getDomainConfig('positions');
  const asOfDate = useTemporalStore(state => state.asOfDate);
  const knowledgeDate = useTemporalStore(state => state.knowledgeDate);
  const [entity, setEntity] = useState<EntityData | null>(null);
  const [isMasterEntity, setIsMasterEntity] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lineageData, setLineageData] = useState<LineageData[]>([]);
  const [lineageLoaded, setLineageLoaded] = useState(false);
  const [templateAttributes, setTemplateAttributes] = useState<TemplateAttribute[]>([]);
  const [canRename, setCanRename] = useState(false);
  const [activities, setActivities] = useState<ActivityData[]>([]);
  const conflicts: ConflictData[] = [];
  const sourceContributions: SourceContributionData[] = [];
  let qualityScore = 0;
  let lastReviewedText = '—';
  if (entity) {
    const attrs = entity.attributes || {};
    const attrEntries = Object.entries(attrs);
    if (attrEntries.length > 0) {
      const filledCount = attrEntries.filter(([_, v]) => {
        const val = v && typeof v === 'object' && 'value' in v ? v.value : v;
        return val !== null && val !== undefined && val !== '';
      }).length;
      qualityScore = Math.round((filledCount / attrEntries.length) * 100);
    }
    const sourceCounts = new Map<string, { name: string; count: number; color: string }>();
    lineageData.forEach((ld) => {
      ld.competingValues?.forEach((cv) => {
        const srcKey = typeof cv.source === 'string' ? cv.source.toLowerCase() : 'manual';
        const known = sources[srcKey as SourceKey];
        const existing = sourceCounts.get(srcKey);
        if (existing) { existing.count++; }
        else {
          sourceCounts.set(srcKey, {
            name: cv.sourceName || known?.name || srcKey,
            count: 1,
            color: known?.hex || '#475569',
          });
        }
      });
    });
    const totalFields = lineageData.length || attrEntries.length || 1;
    sourceContributions.push(
      ...Array.from(sourceCounts.entries()).map(([key, val]) => ({
        source: key, sourceName: val.name, fieldCount: val.count,
        percentage: Math.round((val.count / totalFields) * 100),
        color: val.color,
      }))
    );
    lineageData.forEach((ld) => {
      const distinctValues = new Set(
        (ld.competingValues || []).filter((cv) => cv.value && cv.value !== '—' && cv.value !== '').map((cv) => cv.value)
      );
      if (distinctValues.size > 1) {
        conflicts.push({ field: ld.attributeCode, severity: 'med', description: `${distinctValues.size} competing values from different sources` });
      }
    });
  }
  const loadActivity = useCallback(async (entityId: string) => {
    const result = await graphqlQuery<
      { entityActivity: Array<{ attributeCode: string; attributeName: string; value: string | null; updatedAt: string; updatedBy: string; validFrom: string; validTo: string }> },
      { entityId: string; knowledgeDate: string }
    >(ENTITY_ACTIVITY_QUERY, { entityId, knowledgeDate }, 'network-only');
    setActivities((result.data?.entityActivity || []).map((entry) => ({
      who: entry.updatedBy || 'System',
      time: entry.updatedAt,
      attribute: entry.attributeName || entry.attributeCode,
      attributeCode: entry.attributeCode,
      value: entry.value ?? '',
      validFrom: entry.validFrom,
      validTo: entry.validTo,
      text: `${entry.attributeName || entry.attributeCode} set to ${entry.value ?? 'cleared'}`,
    })));
  }, [knowledgeDate]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      graphqlQuery<{ intersection: IntersectionData }, { intersectionCode: string; asOfDate: string }>(INTERSECTION_QUERY, { intersectionCode: id, asOfDate }, 'network-only'),
      graphqlQuery<{ attributeRegister: Array<{ attributeCode: string; attributeName: string; isRequired: boolean; displaySection: string; displayGroup: number }> }, { domainCode: string }>(ATTRIBUTE_REGISTER_QUERY, { domainCode: 'POSITION' }),
    ]).then(async ([ixResult, attrResult]) => {
      if (cancelled) return;
      if (!ixResult.data?.intersection) {
        const entityResult = await graphqlQuery<any, { id: string; asOfDate: string; knowledgeDate: string }>(
          ENTITY_QUERY,
          { id, asOfDate, knowledgeDate },
          'network-only'
        );
        if (cancelled) return;
        const loaded = entityResult.data?.entity;
        if (!loaded || loaded.domainCode !== 'POSITION') {
          setError(ixResult.error?.message || entityResult.error?.message || 'Position not found');
          setLoading(false);
          return;
        }
        setIsMasterEntity(true);
        setEntity(loaded);
        setCanRename(true);
        await loadActivity(loaded.id);
        if (attrResult.data?.attributeRegister) {
          const mappedAttributes: TemplateAttribute[] = attrResult.data.attributeRegister
            .filter((a: any) => a.isVisible !== false)
            .map((a: any) => ({
              attributeCode: a.attributeCode,
              attributeName: a.attributeName,
              dataType: a.dataType,
              required: a.isRequired || false,
              displaySection: a.displaySection || 'Position',
              sortOrder: a.displayGroup || 0,
              spanColumns: a.displaySpanColumns,
              spanRows: a.displaySpanRows,
              isDerived: a.isDerived === true,
              derivationFormula: a.derivationFormula,
            }));
          setTemplateAttributes(mappedAttributes);
        }
        setLoading(false);
        return;
      }
      if (ixResult.error) { setError(ixResult.error.message || 'Failed to load position'); setLoading(false); return; }
      const ix = ixResult.data.intersection;
      setCanRename(false);
      setIsMasterEntity(false);
      setEntity({
        id: ix.id, entityCode: ix.intersectionCode, entityName: ix.intersectionCode,
        domainCode: 'POSITION', domainName: 'Position', templateName: ix.intersectionTypeName,
        description: ix.members.map(m => `${m.memberRole}: ${m.entityName}`).join(', '),
        isActive: true, attributes: ix.attributes || {},
        parentRelationships: ix.members.map(m => ({
          parentEntityId: m.entityId, parentEntityCode: m.entityCode, parentEntityName: m.entityName,
          parentDomainCode: m.domainCode, relationshipType: m.memberRole, relationshipCode: m.memberRole,
          isPrimary: m.memberRole === 'FUND' || m.memberRole === 'SECURITY',
        })),
        childRelationships: [], metadata: ix.metadata, createdAt: ix.createdAt, updatedAt: ix.updatedAt,
      });
      if (attrResult.data?.attributeRegister) {
        const mappedAttributes: TemplateAttribute[] = attrResult.data.attributeRegister
          .filter((a: any) => a.isVisible !== false)
          .map((a: any) => ({
            attributeCode: a.attributeCode,
            attributeName: a.attributeName,
            dataType: a.dataType,
            required: a.isRequired || false,
            displaySection: a.displaySection || 'General',
            sortOrder: a.displayGroup || 0,
            spanColumns: a.displaySpanColumns,
            spanRows: a.displaySpanRows,
            isDerived: a.isDerived === true,
            derivationFormula: a.derivationFormula,
          }));
        setTemplateAttributes(mappedAttributes);
      }
      try {
        const lr = await graphqlQuery<{ fieldLineage: LineageData[] }, { entityId: string; asOfDate: string; knowledgeDate: string }>(FIELD_LINEAGE_QUERY, { entityId: ix.id, asOfDate, knowledgeDate }, 'network-only');
        if (lr.error || !lr.data?.fieldLineage) {
          setLineageData([]);
          setLineageLoaded(false);
        } else {
          setLineageData(lr.data.fieldLineage);
          setLineageLoaded(true);
        }
        await loadActivity(ix.id);
      } catch (err) { console.error('Failed to fetch lineage:', err); }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [id, asOfDate, knowledgeDate, loadActivity]);

  const refreshLineage = async (entityId: string) => {
    const lr = await graphqlQuery<{ fieldLineage: LineageData[] }, { entityId: string; asOfDate: string; knowledgeDate: string }>(
      FIELD_LINEAGE_QUERY,
      { entityId, asOfDate, knowledgeDate },
      'network-only',
    );
    if (lr.error || !lr.data?.fieldLineage) {
      setLineageData([]);
      setLineageLoaded(false);
      return;
    }
    setLineageData(lr.data.fieldLineage);
    setLineageLoaded(true);
    await loadActivity(entityId);
  };

  const handleAddAttribute = async (attributeCode: string, value: string) => {
    if (!entity?.id) throw new Error('Position is still loading');
    const result = await graphqlMutation<{ updateEntity: { errors: Array<{ message: string }> } }, { input: { id: string; attributes: Record<string, string> } }>(
      UPDATE_ENTITY_MUTATION,
      { input: { id: entity.id, attributes: { [attributeCode]: value }, asOfDate } },
    );
    const saveError = result.error?.message || result.data?.updateEntity?.errors?.[0]?.message;
    if (saveError) throw new Error(saveError);
    await refreshLineage(entity.id);
  };

  const handleSourceChange = async (attributeCode: string, sourceId: string) => { console.log('Source change:', attributeCode, sourceId); };

  const handleValueChange = async (attributeCode: string, value: string) => {
    await handleAddAttribute(attributeCode, value);
  };

  const handleAddSourceValue = async (attributeCode: string, source: SourceKey, value: string) => {
    if (!entity?.id) throw new Error('Position is still loading');
    const sourceCode = String(source).toUpperCase();
    const sourceResult = await graphqlQuery<{ dataSource: { id: string } }, { code: string }>(
      DATA_SOURCE_QUERY,
      { code: sourceCode },
      'network-only',
    );
    const sourceId = sourceResult.data?.dataSource?.id;
    if (!sourceId) throw new Error(`Source ${sourceCode} is not registered`);
    const result = await graphqlMutation<{ addCompetingSource: { success: boolean; errors: Array<{ message: string }> } }, { input: { entityId: string; attributeCode: string; sourceId: string; value: string; validFrom: string } }>(
      ADD_COMPETING_SOURCE_MUTATION,
      { input: { entityId: entity.id, attributeCode, sourceId, value, validFrom: asOfDate } },
    );
    const saveError = result.error?.message || result.data?.addCompetingSource?.errors?.[0]?.message;
    if (saveError || !result.data?.addCompetingSource?.success) throw new Error(saveError || 'Could not save the value');
    if (isMasterEntity) {
      const entityResult = await graphqlQuery<any, { id: string; asOfDate: string; knowledgeDate: string }>(
        ENTITY_QUERY,
        { id: entity.id, asOfDate, knowledgeDate },
        'network-only',
      );
      if (entityResult.data?.entity) setEntity(entityResult.data.entity);
    }
    await refreshLineage(entity.id);
  };
  const handleDeleteSourceValue = async (attributeCode: string, sourceCode: string) => {
    if (!entity?.id) return;
    try {
      const sourceResult = await graphqlQuery<{ dataSource: { id: string } }, { code: string }>(DATA_SOURCE_QUERY, { code: sourceCode.toUpperCase() }, 'network-only');
      const sourceId = sourceResult.data?.dataSource?.id;
      if (!sourceId) throw new Error(`Source ${sourceCode} is not registered`);
      const result = await graphqlMutation<{ deleteCompetingSource: { success: boolean; errors: Array<{ message: string }> } }, { input: { entityId: string; attributeCode: string; sourceId: string; asOfDate: string } }>(
        DELETE_COMPETING_SOURCE_MUTATION,
        { input: { entityId: entity.id, attributeCode, sourceId, asOfDate } }
      );
      if (!result.data?.deleteCompetingSource?.success) throw new Error(result.data?.deleteCompetingSource?.errors?.[0]?.message || 'Delete failed');
      const lr = await graphqlQuery<{ fieldLineage: LineageData[] }, { entityId: string; asOfDate: string; knowledgeDate: string }>(FIELD_LINEAGE_QUERY, { entityId: entity.id, asOfDate, knowledgeDate }, 'network-only');
      if (lr.error || !lr.data?.fieldLineage) {
        setLineageData([]);
        setLineageLoaded(false);
      } else {
        setLineageData(lr.data.fieldLineage);
        setLineageLoaded(true);
      }
      await loadActivity(entity.id);
    } catch (err) { console.error('Failed to delete source value:', err); }
  };
  const handleRename = async (entityName: string) => {
    if (!entity) return;
    const result = await graphqlMutation<
      { updateEntity: { entity: { entityName: string } | null; errors: Array<{ message: string }> } },
      { input: { id: string; entityName: string } }
    >(UPDATE_ENTITY_MUTATION, { input: { id: entity.id, entityName } });
    const saveError = result.error?.message || result.data?.updateEntity?.errors?.[0]?.message;
    const savedName = result.data?.updateEntity?.entity?.entityName;
    if (saveError || !savedName) throw new Error(saveError || 'Could not save name');
    setEntity({ ...entity, entityName: savedName });
  };

  usePublishViewContext(entity ? entityViewFocus(entity) : null);

  if (loading) {
    return (
      <div className="view-fade">
        <div className="crumbs"><Link href="/" className="crumb-link">Home</Link><span className="sep">›</span><Link href="/positions" className="crumb-link">Positions</Link><span className="sep">›</span><span className="crumb-current">{id}</span></div>
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--ink-3)' }}>Loading position...</div>
      </div>
    );
  }
  if (error || !entity) {
    return (
      <div className="view-fade">
        <div className="crumbs"><Link href="/" className="crumb-link">Home</Link><span className="sep">›</span><Link href="/positions" className="crumb-link">Positions</Link><span className="sep">›</span><span className="crumb-current">Error</span></div>
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--red)' }}>{error || 'Position not found'}</div>
      </div>
    );
  }
  return (
    <div className="view-fade">
      <GoldenRecordHeader id={entity.entityCode} name={entity.entityName} type={entity.templateName || entity.domainName || 'Position'} status={entity.isActive ? 'Active' : 'Inactive'} lastReviewed={lastReviewedText} quality={qualityScore} conflicts={conflicts.length} entityPath={`/positions/${id}`} listPath="/positions" listLabel="Positions" accentColor={domainConfig.color} onRename={canRename ? handleRename : undefined} mergeHref={isMasterEntity ? `/merge?entity=${entity.id}` : undefined} />
      <div className="detail-layout">
        <div><GoldenRecordSections entity={entity} templateAttributes={templateAttributes} lineageData={lineageData} lineageLoaded={lineageLoaded} asOfDate={asOfDate} onAddAttribute={handleAddAttribute} onSourceChange={handleSourceChange} onValueChange={handleValueChange} onAddSourceValue={handleAddSourceValue} onDeleteSourceValue={handleDeleteSourceValue} /></div>
        <div><SourceContributionPanel sources={sourceContributions} /><ActiveConflictsPanel conflicts={conflicts} entityId={id} /><ActivityFeedPanel activities={activities} /></div>
      </div>
    </div>
  );
}


