'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ENTITIES_QUERY, graphqlQuery } from '@/lib/graphql';

interface FundRow {
  id: string;
  entityCode: string;
  entityName: string;
  description: string;
}

export default function FundSurfaceIndexPage() {
  const [funds, setFunds] = useState<FundRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    graphqlQuery<{ entities: { edges: Array<{ node: FundRow }> } }>(
      ENTITIES_QUERY,
      { filter: { domainCode: 'FUND', isActive: true }, pagination: { first: 200 } },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setError(result.error.message);
        setLoading(false);
        return;
      }
      const rows = (result.data?.entities.edges || []).map((edge) => edge.node);
      rows.sort((left, right) => left.entityName.localeCompare(right.entityName));
      setFunds(rows);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="view-fade da">
      <div className="da-crumbs">
        <Link href="/">Home</Link>
        <span>/</span>
        <strong>Fund surface</strong>
      </div>
      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Funds</span>
          <h1>Fund surface</h1>
          <p>NAV, pacing, capital activity, returns, liquidity, investors, and exposure.</p>
        </div>
        <div className="da-facts">
          <div className="da-fact big"><span>Funds</span><strong>{loading ? '—' : funds.length}</strong></div>
        </div>
        <div className="da-holdbox">
          <div className="da-holdtop"><span>Open a fund</span><b>{loading ? '—' : funds.length}</b></div>
          <p>Each row opens that fund’s statement, pacing, and exposure.</p>
        </div>
      </header>
      {error && <div className="xp-error">{error}</div>}
      {loading && <div className="xp-empty">Loading funds…</div>}
      {!loading && !error && funds.length === 0 && <div className="xp-empty">No funds yet.</div>}
      {!loading && funds.length > 0 && (
        <div className="da da-gridwrap">
          <table className="da-grid">
            <thead>
              <tr><th>Fund</th></tr>
            </thead>
            <tbody>
              {funds.map((fund) => (
                <tr key={fund.id}>
                  <td>
                    <b><Link href={`/funds/${fund.id}/overview`}>{fund.entityName}</Link></b>
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
