'use client';

import Link from 'next/link';
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
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Reconcile</span>
      </div>
      <div className="page-header">
        <div>
          <div className="page-title">Reconcile</div>
          <div className="page-meta">Review one entity against its sources and, when a prior date is set, against that earlier golden record.</div>
        </div>
      </div>

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
                <span>{entity.entityCode}</span>
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
        <table className="data-table">
          <thead>
            <tr>
              <th>Review</th>
              <th>Entity</th>
              <th>As of</th>
              <th>Status</th>
              <th>Open breaks</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td><Link href={`/reconcile/${run.id}`}>{run.definition.definitionName}</Link></td>
                <td>{run.anchorEntityName}<span className="recon-code">{run.anchorEntityCode}</span></td>
                <td>{String(run.asOfDate).slice(0, 10)}{run.compareAsOfDate ? ` vs ${String(run.compareAsOfDate).slice(0, 10)}` : ''}</td>
                <td><span className={`recon-status status-${run.status.toLowerCase()}`}>{statusLabel(run.status)}</span></td>
                <td>{run.openBreakCount}</td>
              </tr>
            ))}
            {runs.length === 0 && !loading && (
              <tr><td colSpan={5}>No reviews yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
