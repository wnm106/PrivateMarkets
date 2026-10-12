'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { RUN_DATA_QUERIES_QUERY, defaultParams, type DataQueryPayload, type DataQuerySpec, type ReportParameter } from '@/lib/reporting';
import { DashboardFrame } from './DashboardFrame';
import { ParameterBar } from './ParameterBar';
import { DataGrid } from './DataGrid';

interface DashboardRunnerProps {
  htmlTemplate: string;
  dataQueries: DataQuerySpec[];
  parameters: ReportParameter[];
  /** The entity being viewed (context for start=CONTEXT queries). */
  entityId?: string | null;
  asOfDate?: string;
  /** Called with query-level problems, useful for the designer. */
  onDiagnostics?: (d: { validationErrors: string[]; queryErrors: Record<string, string>; warnings: string[] }) => void;
}

/**
 * Executes a dashboard's data queries for the current entity + filter inputs and renders
 * the HTML. Re-queries whenever the entity, as-of date or any filter input changes.
 */
export function DashboardRunner({ htmlTemplate, dataQueries, parameters, entityId, asOfDate, onDiagnostics }: DashboardRunnerProps) {
  const [values, setValues] = useState<Record<string, any>>(() => defaultParams(parameters));
  const [payload, setPayload] = useState<DataQueryPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to defaults when the declared parameter set changes shape.
  const paramKey = useMemo(() => JSON.stringify((parameters || []).map((p) => [p.name, p.default])), [parameters]);
  useEffect(() => {
    setValues((prev) => ({ ...defaultParams(parameters), ...pickKnown(prev, parameters) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramKey]);

  // Queries flagged "grid" render as interactive host grids (server-side paging/grouping);
  // everything else is passed into the sandboxed HTML.
  const inlineQueries = useMemo(() => (dataQueries || []).filter((q) => !q.grid), [dataQueries]);
  const gridQueries = useMemo(() => (dataQueries || []).filter((q) => q.grid), [dataQueries]);
  const queriesKey = useMemo(() => JSON.stringify(inlineQueries), [inlineQueries]);
  const valuesKey = JSON.stringify(values);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const params = { ...values, ...(asOfDate ? { asOfDate } : {}) };
        const { data, error: qErr } = await graphqlQuery<{ runDataQueries: any }, any>(
          RUN_DATA_QUERIES_QUERY,
          { queries: JSON.parse(queriesKey), entityId: entityId || null, params, asOfDate: asOfDate || null },
          'network-only'
        );
        if (cancelled) return;
        if (qErr) throw new Error(qErr.message);
        const r = data?.runDataQueries;
        const queryErrors: Record<string, string> = {};
        Object.entries(r?.results || {}).forEach(([k, v]: [string, any]) => {
          if (v?.error) queryErrors[k] = v.error;
        });
        onDiagnostics?.({ validationErrors: r?.validationErrors || [], queryErrors, warnings: r?.warnings || [] });
        if (r?.validationErrors?.length) {
          setError(`Invalid data queries: ${r.validationErrors.join('; ')}`);
          setPayload(null);
        } else {
          setPayload({ entity: r?.anchor || null, data: r?.results || {}, params });
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Failed to load dashboard data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queriesKey, valuesKey, entityId, asOfDate]);

  const setParam = useCallback((name: string, value: any) => setValues((v) => ({ ...v, [name]: value })), []);

  return (
    <div>
      <ParameterBar parameters={parameters} values={values} onChange={setParam} />
      {error && (
        <div style={{ padding: '10px 14px', background: '#fdecec', color: '#b91c1c', fontSize: '12px', marginBottom: '8px' }}>{error}</div>
      )}
      <div style={{ position: 'relative', opacity: loading ? 0.6 : 1, transition: 'opacity 0.15s' }}>
        <DashboardFrame html={htmlTemplate} payload={payload} onSetParam={setParam} />
      </div>
      {gridQueries.map((q) => (
        <DataGrid key={q.key} spec={q} entityId={entityId} params={values} asOfDate={asOfDate} />
      ))}
    </div>
  );
}

function pickKnown(values: Record<string, any>, parameters: ReportParameter[]) {
  const names = new Set((parameters || []).map((p) => p.name));
  return Object.fromEntries(Object.entries(values).filter(([k]) => names.has(k)));
}
