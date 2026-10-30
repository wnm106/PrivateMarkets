'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import {
  CLEAR_MANUAL_OVERRIDE_MUTATION,
  CREATE_ENTITY_MUTATION,
  UPDATE_ENTITY_MUTATION,
  graphqlMutation,
  graphqlQuery,
} from '@/lib/graphql';
import { domainHref } from '@/lib/domain-routes';
import { useAttributeInspect } from '@/components/detail/AttributeInspect';
import { AttributeValueInput, listDisplayLabel, useAttributeListOptions } from '@/components/forms/AttributeValueInput';
import {
  couponYield,
  moneyMillions,
  recommendationText,
  seniorityLabel,
  trancheFullName,
  unfundedFootnote,
  type MemoTrancheFace,
} from '@tapestrai/graphql/src/lib/ic-memo-format';

const SECTIONS = [
  ['recommendation', 'Recommendation'],
  ['overview', 'Transaction overview'],
  ['sources', 'Sources and uses'],
  ['thesis', 'Investment thesis'],
  ['financials', 'Financial summary'],
  ['returns', 'Returns'],
  ['risks', 'Risks and mitigants'],
  ['allocation', 'Proposed allocation'],
  ['participation', 'Participation and limits'],
  ['approvals', 'Approvals'],
  ['items', 'Open items'],
] as const;

const STRATEGY: Record<string, string> = {
  DIRECT_LENDING: 'Direct Lending',
  OPPORTUNISTIC_CREDIT: 'Opportunistic Credit',
  ASSET_BASED_FINANCE: 'Asset-Based Finance',
  SPECIAL_SITUATIONS: 'Special Situations',
};

const STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', CIRCULATED: 'Circulated', APPROVED: 'Approved' };
const ROLE_LABEL: Record<string, string> = { CHAIR: 'Chair', MEMBER: 'Member', RISK: 'Risk' };
const DECISION_LABEL: Record<string, string> = { PENDING: 'Pending', APPROVED: 'Approved', DECLINED: 'Declined', ABSTAINED: 'Abstained' };
const DECISION_CYCLE = ['PENDING', 'APPROVED', 'DECLINED', 'ABSTAINED'];
const STATUS_CYCLE = ['DRAFT', 'CIRCULATED', 'APPROVED'];

interface MemoPoint { id: string; kind: string; title: string; body: string; sortOrder: number }
interface CapitalItem { id: string; side: string; label: string; amount: number; sortOrder: number }
interface Period {
  id: string; label: string; basis: string; sortOrder: number;
  revenue: number | null; ebitda: number | null; ebitdaMargin: number | null; freeCashFlow: number | null;
  fundedDebtToEbitda: number | null; ebitdaToCashInterest: number | null;
}
interface Approval { id: string; member: string; role: string; decision: string; decidedOn: string; sortOrder: number }
interface OpenItem { id: string; title: string; status: string; sortOrder: number }
interface TrancheYield { trancheId: string; grossYield: number | null; seniority: string }

interface MemoDoc {
  dealId: string;
  clientId: string;
  issuerId: string;
  memoStatus: string;
  team: string;
  icDate: string;
  sector: string;
  baseRate: number | null;
  holdYears: number | null;
  expectedMoic: number | null;
  blendedIrr: number | null;
  recommendation: string;
  points: MemoPoint[];
  capitalItems: CapitalItem[];
  periods: Period[];
  approvals: Approval[];
  openItems: OpenItem[];
  trancheYields: TrancheYield[];
  errors: Array<{ message: string }>;
}

export interface MemoTranche {
  id: string;
  name: string;
  label?: string | null;
  size: number;
  holdPct: number;
  unfunded: boolean;
  instrumentType: string;
  equityLinked?: boolean | null;
  pricing?: string | null;
  status?: string | null;
  securityId?: string | null;
}

export interface MemoPreview {
  dealName: string;
  strategy?: string | null;
  borrower?: string | null;
  borrowerId?: string | null;
  sponsor?: string | null;
  sponsorId?: string | null;
  pricing?: string | null;
  oid?: string | null;
  leverage?: string | null;
  maturity?: string | null;
  closeDate?: string | null;
  facilitySize: number;
  targetHold: number;
  allocated: number;
  unallocated: number;
  adjustments: Array<{ type: string }>;
  tranches: MemoTranche[];
  rows: Array<{
    fundId: string;
    fundName: string;
    level: string;
    total: number;
    cells: Array<{ trancheId: string; eligible: boolean; amount: number; exclusionText?: string | null; capReason?: string | null }>;
  }>;
}

const QUERY = `
  query IcMemo($dealId: ID!, $asOfDate: Date) {
    icMemo(dealId: $dealId, asOfDate: $asOfDate) {
      dealId clientId issuerId memoStatus team icDate sector
      baseRate holdYears expectedMoic blendedIrr recommendation
      points { id kind title body sortOrder }
      capitalItems { id side label amount sortOrder }
      periods { id label basis sortOrder revenue ebitda ebitdaMargin freeCashFlow fundedDebtToEbitda ebitdaToCashInterest }
      approvals { id member role decision decidedOn sortOrder }
      openItems { id title status sortOrder }
      trancheYields { trancheId grossYield seniority }
      errors { message }
    }
  }
`;

function day(value?: string | null, withDay = true): string {
  if (!value) return '';
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'short', day: withDay ? 'numeric' : undefined, year: 'numeric', timeZone: 'UTC',
  });
}

function plain(amount: number, digits = 1): string {
  return (amount / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function num(value: number | null | undefined, digits: number, suffix = ''): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`;
}

function nextCode(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

export function IcMemo({
  dealId,
  asOfDate,
  preview,
  onOpenCapital,
  onChanged,
}: {
  dealId: string;
  asOfDate: string;
  preview: MemoPreview | null;
  onOpenCapital: () => void;
  onChanged?: () => void;
}) {
  const [memo, setMemo] = useState<MemoDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string>(SECTIONS[0][0]);
  const [busy, setBusy] = useState(false);
  const inspect = useAttributeInspect();

  const load = useCallback(async () => {
    const result = await graphqlQuery<{ icMemo: MemoDoc }>(QUERY, { dealId, asOfDate }, 'network-only');
    const doc = result.data?.icMemo;
    const message = result.error?.message || doc?.errors?.[0]?.message;
    if (message || !doc) {
      setError(message || 'Could not load the memorandum');
      return;
    }
    setMemo(doc);
    setError(null);
  }, [asOfDate, dealId]);

  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  useEffect(() => {
    const nodes = SECTIONS
      .map(([id]) => document.getElementById(`icm-${id}`))
      .filter((node): node is HTMLElement => Boolean(node));
    if (!nodes.length) return undefined;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
      const id = visible?.target.id.replace('icm-', '');
      if (id) setActive(id);
    }, { rootMargin: '-12% 0px -68% 0px', threshold: 0.1 });
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [memo, preview]);

  const save = useCallback(async (entityId: string, attributes: Record<string, string>) => {
    setBusy(true);
    setError(null);
    const result = await graphqlMutation<{ updateEntity: { errors: Array<{ message: string }> } }>(UPDATE_ENTITY_MUTATION, {
      input: { id: entityId, attributes, asOfDate },
    });
    const message = result.error?.message || result.data?.updateEntity?.errors?.[0]?.message;
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    await refresh();
  }, [asOfDate, refresh]);

  const clearOverride = useCallback(async (entityId: string, attributeCode: string) => {
    setBusy(true);
    const result = await graphqlMutation<{ clearManualOverride: { errors: Array<{ message: string }> } }>(CLEAR_MANUAL_OVERRIDE_MUTATION, {
      input: { entityId, attributeCode, asOf: asOfDate },
    });
    setBusy(false);
    const message = result.error?.message || result.data?.clearManualOverride?.errors?.[0]?.message;
    if (message) setError(message);
    await refresh();
  }, [asOfDate, refresh]);

  const createLinked = useCallback(async (
    domainCode: string,
    templateCode: string,
    relationshipCode: string,
    relationshipType: string,
    childId: string,
    entityName: string,
    attributes: Record<string, string>,
  ) => {
    if (!memo?.clientId || !childId) {
      setError('This memorandum has no client or related record to attach to.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await graphqlMutation<{ createEntity: { errors: Array<{ message: string }> } }>(CREATE_ENTITY_MUTATION, {
      input: {
        entityCode: nextCode(domainCode),
        entityName,
        domainCode,
        templateCode,
        clientId: memo.clientId,
        attributes,
        childRelationships: [{
          parentEntityId: childId,
          childEntityId: childId,
          relationshipType,
          relationshipCode,
          isPrimary: true,
          validFrom: asOfDate.slice(0, 10),
        }],
      },
    });
    const message = result.error?.message || result.data?.createEntity?.errors?.[0]?.message;
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    await refresh();
  }, [asOfDate, refresh, memo?.clientId]);

  const retire = useCallback(async (entityId: string) => {
    setBusy(true);
    const result = await graphqlMutation<{ updateEntity: { errors: Array<{ message: string }> } }>(UPDATE_ENTITY_MUTATION, {
      input: { id: entityId, isActive: false },
    });
    setBusy(false);
    const message = result.error?.message || result.data?.updateEntity?.errors?.[0]?.message;
    if (message) setError(message);
    await refresh();
  }, [refresh]);

  const faces: MemoTrancheFace[] = preview?.tranches || [];
  const portfolios = (preview?.rows || []).filter((row) => row.level === 'PORTFOLIO');
  const placed = portfolios.filter((row) => row.total > 1000);
  const liveRecommendation = preview
    ? recommendationText({
      dealName: preview.dealName,
      facilitySize: preview.facilitySize,
      targetHold: preview.targetHold,
      unallocated: preview.unallocated,
      fundCount: placed.length,
      tranches: faces,
    })
    : '';
  const shownRecommendation = memo?.recommendation?.trim() || liveRecommendation;
  const yields = useMemo(() => new Map((memo?.trancheYields || []).map((row) => [row.trancheId, row])), [memo?.trancheYields]);
  const sources = (memo?.capitalItems || []).filter((item) => item.side === 'SOURCE');
  const uses = (memo?.capitalItems || []).filter((item) => item.side !== 'SOURCE');
  const thesis = (memo?.points || []).filter((point) => point.kind !== 'RISK');
  const risks = (memo?.points || []).filter((point) => point.kind === 'RISK');
  const ltm = memo?.periods.find((period) => period.basis === 'ACTUAL' || period.label === 'LTM') || memo?.periods[0];
  const holdPct = preview && preview.facilitySize ? Math.round(preview.targetHold / preview.facilitySize * 100) : null;
  const sourceTotal = sources.reduce((total, item) => total + item.amount, 0);
  const useTotal = uses.reduce((total, item) => total + item.amount, 0);
  const allocTotal = placed.reduce((total, row) => total + row.total, 0) || preview?.targetHold || 0;
  const blocked = portfolios.flatMap((row) => row.cells
    .filter((cell) => !cell.eligible)
    .map((cell) => ({ fund: row.fundName, trancheId: cell.trancheId, reason: cell.exclusionText || 'Not eligible' })));
  const capped = portfolios.some((row) => row.cells.some((cell) => cell.capReason));
  const footnote = unfundedFootnote(faces);
  const manual = (preview?.adjustments.length || 0) > 0;
  const dealName = preview?.dealName || 'Deal';
  const dealBind = (code: string, name: string): AttrBind => ({
    entityId: dealId, entityName: dealName, domainCode: 'DEAL', code, name,
  });
  const leverageParts = (preview?.leverage || '').split('/').map((part) => part.replace(/x/gi, '').trim());
  const changed = () => { void refresh(); };
  const openSources = (event: MouseEvent, bind: AttrBind, value: string) => {
    event.preventDefault();
    event.stopPropagation();
    inspect.open({
      entityId: bind.entityId,
      entityName: bind.entityName,
      attributeCode: bind.code,
      attributeName: bind.name,
      domainCode: bind.domainCode,
      value,
      onChanged: changed,
    });
  };

  const jump = (id: string) => {
    setActive(id);
    document.getElementById(`icm-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="icm">
      <nav className="icm-nav" aria-label="Memorandum sections">
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" className={active === id ? 'on' : ''} onClick={() => jump(id)}>{label}</button>
        ))}
      </nav>

      <article className="icm-paper">
        {error && <div className="xp-error">{error}</div>}
        <p className="icm-kicker">Investment committee memorandum</p>
        <h1>{preview?.dealName || 'Investment committee memorandum'}</h1>
        <p className="icm-meta">
          <AttrField
            bind={dealBind('DEAL_STRATEGY', 'Strategy')}
            value={preview?.strategy || ''}
            display={STRATEGY[preview?.strategy || ''] || preview?.strategy || 'Deal'}
            onCommit={(value) => save(dealId, { DEAL_STRATEGY: value })}
            onChanged={changed}
          />
          <button
            type="button"
            className="btn btn-sm attr-inspectable"
            title="Right-click to view sources"
            onClick={() => memo && save(dealId, { DEAL_MEMO_STATUS: STATUS_CYCLE[(STATUS_CYCLE.indexOf(memo.memoStatus) + 1) % STATUS_CYCLE.length] })}
            onContextMenu={(event) => openSources(event, dealBind('DEAL_MEMO_STATUS', 'IC Memo Status'), memo?.memoStatus || 'DRAFT')}
          >
            {STATUS_LABEL[memo?.memoStatus || 'DRAFT'] || memo?.memoStatus}
          </button>
          <span>
            IC targeted <AttrField bind={dealBind('DEAL_IC_DATE', 'IC Date')} value={memo?.icDate || ''} display={day(memo?.icDate) || 'set a date'} kind="date" onCommit={(value) => save(dealId, { DEAL_IC_DATE: value })} onChanged={changed} />
          </span>
          <span>
            Prepared by <AttrField bind={dealBind('DEAL_TEAM', 'Deal Team')} value={memo?.team || ''} display={memo?.team || 'name the deal team'} onCommit={(value) => save(dealId, { DEAL_TEAM: value })} onChanged={changed} />
          </span>
        </p>

        <section id="icm-recommendation">
          <div className="icm-rec">
            <strong>Recommendation. </strong>
            <AttrField
              bind={dealBind('DEAL_RECOMMENDATION', 'Recommendation')}
              value={memo?.recommendation || ''}
              editValue={shownRecommendation}
              display={shownRecommendation}
              multiline
              onCommit={(value) => save(dealId, { DEAL_RECOMMENDATION: value })}
              onChanged={changed}
            />
            {memo?.recommendation?.trim() && (
              <button type="button" className="btn btn-sm" onClick={() => { void clearOverride(dealId, 'DEAL_RECOMMENDATION'); }}>Use the live recommendation</button>
            )}
          </div>
        </section>

        <section id="icm-overview">
          <h2>Transaction overview</h2>
          <table className="icm-table icm-facts">
            <tbody>
              <tr>
                <th>Borrower</th>
                <td>{preview?.borrowerId ? <Link href={`${domainHref('ISSUER')}/${preview.borrowerId}`}>{preview.borrower}</Link> : preview?.borrower || '—'}</td>
                <th>Sponsor</th>
                <td>{preview?.sponsorId ? <Link href={`${domainHref('SPONSOR')}/${preview.sponsorId}`}>{preview.sponsor}</Link> : preview?.sponsor || '—'}</td>
              </tr>
              <tr>
                <th>Sector</th>
                <td><AttrField bind={dealBind('DEAL_SECTOR', 'Sector')} value={memo?.sector || ''} onCommit={(value) => save(dealId, { DEAL_SECTOR: value })} onChanged={changed} /></td>
                <th>Strategy</th>
                <td>
                  <AttrField
                    bind={dealBind('DEAL_STRATEGY', 'Strategy')}
                    value={preview?.strategy || ''}
                    display={STRATEGY[preview?.strategy || ''] || preview?.strategy || '—'}
                    onCommit={(value) => save(dealId, { DEAL_STRATEGY: value })}
                    onChanged={changed}
                  />
                </td>
              </tr>
              <tr>
                <th>Facility</th>
                <td>
                  {preview ? (
                    <AttrRead bind={dealBind('DEAL_FACILITY_SIZE', 'Facility Size')} value={String(preview.facilitySize)} onOpen={openSources}>
                      {moneyMillions(preview.facilitySize)}
                    </AttrRead>
                  ) : '—'}
                </td>
                <th>Our hold</th>
                <td>
                  {preview ? (
                    <AttrRead bind={dealBind('DEAL_TARGET_HOLD', 'Target Hold')} value={String(preview.targetHold)} onOpen={openSources}>
                      {`${moneyMillions(preview.targetHold)}${holdPct != null ? ` (${holdPct}%)` : ''}`}
                    </AttrRead>
                  ) : '—'}
                </td>
              </tr>
              <tr>
                <th>Pricing</th>
                <td><AttrField bind={dealBind('DEAL_PRICING_SUMMARY', 'Pricing Summary')} value={preview?.pricing || ''} onCommit={(value) => save(dealId, { DEAL_PRICING_SUMMARY: value })} onChanged={changed} /></td>
                <th>OID</th>
                <td><AttrField bind={dealBind('DEAL_OID_PRICE', 'OID Price')} value={preview?.oid || ''} kind="number" onCommit={(value) => save(dealId, { DEAL_OID_PRICE: value })} onChanged={changed} /></td>
              </tr>
              <tr>
                <th>Maturity</th>
                <td><AttrField bind={dealBind('DEAL_MATURITY_DATE', 'Maturity Date')} value={preview?.maturity || ''} display={day(preview?.maturity, false) || '—'} kind="date" onCommit={(value) => save(dealId, { DEAL_MATURITY_DATE: value })} onChanged={changed} /></td>
                <th>Target close</th>
                <td><AttrField bind={dealBind('DEAL_TARGET_CLOSE_DATE', 'Target Close Date')} value={preview?.closeDate || ''} display={day(preview?.closeDate) || '—'} kind="date" onCommit={(value) => save(dealId, { DEAL_TARGET_CLOSE_DATE: value })} onChanged={changed} /></td>
              </tr>
              <tr>
                <th>Leverage</th>
                <td>
                  <AttrField bind={dealBind('DEAL_LEVERAGE_SENIOR', 'Senior Leverage')} value={leverageParts[0] || ''} display={leverageParts[0] ? `${leverageParts[0]}x` : '—'} kind="number" onCommit={(value) => save(dealId, { DEAL_LEVERAGE_SENIOR: value })} onChanged={changed} />
                  <span> / </span>
                  <AttrField bind={dealBind('DEAL_LEVERAGE_TOTAL', 'Total Leverage')} value={leverageParts[1] || ''} display={leverageParts[1] ? `${leverageParts[1]}x` : '—'} kind="number" onCommit={(value) => save(dealId, { DEAL_LEVERAGE_TOTAL: value })} onChanged={changed} />
                </td>
                <th>Deal team</th>
                <td><AttrField bind={dealBind('DEAL_TEAM', 'Deal Team')} value={memo?.team || ''} onCommit={(value) => save(dealId, { DEAL_TEAM: value })} onChanged={changed} /></td>
              </tr>
            </tbody>
          </table>
          <table className="icm-table">
            <thead>
              <tr><th>Tranche</th><th>Seniority</th><th className="num">Size</th><th className="num">Our hold</th><th>Status</th></tr>
            </thead>
            <tbody>
              {(preview?.tranches || []).map((tranche) => {
                const holdAmount = tranche.size * tranche.holdPct / 100;
                const trancheBind = (code: string, name: string): AttrBind => ({
                  entityId: tranche.id, entityName: tranche.name, domainCode: 'DEAL_TRANCHE', code, name,
                });
                const seniority = yields.get(tranche.id)?.seniority || '';
                return (
                  <tr key={tranche.id}>
                    <td>
                      {tranche.securityId ? (
                        <AttrField
                          bind={{ entityId: tranche.securityId, entityName: tranche.name, domainCode: 'SECURITY', code: 'INSTRUMENT_TYPE', name: 'Instrument Type' }}
                          value={tranche.instrumentType}
                          display={trancheFullName(tranche.instrumentType, tranche.name)}
                          onCommit={(value) => save(tranche.securityId as string, { INSTRUMENT_TYPE: value })}
                          onChanged={changed}
                        />
                      ) : trancheFullName(tranche.instrumentType, tranche.name)}
                    </td>
                    <td>
                      <AttrField
                        bind={trancheBind('TRANCHE_SENIORITY', 'Seniority')}
                        value={seniority}
                        editValue={seniority || seniorityLabel(tranche)}
                        display={seniority || seniorityLabel(tranche)}
                        onCommit={(value) => save(tranche.id, { TRANCHE_SENIORITY: value })}
                        onChanged={changed}
                      />
                    </td>
                    <td className="num">
                      <AttrField
                        bind={trancheBind('TRANCHE_SIZE', 'Tranche Size')}
                        value={String(tranche.size)}
                        display={moneyMillions(tranche.size)}
                        kind="number"
                        scale={1_000_000}
                        onCommit={(value) => save(tranche.id, { TRANCHE_SIZE: value })}
                        onChanged={changed}
                      />
                    </td>
                    <td className="num">
                      <AttrRead bind={trancheBind('TRANCHE_HOLD_AMOUNT', 'Our Hold Amount')} value={String(holdAmount)} onOpen={openSources}>
                        {moneyMillions(holdAmount)}
                      </AttrRead>
                    </td>
                    <td>
                      <AttrField
                        bind={trancheBind('TRANCHE_IS_UNFUNDED', 'Unfunded at Close')}
                        value={tranche.unfunded ? 'true' : 'false'}
                        display={tranche.status || (tranche.unfunded ? 'Unfunded, drawn on demand' : tranche.equityLinked ? 'Issued at close' : 'Funded at close')}
                        choices={[
                          { value: 'false', label: tranche.equityLinked ? 'Issued at close' : 'Funded at close' },
                          { value: 'true', label: 'Unfunded, drawn on demand' },
                        ]}
                        onCommit={(value) => save(tranche.id, { TRANCHE_IS_UNFUNDED: value })}
                        onChanged={changed}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section id="icm-sources">
          <h2>Sources and uses</h2>
          <table className="icm-table">
            <thead>
              <tr><th>Sources</th><th className="num">$M</th><th>Uses</th><th className="num">$M</th></tr>
            </thead>
            <tbody>
              {Array.from({ length: Math.max(sources.length, uses.length, 1) }, (_, index) => {
                const source = sources[index];
                const useLine = uses[index];
                const bind = (item: CapitalItem, code: string, name: string): AttrBind => ({
                  entityId: item.id, entityName: item.label, domainCode: 'DEAL_CAPITAL_ITEM', code, name,
                });
                return (
                  <tr key={index}>
                    <td>{source && <AttrField bind={bind(source, 'CAPITAL_LABEL', 'Label')} value={source.label} onCommit={(value) => save(source.id, { CAPITAL_LABEL: value })} onChanged={changed} />}</td>
                    <td className="num">{source && <AttrField bind={bind(source, 'CAPITAL_AMOUNT', 'Amount')} value={String(source.amount)} display={plain(source.amount)} kind="number" scale={1_000_000} onCommit={(value) => save(source.id, { CAPITAL_AMOUNT: value })} onChanged={changed} />}</td>
                    <td>{useLine && <AttrField bind={bind(useLine, 'CAPITAL_LABEL', 'Label')} value={useLine.label} onCommit={(value) => save(useLine.id, { CAPITAL_LABEL: value })} onChanged={changed} />}</td>
                    <td className="num">{useLine && <AttrField bind={bind(useLine, 'CAPITAL_AMOUNT', 'Amount')} value={String(useLine.amount)} display={plain(useLine.amount)} kind="number" scale={1_000_000} onCommit={(value) => save(useLine.id, { CAPITAL_AMOUNT: value })} onChanged={changed} />}</td>
                  </tr>
                );
              })}
              <tr className="total">
                <td>Total sources</td><td className="num">{plain(sourceTotal)}</td>
                <td>Total uses</td><td className="num">{plain(useTotal)}</td>
              </tr>
            </tbody>
          </table>
          {footnote && <p className="icm-note">{footnote}</p>}
          <p className="icm-actions">
            <button type="button" className="btn btn-sm" onClick={() => createLinked('DEAL_CAPITAL_ITEM', 'DEAL_CAPITAL_ITEM_STANDARD', 'CAPITAL_ITEM_DEAL', 'Capital item on deal', dealId, 'Source', { CAPITAL_SIDE: 'SOURCE', CAPITAL_LABEL: 'New source', CAPITAL_AMOUNT: '0', CAPITAL_ORDER: String(sources.length + 1) })}>Add source</button>
            <button type="button" className="btn btn-sm" onClick={() => createLinked('DEAL_CAPITAL_ITEM', 'DEAL_CAPITAL_ITEM_STANDARD', 'CAPITAL_ITEM_DEAL', 'Capital item on deal', dealId, 'Use', { CAPITAL_SIDE: 'USE', CAPITAL_LABEL: 'New use', CAPITAL_AMOUNT: '0', CAPITAL_ORDER: String(uses.length + 1) })}>Add use</button>
          </p>
        </section>

        <section id="icm-thesis">
          <h2>Investment thesis</h2>
          <ul className="icm-bullets">
            {thesis.map((point) => (
              <li key={point.id}>
                <AttrField
                  bind={{ entityId: point.id, entityName: 'Thesis', domainCode: 'DEAL_MEMO_POINT', code: 'MEMO_POINT_BODY', name: 'Body' }}
                  value={point.body}
                  onCommit={(value) => save(point.id, { MEMO_POINT_BODY: value })}
                  onChanged={changed}
                />
                <button type="button" className="btn btn-sm" onClick={() => { void retire(point.id); }}>Remove</button>
              </li>
            ))}
          </ul>
          {thesis.length === 0 && <p className="icm-note">No thesis points yet.</p>}
          <button type="button" className="btn btn-sm" onClick={() => createLinked('DEAL_MEMO_POINT', 'DEAL_MEMO_POINT_STANDARD', 'MEMO_POINT_DEAL', 'Memo point on deal', dealId, 'Thesis point', { MEMO_POINT_KIND: 'THESIS', MEMO_POINT_BODY: 'New thesis point', MEMO_POINT_ORDER: String(thesis.length + 1) })}>Add a point</button>
        </section>

        <section id="icm-financials">
          <h2>Financial summary</h2>
          {ltm && (
            <p>
              {preview?.borrower || 'The borrower'} operates in {(memo?.sector || 'its sector').toLowerCase()}, with LTM revenue of {moneyMillions(ltm.revenue || 0)} and EBITDA of {moneyMillions(ltm.ebitda || 0)} ({Math.round(ltm.ebitdaMargin || 0)}% margin).
            </p>
          )}
          <table className="icm-table">
            <thead>
              <tr>
                <th>$M</th>
                {(memo?.periods || []).map((period) => (
                  <th key={period.id} className="num">
                    <AttrField
                      bind={{ entityId: period.id, entityName: period.label, domainCode: 'FINANCIAL_PERIOD', code: 'PERIOD_LABEL', name: 'Period' }}
                      value={period.label}
                      onCommit={(value) => save(period.id, { PERIOD_LABEL: value })}
                      onChanged={changed}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <MetricRow label="Revenue" periods={memo?.periods || []} field="revenue" digits={1} scale={1_000_000} onSave={save} onChanged={changed} />
              <MetricRow label="EBITDA" periods={memo?.periods || []} field="ebitda" digits={1} scale={1_000_000} onSave={save} onChanged={changed} />
              <MetricRow label="EBITDA margin" periods={memo?.periods || []} field="ebitdaMargin" digits={1} suffix="%" onSave={save} onChanged={changed} />
              <MetricRow label="Free cash flow after interest" periods={memo?.periods || []} field="freeCashFlow" digits={1} scale={1_000_000} onSave={save} onChanged={changed} />
              <MetricRow label="Funded debt to EBITDA" periods={memo?.periods || []} field="fundedDebtToEbitda" digits={1} suffix="x" onSave={save} onChanged={changed} />
              <MetricRow label="EBITDA to cash interest" periods={memo?.periods || []} field="ebitdaToCashInterest" digits={1} suffix="x" onSave={save} onChanged={changed} />
            </tbody>
          </table>
          {memo?.issuerId && (
            <button type="button" className="btn btn-sm" onClick={() => createLinked('FINANCIAL_PERIOD', 'FINANCIAL_PERIOD_STANDARD', 'PERIOD_ISSUER', 'Financial period of issuer', memo.issuerId, 'Financial period', { PERIOD_LABEL: 'New', PERIOD_BASIS: 'ESTIMATE', PERIOD_ORDER: String((memo.periods.length || 0) + 1), PERIOD_REVENUE: '0', PERIOD_EBITDA: '0' })}>Add a period</button>
          )}
        </section>

        <section id="icm-returns">
          <h2>Returns</h2>
          <table className="icm-table">
            <thead><tr><th>Tranche</th><th>Terms</th><th className="num">Gross yield</th></tr></thead>
            <tbody>
              {(preview?.tranches || []).filter((tranche) => !tranche.equityLinked).map((tranche) => {
                const stored = yields.get(tranche.id)?.grossYield;
                const computed = couponYield(tranche.pricing, memo?.baseRate);
                const yieldValue = stored ?? computed;
                const trancheBind = (code: string, name: string): AttrBind => ({
                  entityId: tranche.id, entityName: tranche.name, domainCode: 'DEAL_TRANCHE', code, name,
                });
                return (
                  <tr key={tranche.id}>
                    <td>
                      {tranche.securityId ? (
                        <AttrField
                          bind={{ entityId: tranche.securityId, entityName: tranche.name, domainCode: 'SECURITY', code: 'INSTRUMENT_TYPE', name: 'Instrument Type' }}
                          value={tranche.instrumentType}
                          display={trancheFullName(tranche.instrumentType, tranche.label || tranche.name)}
                          onCommit={(value) => save(tranche.securityId as string, { INSTRUMENT_TYPE: value })}
                          onChanged={changed}
                        />
                      ) : trancheFullName(tranche.instrumentType, tranche.label || tranche.name)}
                    </td>
                    <td>
                      <AttrField
                        bind={trancheBind('TRANCHE_PRICING', 'Pricing')}
                        value={tranche.pricing || ''}
                        onCommit={(value) => save(tranche.id, { TRANCHE_PRICING: value })}
                        onChanged={changed}
                      />
                    </td>
                    <td className="num">
                      <AttrField
                        bind={trancheBind('TRANCHE_GROSS_YIELD', 'Gross Yield')}
                        value={stored == null ? '' : String(stored)}
                        editValue={yieldValue == null ? '' : String(yieldValue)}
                        display={yieldValue == null ? '—' : `${yieldValue.toFixed(1)}%`}
                        kind="number"
                        onCommit={(value) => save(tranche.id, { TRANCHE_GROSS_YIELD: value })}
                        onChanged={changed}
                      />
                    </td>
                  </tr>
                );
              })}
              <tr className="total">
                <td>Blended gross IRR ({memo?.holdYears || 3}-year)</td>
                <td>Includes OID amortization</td>
                <td className="num">
                  <AttrField bind={dealBind('DEAL_BLENDED_GROSS_IRR', 'Blended Gross IRR')} value={memo?.blendedIrr == null ? '' : String(memo.blendedIrr)} display={memo?.blendedIrr == null ? '—' : `${memo.blendedIrr.toFixed(1)}%`} kind="number" onCommit={(value) => save(dealId, { DEAL_BLENDED_GROSS_IRR: value })} onChanged={changed} />
                </td>
              </tr>
            </tbody>
          </table>
          <p className="icm-note">
            Expected gross MOIC of <AttrField bind={dealBind('DEAL_EXPECTED_MOIC', 'Expected MOIC')} value={memo?.expectedMoic == null ? '' : String(memo.expectedMoic)} display={memo?.expectedMoic == null ? '—' : `${memo.expectedMoic.toFixed(2)}x`} kind="number" onCommit={(value) => save(dealId, { DEAL_EXPECTED_MOIC: value })} onChanged={changed} /> over a <AttrField bind={dealBind('DEAL_HOLD_YEARS', 'Hold Years')} value={memo?.holdYears == null ? '' : String(memo.holdYears)} display={memo?.holdYears == null ? '—' : `${memo.holdYears}-year`} kind="number" onCommit={(value) => save(dealId, { DEAL_HOLD_YEARS: value })} onChanged={changed} /> hold. Base rate assumed at <AttrField bind={dealBind('DEAL_BASE_RATE', 'Base Rate Assumption')} value={memo?.baseRate == null ? '' : String(memo.baseRate)} display={memo?.baseRate == null ? '—' : `${memo.baseRate.toFixed(2)}%`} kind="number" onCommit={(value) => save(dealId, { DEAL_BASE_RATE: value })} onChanged={changed} />.
          </p>
        </section>

        <section id="icm-risks">
          <h2>Risks and mitigants</h2>
          <table className="icm-table">
            <thead><tr><th>Risk</th><th>Mitigant</th></tr></thead>
            <tbody>
              {risks.map((point) => (
                <tr key={point.id}>
                  <td>
                    <AttrField
                      bind={{ entityId: point.id, entityName: point.title || 'Risk', domainCode: 'DEAL_MEMO_POINT', code: 'MEMO_POINT_TITLE', name: 'Title' }}
                      value={point.title}
                      onCommit={(value) => save(point.id, { MEMO_POINT_TITLE: value })}
                      onChanged={changed}
                    />
                  </td>
                  <td className="icm-split">
                    <AttrField
                      bind={{ entityId: point.id, entityName: point.title || 'Risk', domainCode: 'DEAL_MEMO_POINT', code: 'MEMO_POINT_BODY', name: 'Body' }}
                      value={point.body}
                      onCommit={(value) => save(point.id, { MEMO_POINT_BODY: value })}
                      onChanged={changed}
                    />
                    <button type="button" className="btn btn-sm" onClick={() => { void retire(point.id); }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-sm" onClick={() => createLinked('DEAL_MEMO_POINT', 'DEAL_MEMO_POINT_STANDARD', 'MEMO_POINT_DEAL', 'Memo point on deal', dealId, 'Risk', { MEMO_POINT_KIND: 'RISK', MEMO_POINT_TITLE: 'New risk', MEMO_POINT_BODY: 'Mitigant', MEMO_POINT_ORDER: String(risks.length + 1) })}>Add a risk</button>
        </section>

        <section id="icm-allocation">
          <h2>Proposed allocation</h2>
          <table className="icm-table">
            <thead>
              <tr>
                <th>Portfolio</th>
                {(preview?.tranches || []).map((tranche) => <th key={tranche.id} className="num">{tranche.label || tranche.name}</th>)}
                <th className="num">Total</th>
                <th className="num">Share of hold</th>
              </tr>
            </thead>
            <tbody>
              {placed.map((row) => (
                <tr key={row.fundId}>
                  <td><Link href={`${domainHref('FUND')}/${row.fundId}`}>{row.fundName}</Link></td>
                  {(preview?.tranches || []).map((tranche) => {
                    const cell = row.cells.find((item) => item.trancheId === tranche.id);
                    const show = cell && cell.eligible && cell.amount >= 1;
                    return <td key={tranche.id} className="num">{show ? plain(cell.amount, 2) : '—'}</td>;
                  })}
                  <td className="num">{plain(row.total, 2)}</td>
                  <td className="num">{allocTotal ? `${(row.total / allocTotal * 100).toFixed(1)}%` : '—'}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Total</td>
                {(preview?.tranches || []).map((tranche) => {
                  const amount = placed.reduce((total, row) => total + (row.cells.find((cell) => cell.trancheId === tranche.id && cell.eligible)?.amount || 0), 0);
                  return <td key={tranche.id} className="num">{plain(amount, 2)}</td>;
                })}
                <td className="num">{plain(placed.reduce((total, row) => total + row.total, 0), 2)}</td>
                <td className="num">100.0%</td>
              </tr>
            </tbody>
          </table>
          <p className="icm-note">
            {manual
              ? 'The allocation includes manual adjustments.'
              : 'The allocation follows the system rules with no manual adjustments.'}
            {' '}
            <button type="button" className="btn btn-sm" onClick={onOpenCapital}>Open the Capital structure tab</button>
            {' '}to review or change it.
          </p>
        </section>

        <section id="icm-participation">
          <h2>Participation and limits</h2>
          <p>
            {capped
              ? 'One or more portfolios are capped by a concentration, unfunded-commitment, or liquidity limit.'
              : 'No concentration, sponsor, unfunded-commitment or liquidity limit is breached at the proposed allocation.'}
          </p>
          {blocked.length > 0 && (
            <table className="icm-table">
              <thead><tr><th>Portfolio</th><th>Tranche</th><th>Not participating because</th></tr></thead>
              <tbody>
                {blocked.map((row) => {
                  const tranche = preview?.tranches.find((item) => item.id === row.trancheId);
                  return (
                    <tr key={`${row.fund}-${row.trancheId}`}>
                      <td>{row.fund}</td>
                      <td>{tranche ? (tranche.label || trancheFullName(tranche.instrumentType, tranche.name)) : 'Tranche'}</td>
                      <td>{row.reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section id="icm-approvals">
          <h2>Approvals</h2>
          <table className="icm-table">
            <thead><tr><th>Member</th><th>Role</th><th>Decision</th><th>Date</th></tr></thead>
            <tbody>
              {(memo?.approvals || []).map((row) => {
                const bind = (code: string, name: string): AttrBind => ({
                  entityId: row.id, entityName: row.member, domainCode: 'IC_APPROVAL', code, name,
                });
                return (
                <tr key={row.id}>
                  <td><AttrField bind={bind('APPROVAL_MEMBER', 'Member')} value={row.member} onCommit={(value) => save(row.id, { APPROVAL_MEMBER: value })} onChanged={changed} /></td>
                  <td>
                    <AttrField
                      bind={bind('APPROVAL_ROLE', 'Role')}
                      value={row.role}
                      display={ROLE_LABEL[row.role] || row.role}
                      onCommit={(value) => save(row.id, { APPROVAL_ROLE: value })}
                      onChanged={changed}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`btn btn-sm icm-state ${row.decision.toLowerCase()} attr-inspectable`}
                      title="Right-click to view sources"
                      onClick={() => {
                        const decision = DECISION_CYCLE[(DECISION_CYCLE.indexOf(row.decision) + 1) % DECISION_CYCLE.length];
                        const attributes: Record<string, string> = { APPROVAL_DECISION: decision };
                        if (decision !== 'PENDING') attributes.APPROVAL_DATE = asOfDate.slice(0, 10);
                        void save(row.id, attributes);
                      }}
                      onContextMenu={(event) => openSources(event, bind('APPROVAL_DECISION', 'Decision'), row.decision)}
                    >
                      {DECISION_LABEL[row.decision] || row.decision}
                    </button>
                  </td>
                  <td>
                    <AttrField
                      bind={bind('APPROVAL_DATE', 'Decision Date')}
                      value={row.decidedOn || ''}
                      display={row.decidedOn ? day(row.decidedOn) : '—'}
                      kind="date"
                      onCommit={(value) => save(row.id, { APPROVAL_DATE: value })}
                      onChanged={changed}
                    />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          <button type="button" className="btn btn-sm" onClick={() => createLinked('IC_APPROVAL', 'IC_APPROVAL_STANDARD', 'APPROVAL_DEAL', 'IC approval of deal', dealId, 'Committee member', { APPROVAL_MEMBER: 'New member', APPROVAL_ROLE: 'MEMBER', APPROVAL_DECISION: 'PENDING', APPROVAL_ORDER: String((memo?.approvals.length || 0) + 1) })}>Add a member</button>
        </section>

        <section id="icm-items">
          <h2>Open items</h2>
          <ul className="icm-items">
            {(memo?.openItems || []).map((item) => {
              const bind = (code: string, name: string): AttrBind => ({
                entityId: item.id, entityName: item.title, domainCode: 'DEAL_OPEN_ITEM', code, name,
              });
              return (
              <li key={item.id}>
                <AttrField bind={bind('OPEN_ITEM_TITLE', 'Item')} value={item.title} onCommit={(value) => save(item.id, { OPEN_ITEM_TITLE: value })} onChanged={changed} />
                <button
                  type="button"
                  className={`btn btn-sm icm-state ${item.status.toLowerCase()} attr-inspectable`}
                  title="Right-click to view sources"
                  onClick={() => save(item.id, { OPEN_ITEM_STATUS: item.status === 'DONE' ? 'OPEN' : 'DONE' })}
                  onContextMenu={(event) => openSources(event, bind('OPEN_ITEM_STATUS', 'Status'), item.status)}
                >
                  {item.status === 'DONE' ? 'Done' : 'Open'}
                </button>
              </li>
              );
            })}
          </ul>
          <button type="button" className="btn btn-sm" onClick={() => createLinked('DEAL_OPEN_ITEM', 'DEAL_OPEN_ITEM_STANDARD', 'OPEN_ITEM_DEAL', 'Open item on deal', dealId, 'Open item', { OPEN_ITEM_TITLE: 'New open item', OPEN_ITEM_STATUS: 'OPEN', OPEN_ITEM_ORDER: String((memo?.openItems.length || 0) + 1) })}>Add an item</button>
        </section>
        {busy && <p className="icm-note">Saving…</p>}
      </article>
    </div>
  );
}

const PERIOD_FIELD = {
  revenue: { code: 'PERIOD_REVENUE', name: 'Revenue' },
  ebitda: { code: 'PERIOD_EBITDA', name: 'EBITDA' },
  ebitdaMargin: { code: 'PERIOD_EBITDA_MARGIN', name: 'EBITDA Margin' },
  freeCashFlow: { code: 'PERIOD_FREE_CASH_FLOW', name: 'Free Cash Flow' },
  fundedDebtToEbitda: { code: 'PERIOD_FUNDED_DEBT_TO_EBITDA', name: 'Funded Debt / EBITDA' },
  ebitdaToCashInterest: { code: 'PERIOD_EBITDA_TO_CASH_INTEREST', name: 'EBITDA / Cash Interest' },
} as const;

function MetricRow({
  label, periods, field, digits, suffix = '', scale = 1, onSave, onChanged,
}: {
  label: string;
  periods: Period[];
  field: keyof typeof PERIOD_FIELD;
  digits: number;
  suffix?: string;
  scale?: number;
  onSave: (id: string, attributes: Record<string, string>) => void;
  onChanged: () => void;
}) {
  const spec = PERIOD_FIELD[field];
  return (
    <tr>
      <th>{label}</th>
      {periods.map((period) => {
        const raw = period[field];
        const value = typeof raw === 'number' ? raw : null;
        return (
          <td key={period.id} className="num">
            <AttrField
              bind={{ entityId: period.id, entityName: period.label, domainCode: 'FINANCIAL_PERIOD', code: spec.code, name: spec.name }}
              value={value == null ? '' : String(value)}
              display={num(value == null ? null : value / scale, digits, suffix)}
              kind="number"
              scale={scale}
              onCommit={(next) => onSave(period.id, { [spec.code]: next })}
              onChanged={onChanged}
            />
          </td>
        );
      })}
    </tr>
  );
}

interface AttrBind {
  entityId: string;
  entityName?: string;
  domainCode: string;
  code: string;
  name: string;
}

function openBind(event: MouseEvent, inspect: ReturnType<typeof useAttributeInspect>, bind: AttrBind, value: string, onChanged: () => void) {
  event.preventDefault();
  event.stopPropagation();
  inspect.open({
    entityId: bind.entityId,
    entityName: bind.entityName,
    attributeCode: bind.code,
    attributeName: bind.name,
    domainCode: bind.domainCode,
    value,
    onChanged,
  });
}

function AttrRead({
  bind, value, onOpen, children,
}: {
  bind: AttrBind;
  value: string;
  onOpen: (event: MouseEvent, bind: AttrBind, value: string) => void;
  children: ReactNode;
}) {
  return (
    <span className="attr-inspectable" title="Right-click to view sources" onContextMenu={(event) => onOpen(event, bind, value)}>
      {children}
    </span>
  );
}

function AttrField({
  bind, value, display, editValue, kind = 'text', multiline = false, scale, choices, onCommit, onChanged,
}: {
  bind: AttrBind;
  value: string;
  display?: string;
  editValue?: string;
  kind?: 'text' | 'date' | 'number';
  multiline?: boolean;
  scale?: number;
  choices?: Array<{ value: string; label: string }>;
  onCommit: (value: string) => void;
  onChanged: () => void;
}) {
  const inspect = useAttributeInspect();
  const catalog = useAttributeListOptions(choices || kind !== 'text' || multiline ? null : bind.code);
  const listed = choices || (catalog || []).map((option) => ({ value: option.value, label: option.displayLabel || option.label }));
  const shown = display || listed.find((option) => option.value === value)?.label || listDisplayLabel(value, catalog) || value || '—';
  const seed = editValue ?? (scale && value !== '' && Number.isFinite(Number(value)) ? String(Number(value) / scale) : value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(seed);
  const sent = useRef(false);
  useEffect(() => setDraft(seed), [seed]);

  const open = (event: MouseEvent) => openBind(event, inspect, bind, value || shown, onChanged);
  const close = (raw: string) => {
    if (sent.current) return;
    sent.current = true;
    setEditing(false);
    if (raw === seed) return;
    if (scale) {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      onCommit(String(parsed * scale));
      return;
    }
    onCommit(raw);
  };
  const begin = () => {
    sent.current = false;
    setDraft(seed);
    setEditing(true);
  };

  if (!editing) {
    return (
      <button type="button" className="field-edit attr-inspectable" title="Right-click to view sources" onClick={begin} onContextMenu={open}>
        {shown}
      </button>
    );
  }

  if (multiline) {
    return (
      <textarea
        autoFocus
        className="icm-edit"
        aria-label={bind.name}
        value={draft}
        rows={3}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => close(event.target.value)}
        onContextMenu={open}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { sent.current = true; setDraft(seed); setEditing(false); }
        }}
      />
    );
  }

  if (choices) {
    return (
      <select
        autoFocus
        className="icm-edit"
        aria-label={bind.name}
        value={draft}
        onChange={(event) => close(event.target.value)}
        onBlur={() => close(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { sent.current = true; setEditing(false); }
        }}
      >
        {choices.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }

  if (kind === 'text') {
    return (
      <AttributeValueInput
        attributeCode={bind.code}
        value={draft}
        autoFocus
        className="icm-edit"
        ariaLabel={bind.name}
        onChange={setDraft}
        onSelect={(next) => close(next)}
        onBlur={() => close(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { sent.current = true; setDraft(seed); setEditing(false); }
        }}
      />
    );
  }

  return (
    <input
      autoFocus
      className="icm-edit"
      aria-label={bind.name}
      type={kind === 'date' ? 'date' : 'number'}
      step={kind === 'number' ? 'any' : undefined}
      value={kind === 'date' ? draft.slice(0, 10) : draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => close(event.target.value)}
      onContextMenu={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') { sent.current = true; setDraft(seed); setEditing(false); }
      }}
    />
  );
}
