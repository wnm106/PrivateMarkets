'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { graphqlMutation, graphqlQuery, UPDATE_ENTITY_MUTATION } from '@/lib/graphql';
import { attributeText } from '@/lib/experience';
import { domainHref } from '@/lib/domain-routes';
import { useTemporalStore } from '@/lib/store';

const WORKSTREAM: Record<string, string> = {
  LEGAL: 'Legal and documentation',
  DILIGENCE: 'Diligence and approvals',
  COMPLIANCE: 'Compliance and funding',
  AGENT: 'Agent and closing',
};

const OWNER: Record<string, string> = {
  COUNSEL: 'Counsel',
  DEAL_TEAM: 'Deal team',
  COMPLIANCE: 'Compliance',
  PORTFOLIO_MANAGER: 'Portfolio manager',
  FINANCE: 'Finance',
  AGENT: 'Agent',
};

const CONDITION_STATUS: Record<string, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  COMPLETE: 'Complete',
  BLOCKED: 'Blocked',
  WAIVED: 'Waived',
};

const DOCUMENT_STATUS: Record<string, string> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  EXECUTED: 'Executed',
};

const FUNDING_STATUS: Record<string, string> = {
  DRAFT: 'Draft',
  APPROVED: 'Approved',
  ISSUED: 'Issued',
  FUNDED: 'Funded',
};

const LINK_TAB: Record<string, string> = {
  CAPITAL: 'Capital structure',
  COMPLIANCE: 'Compliance',
  FUNDING: 'Funding',
};

interface Rel {
  childEntityId: string;
  childEntityName: string;
  relationshipCode: string;
}

interface Node {
  id: string;
  entityName: string;
  attributes: Record<string, unknown>;
  childRelationships: Rel[];
}

interface Condition {
  id: string;
  title: string;
  workstream: string;
  owner: string;
  due: string;
  status: string;
  link: string;
  order: number;
}

interface DocumentRow {
  id: string;
  title: string;
  parties: string;
  version: string;
  required: number;
  received: number;
  status: string;
  order: number;
}

interface FlowRow {
  id: string;
  fundId?: string;
  fundName: string;
  cash: number;
  line: number;
  call: number;
  status: string;
}

const BOOK = `
  query ClosingBook($asOfDate: Date, $knowledgeDate: DateTime) {
    conditions: entities(filter: { domainCode: "CLOSING_CONDITION", isActive: true }, pagination: { first: 500 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      edges { node { id entityName attributes childRelationships { childEntityId childEntityName relationshipCode } } }
    }
    documents: entities(filter: { domainCode: "DEAL_DOCUMENT", isActive: true }, pagination: { first: 300 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      edges { node { id entityName attributes childRelationships { childEntityId childEntityName relationshipCode } } }
    }
    plans: entities(filter: { domainCode: "DEAL_FUNDING_PLAN", isActive: true }, pagination: { first: 300 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      edges { node { id entityName attributes childRelationships { childEntityId childEntityName relationshipCode } } }
    }
  }
`;

function named(raw: unknown, labels: Record<string, string>): string {
  const text = attributeText(raw).trim();
  return labels[text] || text;
}

function codeOf(raw: unknown): string {
  return attributeText(raw).trim();
}

function amountOf(raw: unknown): number {
  const value = Number(attributeText(raw).replace(/[$,]/g, ''));
  return Number.isFinite(value) ? value : 0;
}

function child(node: Node, code: string): Rel | undefined {
  return node.childRelationships.find((rel) => rel.relationshipCode === code);
}

function dayNumber(value: string): number {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return NaN;
  return Date.UTC(year, month - 1, day);
}

function formatDay(value: string): string {
  const stamp = dayNumber(value);
  if (!Number.isFinite(stamp)) return value || '—';
  return new Date(stamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function daysBetween(later: string, earlier: string): number {
  const end = dayNumber(later);
  const start = dayNumber(earlier);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return 0;
  return Math.round((end - start) / 86_400_000);
}

function millions(amount: number): string {
  const value = amount / 1_000_000;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
}

function plain(amount: number): string {
  return (amount / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function settled(status: string): boolean {
  return status === 'COMPLETE' || status === 'WAIVED';
}

export function DealClosing({
  dealId,
  closeDate,
  onOpenTab,
}: {
  dealId: string;
  closeDate?: string | null;
  onOpenTab: (tab: 'capital' | 'compliance') => void;
}) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await graphqlQuery<{
      conditions: { edges: Array<{ node: Node }> };
      documents: { edges: Array<{ node: Node }> };
      plans: { edges: Array<{ node: Node }> };
    }>(BOOK, { asOfDate, knowledgeDate }, 'network-only');
    if (result.error?.message) {
      setError(result.error.message);
      setLoading(false);
      return;
    }
    const nextConditions = (result.data?.conditions.edges || [])
      .map((edge) => edge.node)
      .filter((node) => child(node, 'CONDITION_DEAL')?.childEntityId === dealId)
      .map((node): Condition => ({
        id: node.id,
        title: node.entityName,
        workstream: codeOf(node.attributes.CONDITION_WORKSTREAM),
        owner: codeOf(node.attributes.CONDITION_OWNER),
        due: codeOf(node.attributes.CONDITION_DUE_DATE).slice(0, 10),
        status: codeOf(node.attributes.CONDITION_STATUS) || 'OPEN',
        link: codeOf(node.attributes.CONDITION_LINK_TAB),
        order: amountOf(node.attributes.CONDITION_ORDER),
      }))
      .sort((a, b) => a.order - b.order);
    const nextDocuments = (result.data?.documents.edges || [])
      .map((edge) => edge.node)
      .filter((node) => child(node, 'DOC_DEAL')?.childEntityId === dealId)
      .map((node): DocumentRow => ({
        id: node.id,
        title: node.entityName,
        parties: codeOf(node.attributes.DOC_PARTIES),
        version: codeOf(node.attributes.DOC_VERSION) || 'Not started',
        required: amountOf(node.attributes.DOC_SIGNATURES_REQUIRED),
        received: amountOf(node.attributes.DOC_SIGNATURES_RECEIVED),
        status: codeOf(node.attributes.DOC_STATUS) || 'DRAFT',
        order: amountOf(node.attributes.DOC_ORDER),
      }))
      .sort((a, b) => a.order - b.order);
    const nextFlows = (result.data?.plans.edges || [])
      .map((edge) => edge.node)
      .filter((node) => child(node, 'FUNDING_DEAL')?.childEntityId === dealId)
      .map((node): FlowRow => {
        const fund = child(node, 'FUNDING_FUND');
        return {
          id: node.id,
          fundId: fund?.childEntityId,
          fundName: fund?.childEntityName || node.entityName,
          cash: amountOf(node.attributes.FUNDING_CASH_AMOUNT),
          line: amountOf(node.attributes.FUNDING_LINE_AMOUNT),
          call: amountOf(node.attributes.FUNDING_CALL_AMOUNT),
          status: codeOf(node.attributes.FUNDING_STATUS) || 'DRAFT',
        };
      })
      .sort((a, b) => a.fundName.localeCompare(b.fundName));
    setConditions(nextConditions);
    setDocuments(nextDocuments);
    setFlows(nextFlows);
    setLoading(false);
  }, [asOfDate, dealId, knowledgeDate]);

  useEffect(() => { void load(); }, [load]);

  const saveStatus = async (condition: Condition, status: string) => {
    const previous = condition.status;
    setConditions((rows) => rows.map((row) => (row.id === condition.id ? { ...row, status } : row)));
    setSavingId(condition.id);
    const result = await graphqlMutation<{ updateEntity: { errors: Array<{ message: string }> } }>(UPDATE_ENTITY_MUTATION, {
      input: { id: condition.id, attributes: { CONDITION_STATUS: status }, asOfDate },
    });
    const message = result.error?.message || result.data?.updateEntity.errors?.[0]?.message;
    setSavingId(null);
    if (message) {
      setConditions((rows) => rows.map((row) => (row.id === condition.id ? { ...row, status: previous } : row)));
      setError(message);
    }
  };

  const groups = useMemo(() => {
    const order = ['LEGAL', 'DILIGENCE', 'COMPLIANCE', 'AGENT'];
    const seen = new Map<string, Condition[]>();
    conditions.forEach((row) => {
      const list = seen.get(row.workstream) || [];
      list.push(row);
      seen.set(row.workstream, list);
    });
    return [...seen.keys()]
      .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
      .map((key) => ({ key, title: WORKSTREAM[key] || key, rows: seen.get(key) || [] }));
  }, [conditions]);

  const complete = conditions.filter((row) => settled(row.status)).length;
  const overdue = conditions.filter((row) => row.due && !settled(row.status) && daysBetween(asOfDate, row.due) > 0).length;
  const blocked = conditions.filter((row) => row.status === 'BLOCKED').length;
  const onTrack = overdue === 0 && blocked === 0;
  const funded = flows.reduce((sum, row) => sum + row.cash + row.line + row.call, 0);
  const flowStatus = flows.length && flows.every((row) => row.status === flows[0].status) ? flows[0].status : '';
  const away = closeDate ? daysBetween(closeDate, asOfDate) : null;
  const awayLabel = away === null
    ? ''
    : away > 1 ? `${away} days away`
      : away === 1 ? 'Tomorrow'
        : away === 0 ? 'Today'
          : away === -1 ? '1 day past'
            : `${Math.abs(away)} days past`;

  return (
    <div className="da">
      <section className="da-sec">
        <div className="da-sechead">
          <h2>Closing</h2>
          {!loading && conditions.length > 0 && (
            <span className={onTrack ? 'da-st ok' : blocked ? 'da-st breach' : 'da-st near'}>
              {onTrack ? 'On track' : blocked ? 'Blocked' : 'Overdue'}
            </span>
          )}
        </div>
        <div className="da-ribbon" style={{ marginTop: 12 }}>
          <div className="da-facts five">
            <div className="da-fact">
              <span>Target close</span>
              <strong>{closeDate ? formatDay(closeDate) : '—'}</strong>
              <small>{awayLabel}</small>
            </div>
            <div className="da-fact">
              <span>Conditions complete</span>
              <strong>{complete} of {conditions.length}</strong>
              <small>{conditions.length ? `${Math.round(complete / conditions.length * 100)}%` : '—'}</small>
            </div>
            <div className="da-fact">
              <span>Overdue</span>
              <strong>{overdue}</strong>
              <small>{overdue ? 'Past due' : 'None'}</small>
            </div>
            <div className="da-fact">
              <span>Blocked</span>
              <strong>{blocked}</strong>
              <small>{blocked ? 'Needs a decision' : 'None'}</small>
            </div>
            <div className="da-fact">
              <span>Funds flow</span>
              <strong>{millions(funded)}</strong>
              <small>{flowStatus ? FUNDING_STATUS[flowStatus] || flowStatus : '—'}</small>
            </div>
          </div>
        </div>
      </section>

      {error && <div className="xp-error">{error}</div>}
      {loading && <div className="xp-empty">Loading closing…</div>}
      {!loading && conditions.length === 0 && <div className="xp-empty">No closing checklist for this deal.</div>}

      {conditions.length > 0 && (
        <div className="da-gridwrap">
          <table className="da-grid">
            <thead>
              <tr>
                <th>Condition</th>
                <th>Owner</th>
                <th>Due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <Group
                  key={group.key}
                  title={group.title}
                  rows={group.rows}
                  savingId={savingId}
                  onOpenTab={onOpenTab}
                  onStatus={saveStatus}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {documents.length > 0 && (
        <section className="da-sec">
          <div className="da-sechead"><h2>Documents</h2></div>
          <div className="da-gridwrap">
            <table className="da-grid">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Parties</th>
                  <th>Version</th>
                  <th>Signatures</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((row) => {
                  const width = row.required ? Math.min(100, row.received / row.required * 100) : 0;
                  return (
                    <tr key={row.id}>
                      <td><Link href={`${domainHref('DEAL_DOCUMENT')}/${row.id}`}>{row.title}</Link></td>
                      <td>{row.parties}</td>
                      <td>{row.version}</td>
                      <td>
                        <span className="da-bar" style={{ width: 72, display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }}>
                          <i style={{ width: `${width}%` }} />
                        </span>
                        {row.received} of {row.required}
                      </td>
                      <td>{named(row.status, DOCUMENT_STATUS)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {flows.length > 0 && (
        <section className="da-sec">
          <div className="da-sechead"><h2>Funds flow</h2></div>
          <div className="da-gridwrap">
            <table className="da-grid">
              <thead>
                <tr>
                  <th>Portfolio</th>
                  <th className="num">Funded at close</th>
                  <th className="num">Cash</th>
                  <th className="num">Leverage line</th>
                  <th className="num">Capital call</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {flows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.fundId
                        ? <Link href={`${domainHref('FUND')}/${row.fundId}`}>{row.fundName}</Link>
                        : row.fundName}
                    </td>
                    <td className="num">{plain(row.cash + row.line + row.call)}</td>
                    <td className="num">{plain(row.cash)}</td>
                    <td className="num">{plain(row.line)}</td>
                    <td className="num">{plain(row.call)}</td>
                    <td>{named(row.status, FUNDING_STATUS)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{plain(funded)}</td>
                  <td className="num">{plain(flows.reduce((sum, row) => sum + row.cash, 0))}</td>
                  <td className="num">{plain(flows.reduce((sum, row) => sum + row.line, 0))}</td>
                  <td className="num">{plain(flows.reduce((sum, row) => sum + row.call, 0))}</td>
                  <td>{closeDate ? `Wire date ${formatDay(closeDate)}` : ''}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Group({
  title,
  rows,
  savingId,
  onOpenTab,
  onStatus,
}: {
  title: string;
  rows: Condition[];
  savingId: string | null;
  onOpenTab: (tab: 'capital' | 'compliance') => void;
  onStatus: (row: Condition, status: string) => void;
}) {
  return (
    <>
      <tr className="par">
        <td colSpan={4}><b>{title}</b></td>
      </tr>
      {rows.map((row) => (
        <tr key={row.id}>
          <td>
            <Link href={`${domainHref('CLOSING_CONDITION')}/${row.id}`}>{row.title}</Link>
            {row.link && LINK_TAB[row.link] && <small>Linked to {LINK_TAB[row.link]}</small>}
          </td>
          <td>{named(row.owner, OWNER)}</td>
          <td>{row.due ? formatDay(row.due) : '—'}</td>
          <td>
            {row.link ? (
              <span>
                {named(row.status, CONDITION_STATUS)}
                {row.link === 'FUNDING' ? (
                  <button type="button" className="btn btn-sm" disabled title="Not built yet" style={{ marginLeft: 8 }}>Funding</button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ marginLeft: 8 }}
                    onClick={() => onOpenTab(row.link === 'CAPITAL' ? 'capital' : 'compliance')}
                  >
                    {LINK_TAB[row.link]}
                  </button>
                )}
              </span>
            ) : (
              <select
                className="field-edit"
                aria-label={`Status for ${row.title}`}
                value={row.status}
                disabled={savingId === row.id}
                onChange={(event) => onStatus(row, event.target.value)}
              >
                {Object.entries(CONDITION_STATUS).map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}
