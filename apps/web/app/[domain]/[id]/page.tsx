'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { graphqlQuery, graphqlMutation, ENTITY_QUERY, FIELD_LINEAGE_QUERY, ATTRIBUTE_REGISTER_QUERY, UPDATE_ENTITY_MUTATION, ADD_COMPETING_SOURCE_MUTATION, DATA_SOURCE_QUERY } from '@/lib/graphql';
import { GoldenRecordHeader } from '@/components/detail/GoldenRecordHeader';
import { GoldenRecordSections, type TemplateAttribute, type LineageData } from '@/components/detail/GoldenRecordSections';
import { SourceContributionPanel } from '@/components/detail/SourceContributionPanel';
import { ActiveConflictsPanel } from '@/components/detail/ActiveConflictsPanel';
import { ActivityFeedPanel } from '@/components/detail/ActivityFeedPanel';
import { EntityReports } from '@/components/reporting/EntityReports';
import { EntitySurfacePanel } from '@/components/surfaces/EntitySurfacePanel';
import { sources, type SourceKey } from '@/lib/data';
import { getDomainConfig, type DomainKey } from '@/lib/mock-data';
import { useTemporalStore } from '@/lib/store';
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
  const [templateAttributes, setTemplateAttributes] = useState<TemplateAttribute[]>([]);
  const asOfDate = useTemporalStore(state => state.asOfDate);

  // Compute derived data
  const conflicts: ConflictData[] = [];
  const sourceContributions: SourceContributionData[] = [];
  const activities: ActivityData[] = [];

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

    const sourceCounts = new Map<string, { name: string; count: number }>();
    lineageData.forEach((ld) => {
      ld.competingValues?.forEach((cv) => {
        const srcKey = typeof cv.source === 'string' ? cv.source.toLowerCase() : 'manual';
        const srcInfo = sources[srcKey as SourceKey] || sources.manual;
        const existing = sourceCounts.get(srcKey);
        if (existing) { existing.count++; }
        else { sourceCounts.set(srcKey, { name: srcInfo.name, count: 1 }); }
      });
    });

    const totalFields = lineageData.length || attrEntries.length || 1;
    sourceContributions.push(
      ...Array.from(sourceCounts.entries()).map(([key, val]) => ({
        source: key,
        sourceName: val.name,
        fieldCount: val.count,
        percentage: Math.round((val.count / totalFields) * 100),
        color: (sources[key as SourceKey] || sources.manual).hex,
      }))
    );

    lineageData.forEach((ld) => {
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

    if (entity.updatedAt) {
      activities.push({ who: 'System', time: entity.updatedAt, text: `Entity ${entity.entityCode} last updated` });
    }
    if (entity.createdAt) {
      activities.push({ who: 'System', time: entity.createdAt, text: `Entity ${entity.entityCode} created` });
    }

    lastReviewedText = entity.updatedAt
      ? `${Math.max(1, Math.floor((Date.now() - new Date(entity.updatedAt).getTime()) / 86400000))} days ago`
      : '—';
  }

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
            const lineageResult = await graphqlQuery<{ fieldLineage: LineageData[] }, { entityId: string; asOfDate: string }>(
              FIELD_LINEAGE_QUERY,
              { entityId: data.entity.id, asOfDate }
            );
            if (lineageResult.data?.fieldLineage) {
              setLineageData(lineageResult.data.fieldLineage);
            }
          }

          const entityDomainCode = data.entity.domainCode;
          const attrResult = await graphqlQuery<
            { attributeRegister: Array<{ attributeCode: string; attributeName: string; isRequired: boolean; displaySection: string; displayGroup: number; isVisible: boolean }> },
            { domainCode: string }
          >(
            ATTRIBUTE_REGISTER_QUERY,
            { domainCode: entityDomainCode }
          );
          if (attrResult.data?.attributeRegister) {
            const mappedAttributes: TemplateAttribute[] = attrResult.data.attributeRegister
              .filter((a) => a.isVisible !== false)
              .map((a) => ({
                attributeCode: a.attributeCode,
                attributeName: a.attributeName,
                required: a.isRequired || false,
                displaySection: a.displaySection || 'General',
                sortOrder: a.displayGroup || 0,
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
  }, [id, asOfDate]);

  const handleAddAttribute = async (attributeCode: string, value: string, source: SourceKey) => {
    if (!entity) return;
    const updatedAttributes = {
      ...entity.attributes,
      [attributeCode]: { value, source: sources[source]?.name || source, source_code: source.toUpperCase() },
    };
    try {
      await graphqlMutation(UPDATE_ENTITY_MUTATION, { input: { id: entity.id, attributes: updatedAttributes } });
      setEntity({ ...entity, attributes: updatedAttributes });
    } catch (err) { console.error('Failed to add attribute:', err); }
  };

  const handleSourceChange = async (attributeCode: string, newSource: SourceKey) => {
    if (!entity) return;
    const existingAttr = entity.attributes[attributeCode];
    const updatedAttributes = {
      ...entity.attributes,
      [attributeCode]: { ...(typeof existingAttr === 'object' ? existingAttr : { value: existingAttr }), source: sources[newSource]?.name || newSource, source_code: newSource.toUpperCase() },
    };
    try {
      await graphqlMutation(UPDATE_ENTITY_MUTATION, { input: { id: entity.id, attributes: updatedAttributes } });
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
      await graphqlMutation(UPDATE_ENTITY_MUTATION, { input: { id: entity.id, attributes: updatedAttributes } });
      setEntity({ ...entity, attributes: updatedAttributes });
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
      
      if (result.data?.addCompetingSource?.success) {
        // Refresh lineage data to show the new competing value (bypass cache)
        if (entity.id) {
          const lineageResult = await graphqlQuery<{ fieldLineage: LineageData[] }, { entityId: string; asOfDate: string }>(
            FIELD_LINEAGE_QUERY,
            { entityId: entity.id, asOfDate },
            'network-only'
          );
          if (lineageResult.data?.fieldLineage) {
            setLineageData(lineageResult.data.fieldLineage);
          }
        }
      } else {
        console.error('Failed to add competing source:', result.data?.addCompetingSource?.errors);
      }
    } catch (err) { 
      console.error('Failed to add source value:', err); 
    }
  };

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
      />

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
          />
        </div>

        <div>
          <SourceContributionPanel sources={sourceContributions} />
          <ActiveConflictsPanel conflicts={conflicts} entityId={id} />
          <ActivityFeedPanel activities={activities} />
        </div>
      </div>

      <EntitySurfacePanel entityId={entity.id} entityCode={entity.entityCode} />
      <EntityReports domainCode={entity.domainCode} entityId={entity.id} asOfDate={asOfDate} />
    </div>
  );
}

