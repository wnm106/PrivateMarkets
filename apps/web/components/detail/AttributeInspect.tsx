'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import { CopyTapFormula } from './CopyTapFormula';
import { fieldFromLineage, type FieldData, type LineageField } from './attribute-source';

export interface AttributeInspectTarget {
  entityId: string;
  /** The record's code, for the copied =TAP formula. Read from entityId when left out. */
  entityCode?: string;
  entityName?: string;
  attributeCode: string;
  attributeName: string;
  dataType?: string;
  /** Value from the grid that opened this panel. The panel shows the as-of lineage instead. */
  value?: string;
  domainCode?: string;
  /** Valid date to open, when the figure was read at a date other than the page as-of. */
  asOfDate?: string;
  /** Knowledge cutoff to open, when the figure was read at a cutoff other than the page's. */
  knowledgeDate?: string;
  onChanged?: () => void;
}

/** What the assistant's sources panel is showing. Add a kind here when another action should fill it. */
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
  const setChatOpen = useTemporalStore((state) => state.setChatOpen);
  const closeTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
  }, []);
  const open = useCallback((next: DetailDrawerView) => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setView(next);
    setChatOpen(true);
  }, [setChatOpen]);
  // Closing the details collapses the dock. The view stays until the width
  // animation has finished, so the conversation never shows underneath.
  const close = useCallback(() => {
    setChatOpen(false);
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setView(null);
    }, 420);
  }, [setChatOpen]);
  const api = useMemo(() => ({ view, open, close }), [view, open, close]);
  return (
    <DetailDrawerContext.Provider value={api}>
      {children}
    </DetailDrawerContext.Provider>
  );
}

/** Details for a right-clicked value. Fills the assistant dock on its own. */
export function AttributeInspectPanel() {
  const { view, close } = useDetailDrawer();
  const pageAsOf = useTemporalStore((state) => state.asOfDate);
  const pageKnowledge = useTemporalStore((state) => state.knowledgeDate);

  useEffect(() => {
    if (!view) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      close();
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
      className="chat-inspect"
      aria-hidden={!view}
      inert={!view ? true : undefined}
      aria-label={title ? `${title} sources` : 'Sources'}
    >
      <div className="chat-inspect-sheet">
        <div className="chat-inspect-head">
          <div className="chat-inspect-copy">
            <div className="chat-inspect-kicker">Sources</div>
            <div className="chat-inspect-title">{title || 'Sources'}</div>
            {subtitle && <div className="chat-inspect-sub">{subtitle}</div>}
          </div>
          {view?.kind === 'attribute' && (
            <CopyTapFormula
              className="chat-icon-btn"
              entityId={view.target.entityId}
              entityCode={view.target.entityCode}
              attributeCode={view.target.attributeCode}
              asOfDate={view.target.asOfDate || pageAsOf}
              knowledgeDate={view.target.knowledgeDate || pageKnowledge}
            />
          )}
          <button type="button" className="chat-icon-btn" onClick={close} aria-label="Close sources">
            ✕
          </button>
        </div>
        <div className="chat-inspect-body">
          {view?.kind === 'attribute' && (
            <AttributeInspectBody key={`${view.target.entityId}:${view.target.attributeCode}:${view.target.asOfDate || ''}:${view.target.knowledgeDate || ''}`} target={view.target} />
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
  const pageAsOf = useTemporalStore((state) => state.asOfDate);
  const pageKnowledge = useTemporalStore((state) => state.knowledgeDate);
  const asOfDate = target.asOfDate || pageAsOf;
  const knowledgeDate = target.knowledgeDate || pageKnowledge;
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
          knowledgeDate={knowledgeDate}
          calcRefreshKey={String(refreshKey)}
          onAddSourceValue={addSource}
          onDeleteSourceValue={deleteSource}
        />
      )}
    </>
  );
}
