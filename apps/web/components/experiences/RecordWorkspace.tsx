'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { ColDef } from 'ag-grid-community';
import Link from 'next/link';
import { AppGrid } from '@/components/grid/AppGrid';
import { graphqlMutation, graphqlQuery, CREATE_ENTITY_MUTATION, ENTITY_QUERY, UPDATE_ENTITY_MUTATION } from '@/lib/graphql';
import { domainHref } from '@/lib/domain-routes';
import { useTemporalStore } from '@/lib/store';
import type { EntityData } from '@/components/detail/types';
import { DashboardRunner } from '@/components/reporting/DashboardRunner';
import { AllocationBoard } from '@/components/allocation/AllocationBoard';
import type { DataQuerySpec, ReportParameter } from '@/lib/reporting';
import { AttributeValueInput } from '@/components/forms/AttributeValueInput';
import { useAttributeInspect } from '@/components/detail/AttributeInspect';
import {
  attributeText,
  fieldsForSection,
  groupFields,
  readOnlyField,
  RECORD_EXPERIENCE_QUERY,
  RECORD_EXPERIENCES_QUERY,
  relatedRefs,
  type CatalogAttribute,
  type ExperienceSection,
  type RecordExperience,
  type RelatedRef,
} from '@/lib/experience';

interface Catalog {
  attributes: CatalogAttribute[];
  assigned: Set<string>;
}

const CATALOG_QUERY = `
  query ExperienceCatalog($domainCode: String!) {
    attributeRegister(domainCode: $domainCode) {
      attributeCode
      attributeName
      dataType
      displaySection
      displayGroup
      isEditable
      isVisible
      isDerived
      domainCode
    }
    domainTemplates(domainCode: $domainCode) {
      attributes { attribute { attributeCode } }
    }
  }
`;

const DASHBOARD_QUERY = `
  query ExperienceDashboard($dashboardCode: String!) {
    dashboard(dashboardCode: $dashboardCode) {
      id
      dashboardCode
      dashboardName
      description
      htmlTemplate
      dataQueries
      parameters
    }
  }
`;

const CREATE_RELATIONSHIP_MUTATION = `
  mutation CreateExperienceRelationship($input: EntityRelationshipInput!) {
    createRelationship(input: $input) {
      relationship { relationshipCode }
      errors { message }
    }
  }
`;

interface DashboardView {
  id: string;
  dashboardCode: string;
  dashboardName: string;
  description?: string | null;
  htmlTemplate: string;
  dataQueries: unknown;
  parameters: unknown;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** A many-record relationship and a dashboard each occupy their own tab. A one-to-one form stays on the canvas unless the experience places it on a tab. */
function isOwnTab(section: ExperienceSection) {
  return section.kind === 'GRID' || section.kind === 'DASHBOARD' || section.kind === 'ALLOCATION' || section.placement === 'TAB';
}

export function RecordWorkspace({ experienceCode, entityId }: { experienceCode: string; entityId: string }) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [experience, setExperience] = useState<RecordExperience | null>(null);
  const [anchor, setAnchor] = useState<EntityData | null>(null);
  const [related, setRelated] = useState<Record<string, EntityData>>({});
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({});
  const [dashboards, setDashboards] = useState<Record<string, DashboardView | null>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadAnchor = useCallback(async () => {
    const result = await graphqlQuery<{ entity: EntityData | null }, { id: string; asOfDate: string; knowledgeDate: string }>(
      ENTITY_QUERY,
      { id: entityId, asOfDate, knowledgeDate },
      'network-only',
    );
    if (result.error) throw new Error(result.error.message || 'Could not load the record');
    if (!result.data?.entity) throw new Error('Record not found');
    return result.data.entity;
  }, [asOfDate, knowledgeDate, entityId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const [experienceResult, defaultsResult] = await Promise.all([
        graphqlQuery<{ recordExperience: RecordExperience | null }, { experienceCode: string }>(
          RECORD_EXPERIENCE_QUERY,
          { experienceCode },
          'network-only',
        ),
        graphqlQuery<{ recordExperiences: RecordExperience[] }, { isActive: boolean }>(
          RECORD_EXPERIENCES_QUERY,
          { isActive: true },
          'network-only',
        ),
      ]);
      if (cancelled) return;
      if (experienceResult.error || !experienceResult.data?.recordExperience) {
        setError(experienceResult.error?.message || 'This working view is not defined.');
        setLoading(false);
        return;
      }
      const nextDefaults: Record<string, string> = {};
      for (const item of defaultsResult.data?.recordExperiences || []) {
        if (item.isDefault) nextDefaults[item.anchorDomainCode] = item.experienceCode;
      }
      setDefaults(nextDefaults);
      setExperience(experienceResult.data.recordExperience);
      try {
        const entity = await loadAnchor();
        if (!cancelled) setAnchor(entity);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the record');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [experienceCode, loadAnchor]);

  const sections = experience?.sections || [];
  const canvas = useMemo(() => sections.filter((section) => !isOwnTab(section)), [sections]);
  const tabs = useMemo(() => sections.filter(isOwnTab), [sections]);
  const activeTab = tab ? tabs.find((section) => section.key === tab) || null : null;

  const domains = useMemo(() => {
    const codes = new Set<string>();
    for (const section of sections) {
      if (section.domainCode) codes.add(section.domainCode);
    }
    return Array.from(codes);
  }, [sections]);

  const requestedCatalogs = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    for (const domainCode of domains) {
      if (requestedCatalogs.current.has(domainCode)) continue;
      requestedCatalogs.current.add(domainCode);
      graphqlQuery<{
        attributeRegister: CatalogAttribute[];
        domainTemplates: Array<{ attributes: Array<{ attribute: { attributeCode: string } | null }> }>;
      }, { domainCode: string }>(CATALOG_QUERY, { domainCode }, 'network-only').then((result) => {
        if (cancelled || result.error) return;
        const assigned = new Set<string>();
        for (const template of result.data?.domainTemplates || []) {
          for (const row of template.attributes || []) {
            if (row.attribute?.attributeCode) assigned.add(row.attribute.attributeCode);
          }
        }
        setCatalogs((current) => ({
          ...current,
          [domainCode]: { attributes: result.data?.attributeRegister || [], assigned },
        }));
      });
    }
    return () => { cancelled = true; };
  }, [domains]);

  const dashboardCodes = useMemo(
    () => Array.from(new Set(sections.map((section) => section.dashboardCode).filter((code): code is string => Boolean(code)))),
    [sections],
  );

  const requestedDashboards = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    for (const dashboardCode of dashboardCodes) {
      if (requestedDashboards.current.has(dashboardCode)) continue;
      requestedDashboards.current.add(dashboardCode);
      graphqlQuery<{ dashboard: DashboardView | null }, { dashboardCode: string }>(
        DASHBOARD_QUERY,
        { dashboardCode },
        'network-only',
      ).then((result) => {
        if (cancelled) return;
        setDashboards((current) => ({ ...current, [dashboardCode]: result.data?.dashboard ?? null }));
      });
    }
    return () => { cancelled = true; };
  }, [dashboardCodes]);

  const relatedIds = useMemo(() => {
    if (!anchor) return [];
    const ids = new Set<string>();
    for (const section of sections) {
      if (!section.relationshipCode) continue;
      for (const ref of relatedRefs(anchor, section)) ids.add(ref.id);
    }
    return Array.from(ids);
  }, [anchor, sections]);

  const relatedKey = relatedIds.join(',');
  useEffect(() => {
    if (!relatedKey) return;
    let cancelled = false;
    const ids = relatedKey.split(',');
    Promise.all(ids.map((id) => graphqlQuery<{ entity: EntityData | null }, { id: string; asOfDate: string; knowledgeDate: string }>(
      ENTITY_QUERY,
      { id, asOfDate, knowledgeDate },
      'network-only',
    ))).then((results) => {
      if (cancelled) return;
      setRelated((current) => {
        const next = { ...current };
        results.forEach((result, index) => {
          const entity = result.data?.entity;
          if (entity) next[ids[index]] = entity;
        });
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [asOfDate, knowledgeDate, relatedKey]);

  const remember = (entity: EntityData) => {
    if (anchor && entity.id === anchor.id) setAnchor(entity);
    setRelated((current) => ({ ...current, [entity.id]: entity }));
  };

  const reloadEntity = async (id: string) => {
    const result = await graphqlQuery<{ entity: EntityData | null }, { id: string; asOfDate: string; knowledgeDate: string }>(
      ENTITY_QUERY,
      { id, asOfDate, knowledgeDate },
      'network-only',
    );
    if (result.data?.entity) remember(result.data.entity);
  };

  const saveAttribute = async (entity: EntityData, attributeCode: string, value: string) => {
    setSaveError(null);
    const result = await graphqlMutation<
      { updateEntity: { errors: Array<{ message: string }> } },
      { input: { id: string; attributes: Record<string, string> } }
    >(UPDATE_ENTITY_MUTATION, { input: { id: entity.id, attributes: { [attributeCode]: value }, asOfDate } });
    const message = result.error?.message || result.data?.updateEntity?.errors?.[0]?.message;
    if (message) {
      setSaveError(message);
      return;
    }
    const existing = entity.attributes?.[attributeCode];
    remember({
      ...entity,
      attributes: {
        ...entity.attributes,
        [attributeCode]: {
          ...(existing && typeof existing === 'object' ? existing : {}),
          value,
        },
      },
    });
  };

  const reloadAnchor = async () => {
    const entity = await loadAnchor();
    setAnchor(entity);
  };

  const linkRelated = async (section: ExperienceSection, otherId: string) => {
    if (!anchor || !section.relationshipCode) return;
    const up = (section.direction || 'DOWN').toUpperCase() === 'UP';
    setSaveError(null);
    const result = await graphqlMutation<
      { createRelationship: { errors: Array<{ message: string }> } },
      { input: Record<string, string | boolean> }
    >(CREATE_RELATIONSHIP_MUTATION, {
      input: {
        parentEntityId: up ? otherId : anchor.id,
        childEntityId: up ? anchor.id : otherId,
        relationshipType: section.relationshipCode,
        relationshipCode: section.relationshipCode,
        isPrimary: true,
        validFrom: asOfDate || today(),
      },
    });
    const message = result.error?.message || result.data?.createRelationship?.errors?.[0]?.message;
    if (message) {
      setSaveError(message);
      return;
    }
    await reloadAnchor();
  };

  const addRelated = async (section: ExperienceSection, name: string) => {
    if (!anchor || !section.domainCode || !section.relationshipCode) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const up = (section.direction || 'DOWN').toUpperCase() === 'UP';
    const code = `${section.domainCode.slice(0, 3)}-${Date.now().toString(36).toUpperCase()}`;
    const relationship = {
      parentEntityId: anchor.id,
      childEntityId: anchor.id,
      relationshipType: section.relationshipCode,
      relationshipCode: section.relationshipCode,
      isPrimary: false,
      validFrom: asOfDate || today(),
    };
    setSaveError(null);
    const result = await graphqlMutation<
      { createEntity: { entity: { id: string } | null; errors: Array<{ message: string }> } },
      { input: Record<string, unknown> }
    >(CREATE_ENTITY_MUTATION, {
      input: {
        entityCode: code,
        entityName: trimmed,
        domainCode: section.domainCode,
        templateCode: section.templateCode || `${section.domainCode}_STANDARD`,
        description: '',
        attributes: {},
        parentRelationships: up ? undefined : [relationship],
        childRelationships: up ? [relationship] : undefined,
      },
    });
    const message = result.error?.message || result.data?.createEntity?.errors?.[0]?.message;
    if (message || !result.data?.createEntity?.entity) {
      setSaveError(message || 'Could not add the related record');
      return;
    }
    await reloadAnchor();
  };

  if (loading) {
    return <div className="view-fade"><div className="xp-empty">Loading working view…</div></div>;
  }
  if (error || !experience || !anchor) {
    return <div className="view-fade"><div className="xp-empty">{error || 'Record not found'}</div></div>;
  }

  const recordHref = (ref: RelatedRef) => {
    const code = defaults[ref.domainCode];
    return code ? `/experiences/${code}/${ref.id}` : `${domainHref(ref.domainCode)}/${ref.id}`;
  };

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        {experience.pipeline ? (
          <Link href="/pipeline" className="crumb-link">Deal Pipeline</Link>
        ) : (
          <Link href={domainHref(anchor.domainCode)} className="crumb-link">{anchor.domainName}</Link>
        )}
        <span className="sep">›</span>
        <span className="crumb-current">{anchor.entityName}</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#047857' }} />
          <div>
            <div className="page-title">{anchor.entityName}</div>
            <div className="page-meta">{experience.experienceName} · {anchor.entityCode}</div>
          </div>
        </div>
        <div className="page-actions">
          {anchor.domainCode === 'DEAL' && (
            <Link href={`/deals/${anchor.id}/allocation`} className="btn btn-primary">Allocation</Link>
          )}
          {anchor.domainCode === 'FUND' && (
            <Link href={`/funds/${anchor.id}/overview`} className="btn btn-primary">Fund surface</Link>
          )}
          <Link href={`${domainHref(anchor.domainCode)}/${anchor.id}`} className="btn">Golden record</Link>
        </div>
      </div>

      {experience.description && <p className="xp-lead">{experience.description}</p>}
      {saveError && <div className="xp-error">{saveError}</div>}

      <div className="xp-tabs-wrap">
        <div className="xp-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={!activeTab}
            className={`xp-tab ${!activeTab ? 'active' : ''}`}
            onClick={() => setTab(null)}
          >
            {canvas.find((section) => !section.relationshipCode)?.title || anchor.domainName || 'Record'}
          </button>
          {tabs.map((section) => (
            <button
              key={section.key}
              type="button"
              role="tab"
              aria-selected={activeTab?.key === section.key}
              className={`xp-tab ${activeTab?.key === section.key ? 'active' : ''}`}
              onClick={() => setTab(section.key)}
            >
              {section.title}
              {section.kind === 'GRID' ? ` (${relatedRefs(anchor, section).length})` : ''}
            </button>
          ))}
        </div>
      </div>

      {!activeTab && (
        <div className="xp-canvas">
          {canvas.map((section) => (
            <SectionBody
              key={section.key}
              section={section}
              anchor={anchor}
              related={related}
              catalog={section.domainCode ? catalogs[section.domainCode] : undefined}
              dashboards={dashboards}
              asOfDate={asOfDate}
              recordHref={recordHref}
              onSave={saveAttribute}
              onReload={reloadEntity}
              onLink={linkRelated}
              onAdd={addRelated}
            />
          ))}
        </div>
      )}

      {activeTab && (
        <SectionBody
          section={activeTab}
          anchor={anchor}
          related={related}
          catalog={activeTab.domainCode ? catalogs[activeTab.domainCode] : undefined}
          dashboards={dashboards}
          asOfDate={asOfDate}
          recordHref={recordHref}
          onSave={saveAttribute}
          onReload={reloadEntity}
          onLink={linkRelated}
          onAdd={addRelated}
        />
      )}
    </div>
  );
}

function SectionBody({
  section,
  anchor,
  related,
  catalog,
  dashboards,
  asOfDate,
  recordHref,
  onSave,
  onReload,
  onLink,
  onAdd,
}: {
  section: ExperienceSection;
  anchor: EntityData;
  related: Record<string, EntityData>;
  catalog?: Catalog;
  dashboards: Record<string, DashboardView | null>;
  asOfDate?: string;
  recordHref: (ref: RelatedRef) => string;
  onSave: (entity: EntityData, attributeCode: string, value: string) => Promise<void>;
  onReload: (id: string) => Promise<void>;
  onLink: (section: ExperienceSection, otherId: string) => Promise<void>;
  onAdd: (section: ExperienceSection, name: string) => Promise<void>;
}) {
  const refs = relatedRefs(anchor, section);
  const fields = catalog && section.domainCode
    ? fieldsForSection(catalog.attributes, catalog.assigned, section.domainCode, section.columns || [])
    : [];

  if (section.kind === 'ALLOCATION') {
    return <AllocationBoard dealId={anchor.id} dealName={anchor.entityName} />;
  }

  if (section.kind === 'DASHBOARD') {
    const dashboard = section.dashboardCode ? dashboards[section.dashboardCode] : undefined;
    return (
      <section className="field-section xp-card">
        <div className="field-section-head">
          <div className="field-section-name">{section.title}</div>
        </div>
        {dashboard === undefined && <div className="xp-empty">Loading insight…</div>}
        {dashboard === null && (
          <div className="xp-empty">
            No dashboard named {section.dashboardCode}. Design one and set its code on this section.
          </div>
        )}
        {dashboard && (
          <>
            {dashboard.description && <p className="xp-lead">{dashboard.description}</p>}
            <DashboardRunner
              key={`${dashboard.id}-${anchor.id}`}
              htmlTemplate={dashboard.htmlTemplate}
              dataQueries={(dashboard.dataQueries || []) as DataQuerySpec[]}
              parameters={(Array.isArray(dashboard.parameters) ? dashboard.parameters : []) as ReportParameter[]}
              entityId={anchor.id}
              asOfDate={asOfDate}
            />
          </>
        )}
      </section>
    );
  }

  if (section.kind === 'GRID') {
    return (
      <ExperienceGrid
        section={section}
        refs={refs}
        fields={fields}
        related={related}
        recordHref={recordHref}
        onSave={onSave}
        onReload={onReload}
        onAdd={onAdd}
      />
    );
  }

  const targetRef = section.relationshipCode ? refs[0] : { id: anchor.id, code: anchor.entityCode, name: anchor.entityName, domainCode: anchor.domainCode };
  const target = section.relationshipCode ? (targetRef ? related[targetRef.id] : undefined) : anchor;

  return (
    <section className="field-section xp-card">
      <div className="field-section-head">
        <div className="field-section-name">{section.title}</div>
        <div className="field-section-count">
          {targetRef && section.relationshipCode ? (
            <Link href={recordHref(targetRef)} className="crumb-link">{targetRef.name}</Link>
          ) : (
            `${fields.length} attributes`
          )}
        </div>
      </div>
      {!catalog && section.domainCode && <div className="xp-empty">Loading attributes…</div>}
      {section.relationshipCode && refs.length === 0 && (
        <LinkPicker section={section} onLink={onLink} onAdd={onAdd} />
      )}
      {section.relationshipCode && refs.length > 0 && !target && <div className="xp-empty">Loading {section.title.toLowerCase()}…</div>}
      {target && groupFields(fields).map((group) => (
        <div key={group.section}>
          <div className="xp-group">{group.section}</div>
          {group.fields.map((field) => (
            <AttributeEditor
              key={field.attributeCode}
              entity={target}
              field={field}
              value={attributeText(target.attributes?.[field.attributeCode])}
              onSave={(value) => onSave(target, field.attributeCode, value)}
              onReload={onReload}
            />
          ))}
        </div>
      ))}
      {target && catalog && fields.length === 0 && <div className="xp-empty">No visible attributes for this entity yet. Add one to the attribute register and it will show up here.</div>}
    </section>
  );
}

function AttributeEditor({
  entity,
  field,
  value,
  onSave,
  onReload,
  hideLabel = false,
}: {
  entity: EntityData;
  field: CatalogAttribute;
  value: string;
  onSave: (value: string) => Promise<void>;
  onReload: (id: string) => Promise<void>;
  hideLabel?: boolean;
}) {
  const inspect = useAttributeInspect();
  const [draft, setDraft] = useState(value);
  const locked = readOnlyField(field);
  const boolean = (field.dataType || '').toUpperCase() === 'BOOLEAN';
  useEffect(() => { setDraft(value); }, [value]);

  const commit = (next: string) => {
    if (locked || next === value) return;
    void onSave(next);
  };

  const inspectSources = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    inspect.open({
      entityId: entity.id,
      entityName: entity.entityName,
      attributeCode: field.attributeCode,
      attributeName: field.attributeName,
      dataType: field.dataType || undefined,
      value: draft || value,
      domainCode: entity.domainCode,
      onChanged: () => { void onReload(entity.id); },
    });
  };

  const control = boolean ? (
    <input
      type="checkbox"
      aria-label={field.attributeName}
      checked={draft === 'true' || draft === 'TRUE' || draft === '1'}
      disabled={locked}
      onChange={(event) => {
        const next = event.target.checked ? 'true' : 'false';
        setDraft(next);
        commit(next);
      }}
    />
  ) : (
    <AttributeValueInput
      attributeCode={field.attributeCode}
      dataType={field.dataType}
      className="xp-input"
      value={draft}
      disabled={locked}
      ariaLabel={field.attributeName}
      placeholder={hideLabel ? '' : undefined}
      onChange={setDraft}
      onSelect={commit}
      onBlur={() => commit(draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );

  if (hideLabel) {
    return (
      <div className="xp-cell attr-inspectable" title="Right-click to view sources" onContextMenu={inspectSources}>
        {control}
      </div>
    );
  }

  return (
    <div className="xp-field attr-inspectable" title="Right-click to view sources" onContextMenu={inspectSources}>
      <span className="xp-field-label">
        {field.attributeName}
        {locked && <span className="xp-lock">Calculated</span>}
      </span>
      {control}
    </div>
  );
}

function ExperienceNameCell(props: any) {
  const ref = props.data as RelatedRef;
  return (
    <div>
      <Link href={props.context.get().recordHref(ref)} className="crumb-link">{ref.name}</Link>
      <div className="xp-code">{ref.code}</div>
    </div>
  );
}

function ExperienceFieldCell(props: any) {
  const field = props.field as CatalogAttribute;
  const entity = props.data.entity as EntityData | null;
  const actions = props.context.get();
  if (!entity) return <span className="xp-code">…</span>;
  return (
    <AttributeEditor
      entity={entity}
      field={field}
      hideLabel
      value={attributeText(entity.attributes?.[field.attributeCode])}
      onSave={(value) => actions.onSave(entity, field.attributeCode, value)}
      onReload={actions.onReload}
    />
  );
}

function ExperienceGrid({
  section,
  refs,
  fields,
  related,
  recordHref,
  onSave,
  onReload,
  onAdd,
}: {
  section: ExperienceSection;
  refs: RelatedRef[];
  fields: CatalogAttribute[];
  related: Record<string, EntityData>;
  recordHref: (ref: RelatedRef) => string;
  onSave: (entity: EntityData, attributeCode: string, value: string) => Promise<void>;
  onReload: (id: string) => Promise<void>;
  onAdd: (section: ExperienceSection, name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const actions = useRef({ recordHref, onSave, onReload });
  actions.current = { recordHref, onSave, onReload };
  const context = useMemo(() => ({ get: () => actions.current }), []);
  const columnDefs = useMemo<ColDef[]>(() => {
    const defs: ColDef[] = [{
      colId: 'name',
      headerName: 'Name',
      minWidth: 180,
      flex: 1,
      sortable: false,
      filter: false,
      autoHeight: true,
      cellRenderer: ExperienceNameCell,
    }];
    for (const field of fields) {
      defs.push({
        colId: field.attributeCode,
        headerName: field.attributeName,
        minWidth: 160,
        flex: 1,
        sortable: false,
        filter: false,
        autoHeight: true,
        cellRenderer: ExperienceFieldCell,
        cellRendererParams: { field },
      });
    }
    return defs;
  }, [fields]);
  const rowData = refs.map((ref) => ({ ...ref, entity: related[ref.id] || null }));
  return (
    <section className="field-section xp-card">
      <div className="field-section-head">
        <div className="field-section-name">{section.title}</div>
        <div className="field-section-count">{refs.length} records</div>
      </div>
      <div className="xp-grid-scroll">
        <AppGrid
          rows={rowData}
          columns={columnDefs}
          getRowId={(row) => row.id}
          autoHeight
          autoRowHeight
          enableSortFilter={false}
          context={context}
          emptyMessage="No related records yet."
        />
      </div>
      <form
        className="xp-add"
        onSubmit={async (event) => {
          event.preventDefault();
          setAdding(true);
          await onAdd(section, name);
          setName('');
          setAdding(false);
        }}
      >
        <input
          className="xp-input"
          value={name}
          placeholder={`Add to ${section.title}`}
          onChange={(event) => setName(event.target.value)}
          aria-label={`New ${section.title} name`}
        />
        <button className="btn btn-primary" type="submit" disabled={adding || !name.trim()}>Add</button>
      </form>
    </section>
  );
}

function LinkPicker({
  section,
  onLink,
  onAdd,
}: {
  section: ExperienceSection;
  onLink: (section: ExperienceSection, otherId: string) => Promise<void>;
  onAdd: (section: ExperienceSection, name: string) => Promise<void>;
}) {
  const [options, setOptions] = useState<Array<{ id: string; entityName: string; entityCode: string }>>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!section.domainCode) return;
    let cancelled = false;
    graphqlQuery<
      { entities: { edges: Array<{ node: { id: string; entityName: string; entityCode: string } }> } },
      { domainCode: string }
    >(
      `query LinkCandidates($domainCode: String!) {
        entities(filter: { domainCode: $domainCode, isActive: true }, pagination: { first: 50 }) {
          edges { node { id entityName entityCode } }
        }
      }`,
      { domainCode: section.domainCode },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      const rows = (result.data?.entities?.edges || []).map((edge) => edge.node);
      setOptions(rows);
      setSelected(rows[0]?.id || '');
    });
    return () => { cancelled = true; };
  }, [section.domainCode]);

  return (
    <div className="xp-link">
      <div className="xp-empty">No {section.title.toLowerCase()} is linked.</div>
      <div className="xp-add">
        <select className="xp-input" value={selected} onChange={(event) => setSelected(event.target.value)} aria-label={`Choose ${section.title}`}>
          {options.length === 0 && <option value="">No records yet</option>}
          {options.map((option) => (
            <option key={option.id} value={option.id}>{option.entityName}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          disabled={!selected || busy}
          onClick={async () => {
            setBusy(true);
            await onLink(section, selected);
            setBusy(false);
          }}
        >
          Link
        </button>
      </div>
      <form
        className="xp-add"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          await onAdd(section, name);
          setName('');
          setBusy(false);
        }}
      >
        <input className="xp-input" value={name} placeholder={`Or create a ${section.title.toLowerCase()}`} onChange={(event) => setName(event.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>Create</button>
      </form>
    </div>
  );
}
