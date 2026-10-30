'use client';

import Link from 'next/link';
import type { ColDef } from 'ag-grid-community';
import { AppGrid } from '@/components/grid/AppGrid';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ENTITIES_QUERY,
  OPEN_RECONCILIATION_RUN_MUTATION,
  RECONCILIATION_DEFINITIONS_QUERY,
  RECONCILIATION_RUNS_QUERY,
  graphqlMutation,
  graphqlQuery,
} from '@/lib/graphql';

interface Definition {
  id: string;
  definitionCode: string;
  definitionName: string;
  description: string | null;
  domainCode: string;
  compareMode: string;
  grain: string;
  stages: string[];
}

interface RunSummary {
  id: string;
  anchorEntityCode: string;
  anchorEntityName: string;
  domainCode: string;
  asOfDate: string;
  compareAsOfDate: string | null;
  status: string;
  openBreakCount: number;
  assignedTo: string | null;
  createdAt: string;
  definition: { definitionName: string };
}

interface EntityHit {
  id: string;
  entityCode: string;
  entityName: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function priorQuarter(asOf: string): string {
  const date = new Date(`${asOf}T00:00:00`);
  date.setMonth(date.getMonth() - 3);
  return date.toISOString().slice(0, 10);
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    EXCEPTIONS: 'Exception handling',
    REVIEW: 'Ready to approve',
    SENT_BACK: 'Sent back',
    APPROVED: 'Approved',
    OPEN: 'Open',
    ACCEPTED: 'Accepted',
    OVERRIDDEN: 'Override kept',
    WAIVED: 'Waived',
    MATCHED: 'Agreed',
  };
  return labels[status] || status;
}

const RUN_COLUMNS: ColDef<RunSummary>[] = [
  {
    colId: 'review',
    headerName: 'Review',
    flex: 1.2,
    minWidth: 160,
    valueGetter: (params) => params.data?.definition.definitionName || '',
    cellRenderer: (params: any) => <Link href={`/reconcile/${params.data.id}`}>{params.data.definition.definitionName}</Link>,
  },
  {
    colId: 'entity',
    headerName: 'Entity',
    flex: 1.2,
    minWidth: 160,
    valueGetter: (params) => params.data?.anchorEntityName || '',
    cellRenderer: (params: any) => <span>{params.data.anchorEntityName}<span className="recon-code">{params.data.anchorEntityCode}</span></span>,
  },
  {
    colId: 'asof',
    headerName: 'As of',
    minWidth: 180,
    valueGetter: (params) => {
      const asOf = String(params.data?.asOfDate || '').slice(0, 10);
      return params.data?.compareAsOfDate ? `${asOf} vs ${String(params.data.compareAsOfDate).slice(0, 10)}` : asOf;
    },
  },
  {
    field: 'status',
    headerName: 'Status',
    width: 160,
    cellRenderer: (params: any) => <span className={`recon-status status-${String(params.value).toLowerCase()}`}>{statusLabel(params.value)}</span>,
  },
  { field: 'openBreakCount', headerName: 'Open breaks', width: 140, filter: 'agNumberColumnFilter' },
];

export function ReconciliationHome() {
  const router = useRouter();
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<Definition | null>(null);
  const [query, setQuery] = useState('');
  const [entities, setEntities] = useState<EntityHit[]>([]);
  const [entityId, setEntityId] = useState('');
  const [asOfDate, setAsOfDate] = useState(today());
  const [compareAsOfDate, setCompareAsOfDate] = useState(priorQuarter(today()));
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      graphqlQuery<{ reconciliationDefinitions: Definition[] }>(RECONCILIATION_DEFINITIONS_QUERY, {}, 'network-only'),
      graphqlQuery<{ reconciliationRuns: RunSummary[] }>(RECONCILIATION_RUNS_QUERY, {}, 'network-only'),
    ]).then(([definitionsResult, runsResult]) => {
      if (cancelled) return;
      setDefinitions(definitionsResult.data?.reconciliationDefinitions || []);
      setRuns(runsResult.data?.reconciliationRuns || []);
      setError(definitionsResult.error?.message || runsResult.error?.message || '');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    const handle = window.setTimeout(() => {
      graphqlQuery<{ entities: { edges: Array<{ node: EntityHit }> } }>(ENTITIES_QUERY, {
        filter: { domainCode: selected.domainCode, entityName: query || undefined, isActive: true },
        pagination: { first: 12 },
      }, 'network-only').then((result) => {
        setEntities((result.data?.entities.edges || []).map((edge) => edge.node));
      });
    }, 200);
    return () => window.clearTimeout(handle);
  }, [selected, query]);

  const openReview = async () => {
    if (!selected || !entityId) return;
    setOpening(true);
    setError('');
    const needsPeriod = selected.compareMode !== 'SOURCE';
    const result = await graphqlMutation<{ openReconciliationRun: { run: { id: string } | null; errors: Array<{ message: string }> } }>(
      OPEN_RECONCILIATION_RUN_MUTATION,
      {
        input: {
          definitionCode: selected.definitionCode,
          entityId,
          asOfDate,
          compareAsOfDate: needsPeriod ? compareAsOfDate : null,
        },
      },
    );
    setOpening(false);
    const payload = result.data?.openReconciliationRun;
    if (payload?.run) {
      router.push(`/reconcile/${payload.run.id}`);
      return;
    }
    setError(payload?.errors?.[0]?.message || result.error?.message || 'Review could not be opened');
  };

  return (
    <div className="view-fade da">
      <div className="da-crumbs">
        <Link href="/">Home</Link>
        <span>/</span>
        <strong>Reconcile</strong>
      </div>
      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Review</span>
          <h1>Reconcile</h1>
          <p>Review one record against its sources and, when a prior date is set, against that earlier golden record.</p>
        </div>
        <div className="da-facts">
          <div className="da-fact big"><span>Reviews</span><strong>{loading ? '—' : definitions.length}</strong></div>
        </div>
        <div className="da-holdbox">
          <div className="da-holdtop"><span>Selected review</span><b>{selected ? 1 : 0}</b></div>
          <p>{selected ? selected.definitionName : 'Choose a review, then a record.'}</p>
        </div>
      </header>

      {error && <div className="recon-error">{error}</div>}
      {loading && <div className="page-meta">Loading reviews…</div>}

      <div className="recon-definitions">
        {definitions.map((definition) => (
          <button
            key={definition.id}
            type="button"
            className={`recon-definition ${selected?.id === definition.id ? 'selected' : ''}`}
            onClick={() => {
              setSelected(definition);
              setEntityId('');
              setQuery('');
            }}
          >
            <span className="recon-kicker">{definition.domainCode}</span>
            <strong>{definition.definitionName}</strong>
            <span>{definition.description}</span>
          </button>
        ))}
      </div>

      {selected && (
        <section className="recon-start">
          <h2>Open {selected.definitionName}</h2>
          <label>
            Find {selected.domainCode.toLowerCase()}
            <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name" />
          </label>
          <div className="recon-entity-list">
            {entities.map((entity) => (
              <button
                key={entity.id}
                type="button"
                className={entity.id === entityId ? 'selected' : ''}
                onClick={() => setEntityId(entity.id)}
              >
                <strong>{entity.entityName}</strong>
              </button>
            ))}
            {entities.length === 0 && <span className="page-meta">No matching entities.</span>}
          </div>
          <div className="recon-dates">
            <label>
              As of
              <input className="input" type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} />
            </label>
            {selected.compareMode !== 'SOURCE' && (
              <label>
                Compare to
                <input className="input" type="date" value={compareAsOfDate} onChange={(event) => setCompareAsOfDate(event.target.value)} />
              </label>
            )}
            <button type="button" className="btn btn-primary" disabled={!entityId || opening} onClick={openReview}>
              {opening ? 'Opening…' : 'Open review'}
            </button>
          </div>
        </section>
      )}

      <section className="recon-runs">
        <h2>Recent reviews</h2>
        <AppGrid
          rows={runs}
          columns={RUN_COLUMNS}
          getRowId={(row) => row.id}
          autoHeight
          loading={loading && runs.length === 0}
          emptyMessage="No reviews yet."
        />
      </section>
    </div>
  );
}
