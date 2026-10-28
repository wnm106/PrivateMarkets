'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { graphqlQuery, graphqlMutation, ENTITY_QUERY, FIELD_LINEAGE_QUERY, ENTITY_ACTIVITY_QUERY, ATTRIBUTE_REGISTER_QUERY, UPDATE_ENTITY_MUTATION, ADD_COMPETING_SOURCE_MUTATION, DELETE_COMPETING_SOURCE_MUTATION, DATA_SOURCE_QUERY } from '@/lib/graphql';
import { GoldenRecordHeader } from '@/components/detail/GoldenRecordHeader';
import { GoldenRecordSections, type TemplateAttribute, type LineageData } from '@/components/detail/GoldenRecordSections';
import { SourceContributionPanel } from '@/components/detail/SourceContributionPanel';
import { ActiveConflictsPanel } from '@/components/detail/ActiveConflictsPanel';
import { ActivityFeedPanel } from '@/components/detail/ActivityFeedPanel';
import { sources, type SourceKey } from '@/lib/data';
import { getDomainConfig, type DomainKey } from '@/lib/mock-data';
import { useTemporalStore } from '@/lib/store';
import { entityViewFocus, usePublishViewContext } from '@/lib/view-context';
import { RECORD_EXPERIENCES_QUERY, type RecordExperience } from '@/lib/experience';
import type { EntityData, ConflictData, SourceContributionData, ActivityData } from '@/components/detail/types';

export default function DynamicEntityDetailPage() {
  const params = useParams();
  const domain = params.domain as DomainKey;
  const id = params.id as string;
  const domainConfig = getDomainConfig(domain);

  const [entity, setEntity] = useState<EntityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lineageData, setLineageData] = useState<LineageData[]>([]);
  const [lineageLoaded, setLineageLoaded] = useState(false);
  const [templateAttributes, setTemplateAttributes] = useState<TemplateAttribute[]>([]);
  const asOfDate = useTemporalStore(state => state.asOfDate);
  const knowledgeDate = useTemporalStore(state => state.knowledgeDate);

  // Compute derived data
  const [activities, setActivities] = useState<ActivityData[]>([]);
  const [workingView, setWorkingView] = useState<{ href: string; name: string } | null>(null);
  const conflicts: ConflictData[] = [];
  const sourceContributions: SourceContributionData[] = [];

  let qualityScore = 0;
  let lastReviewedText = '—';

  if (entity) {
    const attrs = entity.attributes || {};
    const assignedCodes = new Set(templateAttributes.map((attribute) => attribute.attributeCode));
    const attrEntries = Object.entries(attrs).filter(([key]) =>
      assignedCodes.size === 0 || assignedCodes.has(key)
    );
    const scopedLineage = lineageData.filter((lineage) =>
      assignedCodes.size === 0 || assignedCodes.has(lineage.attributeCode)
    );
    if (attrEntries.length > 0) {
      const filledCount = attrEntries.filter(([_, v]) => {
        const val = v && typeof v === 'object' && 'value' in v ? v.value : v;
        return val !== null && val !== undefined && val !== '';
      }).length;
      qualityScore = Math.round((filledCount / attrEntries.length) * 100);
    }

    const sourceCounts = new Map<string, { name: string; count: number; color: string }>();
    scopedLineage.forEach((ld) => {
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

    const totalFields = scopedLineage.length || attrEntries.length || 1;
    sourceContributions.push(
      ...Array.from(sourceCounts.entries()).map(([key, val]) => ({
        source: key,
        sourceName: val.name,
        fieldCount: val.count,
        percentage: Math.round((val.count / totalFields) * 100),
        color: val.color,
      }))
    );

    scopedLineage.forEach((ld) => {
      const distinctValues = new Set(
        (ld.competingValues || [])
          .filter((cv) => cv.value && cv.value !== '—' && cv.value !== '')
          .map((cv) => cv.value)
      );
      if (distinctValues.size > 1) {
        conflicts.push({
          field: ld.attributeName || ld.attributeCode,
          severity: distinctValues.size > 2 ? 'high' : 'med',
          description: `${distinctValues.size} sources disagree on ${ld.attributeName || ld.attributeCode}`,
        });
      }
    });

    lastReviewedText = entity.updatedAt
      ? `${Math.max(1, Math.floor((Date.now() - new Date(entity.updatedAt).getTime()) / 86400000))} days ago`
      : '—';
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
    const fetchEntity = async () => {
      setLoading(true);
      setError(null);

      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      const variables = isUUID ? { id, asOfDate } : { entityCode: id, asOfDate };

      try {
        const { data, error: queryError } = await graphqlQuery<{ entity: EntityData }, { id?: string; entityCode?: string; asOfDate: string }>(
          ENTITY_QUERY,
          variables
        );

        if (queryError) {
          setError(queryError.message || 'Failed to fetch entity');
        } else if (data?.entity) {
          setEntity(data.entity);

          if (data.entity.id) {
            const lineageResult = await graphqlQuery<{ fieldLineage: LineageData[] }, { entityId: string; asOfDate: string; knowledgeDate: string }>(
              FIELD_LINEAGE_QUERY,
              { entityId: data.entity.id, asOfDate, knowledgeDate }
            );
            if (lineageResult.error || !lineageResult.data?.fieldLineage) {
              setLineageData([]);
              setLineageLoaded(false);
            } else {
              setLineageData(lineageResult.data.fieldLineage);
              setLineageLoaded(true);
            }
            await loadActivity(data.entity.id);
          }

          const entityDomainCode = data.entity.domainCode;
          const attrResult = await graphqlQuery<
            { attributeRegister: Array<{ attributeCode: string; attributeName: string; dataType: string; isRequired: boolean; displaySection: string; displayGroup: number; isVisible: boolean; isDerived?: boolean; derivationFormula?: string | null }> },
            { domainCode: string }
          >(
            ATTRIBUTE_REGISTER_QUERY,
            { domainCode: entityDomainCode }
          );
          if (attrResult.data?.attributeRegister) {
            const mappedAttributes: TemplateAttribute[] = attrResult.data.attributeRegister
              .filter((a) => a.isVisible !== false)
              .              map((a) => ({
                attributeCode: a.attributeCode,
                attributeName: a.attributeName,
                dataType: a.dataType,
                required: a.isRequired || false,
                displaySection: a.displaySection || 'General',
                sortOrder: a.displayGroup || 0,
                isDerived: a.isDerived === true,
                derivationFormula: a.derivationFormula,
              }));
            setTemplateAttributes(mappedAttributes);
          }
        } else {
          setError('Entity not found');
        }
      } catch (err: any) {
        setError(err.message || 'Unexpected error');
      } finally {
        setLoading(false);
      }
    };

    if (id) {
      fetchEntity();
    }
  }, [id, asOfDate, knowledgeDate, loadActivity]);

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

  const refreshLineage = async (entityId: string) => {
    const lineageResult = await graphqlQuery<{ fieldLineage: LineageData[] }, { entityId: string; asOfDate: string; knowledgeDate: string }>(
      FIELD_LINEAGE_QUERY,
      { entityId, asOfDate, knowledgeDate },
      'network-only',
    );
    if (lineageResult.error || !lineageResult.data?.fieldLineage) {
      setLineageData([]);
      setLineageLoaded(false);
      return;
    }
    setLineageData(lineageResult.data.fieldLineage);
    setLineageLoaded(true);
    await loadActivity(entityId);
  };

  const handleAddAttribute = async (attributeCode: string, value: string, source: SourceKey) => {
    if (!entity) throw new Error('Record is still loading');
    const result = await graphqlMutation<{ updateEntity: { errors: Array<{ message: string }> } }, { input: { id: string; attributes: Record<string, string> } }>(
      UPDATE_ENTITY_MUTATION,
      { input: { id: entity.id, attributes: { [attributeCode]: value }, asOfDate } },
    );
    const saveError = result.error?.message || result.data?.updateEntity?.errors?.[0]?.message;
    if (saveError) throw new Error(saveError);
    setEntity({
      ...entity,
      attributes: {
        ...entity.attributes,
        [attributeCode]: { value, source: sources[source]?.name || source, source_code: source.toUpperCase() },
      },
    });
    await refreshLineage(entity.id);
  };

  const handleSourceChange = async (attributeCode: string, newSource: SourceKey) => {
    if (!entity) return;
    const existingAttr = entity.attributes[attributeCode];
    const updatedAttributes = {
      ...entity.attributes,
      [attributeCode]: { ...(typeof existingAttr === 'object' ? existingAttr : { value: existingAttr }), source: sources[newSource]?.name || newSource, source_code: newSource.toUpperCase() },
    };
    try {
      await graphqlMutation(UPDATE_ENTITY_MUTATION, { input: { id: entity.id, attributes: updatedAttributes, asOfDate } });
      setEntity({ ...entity, attributes: updatedAttributes });
    } catch (err) { console.error('Failed to update source:', err); }
  };

  const handleValueChange = async (attributeCode: string, newValue: string) => {
    if (!entity) return;
    const existingAttr = entity.attributes[attributeCode];
    const updatedAttributes = {
      ...entity.attributes,
      [attributeCode]: { ...(typeof existingAttr === 'object' ? existingAttr : { value: existingAttr }), value: newValue },
    };
    try {
      await graphqlMutation(UPDATE_ENTITY_MUTATION, { input: { id: entity.id, attributes: updatedAttributes, asOfDate } });
      setEntity({ ...entity, attributes: updatedAttributes });
      await loadActivity(entity.id);
    } catch (err) { console.error('Failed to update value:', err); }
  };

  const handleAddSourceValue = async (attributeCode: string, source: SourceKey, value: string) => {
    if (!entity) return;
    
    try {
      // Get the source ID from the database
      const sourceCode = source.toUpperCase();
      console.log('Looking up source:', sourceCode);
      const sourceResult = await graphqlQuery<{ dataSource: { id: string; sourceCode: string } }, { code: string }>(
        DATA_SOURCE_QUERY,
        { code: sourceCode },
        'network-only'
      );
      
      console.log('Source lookup result:', sourceResult);
      const sourceId = sourceResult.data?.dataSource?.id;
      
      if (!sourceId) {
        console.error(`Source ${sourceCode} not found in database.`);
        return;
      }

      // Call addCompetingSource mutation - use asOfDate so retroactive values are visible at that point in time
      console.log('Adding competing source value:', { entityId: entity.id, attributeCode, sourceId, sourceCode, value, validFrom: asOfDate });
      const result = await graphqlMutation<{ addCompetingSource: { success: boolean; attributeValueId: string; errors: any[] } }, { input: any }>(
        ADD_COMPETING_SOURCE_MUTATION,
        {
          input: {
            entityId: entity.id,
            attributeCode,
            sourceId,
            value,
            validFrom: asOfDate,
          },
        }
      );
      
      console.log('Add competing source result:', result);
      
      if (!result.data?.addCompetingSource?.success) {
        const message = result.data?.addCompetingSource?.errors?.[0]?.message || 'Could not save the value';
        throw new Error(message);
      }

      if (entity.id) {
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        const [entityResult, lineageResult] = await Promise.all([
          graphqlQuery<{ entity: EntityData }, { id?: string; entityCode?: string; asOfDate: string }>(
            ENTITY_QUERY,
            isUUID ? { id, asOfDate } : { entityCode: id, asOfDate },
            'network-only'
          ),
          graphqlQuery<{ fieldLineage: LineageData[] }, { entityId: string; asOfDate: string; knowledgeDate: string }>(
            FIELD_LINEAGE_QUERY,
            { entityId: entity.id, asOfDate, knowledgeDate },
            'network-only'
          ),
        ]);
        if (entityResult.data?.entity) setEntity(entityResult.data.entity);
        if (lineageResult.data?.fieldLineage) {
          setLineageData(lineageResult.data.fieldLineage);
          setLineageLoaded(true);
        }
        await loadActivity(entity.id);
      }
    } catch (err) {
      console.error('Failed to add source value:', err);
      throw err;
    }
  };

  const handleDeleteSourceValue = async (attributeCode: string, sourceCode: string) => {
    if (!entity) return;
    try {
      const sourceResult = await graphqlQuery<{ dataSource: { id: string } }, { code: string }>(
        DATA_SOURCE_QUERY,
        { code: sourceCode.toUpperCase() },
        'network-only'
      );
      const sourceId = sourceResult.data?.dataSource?.id;
      if (!sourceId) throw new Error(`Source ${sourceCode} is not registered`);

      const result = await graphqlMutation<{ deleteCompetingSource: { success: boolean; errors: Array<{ message: string }> } }, { input: { entityId: string; attributeCode: string; sourceId: string; asOfDate: string } }>(
        DELETE_COMPETING_SOURCE_MUTATION,
        { input: { entityId: entity.id, attributeCode, sourceId, asOfDate } }
      );
      const deleteError = result.error?.message || result.data?.deleteCompetingSource?.errors?.[0]?.message;
      if (deleteError || !result.data?.deleteCompetingSource?.success) throw new Error(deleteError || 'Delete failed');

      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      const [entityResult, lineageResult] = await Promise.all([
        graphqlQuery<{ entity: EntityData }, { id?: string; entityCode?: string; asOfDate: string }>(
          ENTITY_QUERY,
          isUUID ? { id, asOfDate } : { entityCode: id, asOfDate },
          'network-only'
        ),
        graphqlQuery<{ fieldLineage: LineageData[] }, { entityId: string; asOfDate: string; knowledgeDate: string }>(
          FIELD_LINEAGE_QUERY,
          { entityId: entity.id, asOfDate, knowledgeDate },
          'network-only'
        ),
      ]);
      if (entityResult.data?.entity) setEntity(entityResult.data.entity);
      if (lineageResult.error || !lineageResult.data?.fieldLineage) {
        setLineageData([]);
        setLineageLoaded(false);
      } else {
        setLineageData(lineageResult.data.fieldLineage);
        setLineageLoaded(true);
      }
      await loadActivity(entity.id);
    } catch (err) {
      console.error('Failed to delete source value:', err);
    }
  };

  usePublishViewContext(entity ? entityViewFocus(entity) : null);

  useEffect(() => {
    if (!entity?.id || !entity.domainCode) return;
    let cancelled = false;
    graphqlQuery<{ recordExperiences: RecordExperience[] }, { anchorDomainCode: string; isActive: boolean }>(
      RECORD_EXPERIENCES_QUERY,
      { anchorDomainCode: entity.domainCode, isActive: true },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      const match = (result.data?.recordExperiences || []).find((item) => item.isDefault)
        || result.data?.recordExperiences?.[0];
      setWorkingView(match ? { href: `/experiences/${match.experienceCode}/${entity.id}`, name: match.experienceName } : null);
    });
    return () => { cancelled = true; };
  }, [entity?.id, entity?.domainCode]);

  if (loading) {
    return (
      <div className="view-fade">
        <div className="crumbs">
          <Link href="/" className="crumb-link">Home</Link>
          <span className="sep">›</span>
          <Link href={`/${domain}`} className="crumb-link">{domainConfig.name}</Link>
          <span className="sep">›</span>
          <span className="crumb-current">{id}</span>
        </div>
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--ink-3)' }}>Loading entity...</div>
      </div>
    );
  }

  if (error || !entity) {
    return (
      <div className="view-fade">
        <div className="crumbs">
          <Link href="/" className="crumb-link">Home</Link>
          <span className="sep">›</span>
          <Link href={`/${domain}`} className="crumb-link">{domainConfig.name}</Link>
          <span className="sep">›</span>
          <span className="crumb-current">Error</span>
        </div>
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--red)' }}>{error || 'Entity not found'}</div>
      </div>
    );
  }

  return (
    <div className="view-fade">
      <GoldenRecordHeader
        id={entity.entityCode}
        name={entity.entityName}
        type={entity.templateName || entity.domainName || domainConfig.name.slice(0, -1)}
        status={entity.isActive ? 'Active' : 'Inactive'}
        lastReviewed={lastReviewedText}
        quality={qualityScore}
        conflicts={conflicts.length}
        entityPath={`/${domain}/${id}`}
        listPath={`/${domain}`}
        listLabel={domainConfig.name}
        accentColor={domainConfig.color}
        onRename={handleRename}
        mergeHref={`/merge?entity=${entity.id}`}
      />

      {workingView && (
        <div className="xp-jump">
          <Link href={workingView.href} className="btn btn-primary">Open {workingView.name}</Link>
        </div>
      )}

      <div className="detail-layout">
        <div>
          <GoldenRecordSections
            entity={entity}
            templateAttributes={templateAttributes}
            lineageData={lineageData}
            onAddAttribute={handleAddAttribute}
            onSourceChange={handleSourceChange}
            onValueChange={handleValueChange}
            onAddSourceValue={handleAddSourceValue}
            onDeleteSourceValue={handleDeleteSourceValue}
            asOfDate={asOfDate}
            lineageLoaded={lineageLoaded}
          />
        </div>

        <div>
          <SourceContributionPanel sources={sourceContributions} />
          <ActiveConflictsPanel conflicts={conflicts} entityId={id} />
          <ActivityFeedPanel activities={activities} />
        </div>
      </div>
    </div>
  );
}

