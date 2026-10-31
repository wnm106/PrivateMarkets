'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  ADD_COMPETING_SOURCE_MUTATION,
  DATA_SOURCE_QUERY,
  DELETE_COMPETING_SOURCE_MUTATION,
  graphqlMutation,
  graphqlQuery,
} from '@/lib/graphql';
import { useTemporalStore } from '@/lib/store';
import type { SourceKey } from '@/lib/data';
import { AttributeSourcePanel } from './AttributeSourcePanel';
import { fieldFromLineage, type FieldData, type LineageField } from './attribute-source';

export interface AttributeInspectTarget {
  entityId: string;
  entityName?: string;
  attributeCode: string;
  attributeName: string;
  dataType?: string;
  /** Value from the grid that opened this drawer. The drawer shows the as-of lineage instead. */
  value?: string;
  domainCode?: string;
  onChanged?: () => void;
}

/** What the bottom drawer is showing. Add a kind here when another action should fill it. */
export type DetailDrawerView = {
  kind: 'attribute';
  target: AttributeInspectTarget;
};

interface DetailDrawerApi {
  view: DetailDrawerView | null;
  open: (view: DetailDrawerView) => void;
  close: () => void;
}

const DetailDrawerContext = createContext<DetailDrawerApi | null>(null);

export function useDetailDrawer(): DetailDrawerApi {
  const api = useContext(DetailDrawerContext);
  if (!api) return { view: null, open: () => undefined, close: () => undefined };
  return api;
}

export function useAttributeInspect() {
  const drawer = useDetailDrawer();
  const open = useCallback((target: AttributeInspectTarget) => {
    drawer.open({ kind: 'attribute', target });
  }, [drawer]);
  return { open };
}

export function AttributeInspectProvider({ children }: { children: React.ReactNode }) {
  const [view, setView] = useState<DetailDrawerView | null>(null);
  const open = useCallback((next: DetailDrawerView) => setView(next), []);
  const close = useCallback(() => setView(null), []);
  const api = useMemo(() => ({ view, open, close }), [view, open, close]);
  return (
    <DetailDrawerContext.Provider value={api}>
      {children}
    </DetailDrawerContext.Provider>
  );
}

/** Bottom dock. A flex sibling of the page, so opening it shortens the screen. */
export function DetailDrawer() {
  const { view, close } = useDetailDrawer();

  useEffect(() => {
    if (!view) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, close]);

  const title = view?.kind === 'attribute' ? view.target.attributeName : '';
  const subtitle = view?.kind === 'attribute'
    ? `${view.target.entityName || 'Record'}${view.target.attributeCode ? ` · ${view.target.attributeCode}` : ''}`
    : '';

  return (
    <section
      className={`detail-drawer${view ? ' open' : ''}`}
      aria-hidden={!view}
      inert={!view ? true : undefined}
      aria-label={title ? `${title} details` : 'Details'}
    >
      <div className="detail-drawer-sheet">
        <div className="attr-inspect-head">
          <div>
            <div className="attr-inspect-title">{title || 'Details'}</div>
            {subtitle && <div className="attr-inspect-sub">{subtitle}</div>}
          </div>
          <button type="button" className="sa-drill-close" onClick={close} aria-label="Close details">×</button>
        </div>
        <div className="detail-drawer-body">
          {view?.kind === 'attribute' && (
            <AttributeInspectBody key={`${view.target.entityId}:${view.target.attributeCode}`} target={view.target} />
          )}
        </div>
      </div>
    </section>
  );
}

const INSPECT_QUERY = `
  query InspectAttribute($entityId: ID!, $asOfDate: Date, $knowledgeDate: DateTime, $domainCode: String) {
    fieldLineage(entityId: $entityId, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      attributeCode
      attributeName
      currentValue
      competingValues {
        source
        sourceName
        value
        precedenceRank
        validFrom
        validTo
        confidenceScore
        receivedAt
      }
      resolutionRule
      lastUpdated
    }
    attributeRegister(domainCode: $domainCode) {
      attributeCode
      dataType
      isDerived
      derivationFormula
    }
  }
`;

function AttributeInspectBody({ target }: { target: AttributeInspectTarget }) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [field, setField] = useState<FieldData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    graphqlQuery<{
      fieldLineage: LineageField[];
      attributeRegister: Array<{ attributeCode: string; dataType?: string; isDerived?: boolean; derivationFormula?: string | null }>;
    }>(INSPECT_QUERY, {
      entityId: target.entityId,
      asOfDate,
      knowledgeDate,
      domainCode: target.domainCode || null,
    }, 'network-only').then((result) => {
      if (cancelled) return;
      if (result.error) {
        setError(result.error.message || 'Could not load this attribute.');
        setField(null);
        return;
      }
      const meta = (result.data?.attributeRegister || []).find((row) => row.attributeCode === target.attributeCode);
      const lineage = (result.data?.fieldLineage || []).find((row) => row.attributeCode === target.attributeCode);
      const calculated = Boolean(meta?.isDerived || meta?.derivationFormula);
      setField(fieldFromLineage(lineage, {
        label: target.attributeName,
        attributeCode: target.attributeCode,
        dataType: meta?.dataType || target.dataType,
        calculated,
        formula: calculated ? (meta?.derivationFormula || 'Calculated') : undefined,
      }));
    });
    return () => { cancelled = true; };
  }, [target, asOfDate, knowledgeDate, refreshKey]);

  const reload = () => {
    setRefreshKey((key) => key + 1);
    target.onChanged?.();
  };

  const addSource = async (attributeCode: string, source: SourceKey, value: string) => {
    const sourceCode = source.toUpperCase();
    const sourceResult = await graphqlQuery<{ dataSource: { id: string } }, { code: string }>(
      DATA_SOURCE_QUERY,
      { code: sourceCode },
      'network-only',
    );
    const sourceId = sourceResult.data?.dataSource?.id;
    if (!sourceId) throw new Error(`Source ${sourceCode} is not registered`);
    const result = await graphqlMutation<{ addCompetingSource: { success: boolean; errors: Array<{ message: string }> } }, { input: any }>(
      ADD_COMPETING_SOURCE_MUTATION,
      { input: { entityId: target.entityId, attributeCode, sourceId, value, validFrom: asOfDate } },
    );
    const message = result.error?.message || result.data?.addCompetingSource?.errors?.[0]?.message;
    if (message || !result.data?.addCompetingSource?.success) throw new Error(message || 'Could not save the value');
    reload();
  };

  const deleteSource = async (attributeCode: string, sourceCode: string) => {
    const sourceResult = await graphqlQuery<{ dataSource: { id: string } }, { code: string }>(
      DATA_SOURCE_QUERY,
      { code: sourceCode.toUpperCase() },
      'network-only',
    );
    const sourceId = sourceResult.data?.dataSource?.id;
    if (!sourceId) throw new Error(`Source ${sourceCode} is not registered`);
    const result = await graphqlMutation<{ deleteCompetingSource: { success: boolean; errors: Array<{ message: string }> } }, { input: { entityId: string; attributeCode: string; sourceId: string; asOfDate: string } }>(
      DELETE_COMPETING_SOURCE_MUTATION,
      { input: { entityId: target.entityId, attributeCode, sourceId, asOfDate } },
    );
    const message = result.error?.message || result.data?.deleteCompetingSource?.errors?.[0]?.message;
    if (message || !result.data?.deleteCompetingSource?.success) throw new Error(message || 'Delete failed');
    reload();
  };

  return (
    <>
      {error && <div className="attr-inspect-note">{error}</div>}
      {!error && !field && <div className="attr-inspect-note">Loading sources…</div>}
      {field && (
        <AttributeSourcePanel
          standalone
          field={field}
          entityId={target.entityId}
          asOfDate={asOfDate}
          calcRefreshKey={String(refreshKey)}
          onAddSourceValue={addSource}
          onDeleteSourceValue={deleteSource}
        />
      )}
    </>
  );
}
