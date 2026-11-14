'use client';

import { useEffect, useState } from 'react';
import { defineSurface } from '@tapestrai/surface-sdk';
import { useSurfaceHost } from '@tapestrai/surface-sdk/react';
import { manifest } from './manifest';

interface FundRow {
  id: string;
  entityCode: string;
  entityName: string;
  description: string;
}

// The query lives with the surface: it depends only on the public GraphQL schema.
const FUNDS_QUERY = `
  query SurfaceFunds($filter: EntityFilter, $pagination: PaginationInput) {
    entities(filter: $filter, pagination: $pagination) {
      edges { node { id entityCode entityName description } }
    }
  }
`;

function FundIndex() {
  const host = useSurfaceHost();
  const [funds, setFunds] = useState<FundRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  host.useCrumbs([{ label: 'Fund surface' }]);

  useEffect(() => {
    let cancelled = false;
    host
      .query<{ entities: { edges: Array<{ node: FundRow }> } }>(
        FUNDS_QUERY,
        { filter: { domainCode: 'FUND', isActive: true }, pagination: { first: 200 } },
        'network-only',
      )
      .then((result) => {
        if (cancelled) return;
        if (result.error) {
          setError(result.error.message);
        } else {
          const rows = (result.data?.entities.edges || []).map((edge) => edge.node);
          rows.sort((a, b) => a.entityName.localeCompare(b.entityName));
          setFunds(rows);
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
    // The host object is stable for the life of the surface.
  }, []);

  return (
    <div className="view-fade da">
      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Funds</span>
          <h1>Fund surface</h1>
          <p>NAV, pacing, capital activity, returns, liquidity, investors, and exposure.</p>
        </div>
        <div className="da-facts">
          <div className="da-fact big"><span>Funds</span><strong>{loading ? '—' : funds.length}</strong></div>
        </div>
      </header>
      {error && <div className="xp-error">{error}</div>}
      {loading && <div className="xp-empty">Loading funds…</div>}
      {!loading && !error && funds.length === 0 && <div className="xp-empty">No funds yet.</div>}
      {!loading && funds.length > 0 && (
        <div className="da da-gridwrap">
          <table className="da-grid">
            <thead><tr><th>Fund</th></tr></thead>
            <tbody>
              {funds.map((fund) => (
                <tr key={fund.id}>
                  <td>
                    <b><a href={host.href(`/funds/${fund.id}/overview`)}>{fund.entityName}</a></b>
                    {fund.description && <small>{fund.description}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default defineSurface({ manifest, Component: FundIndex });
