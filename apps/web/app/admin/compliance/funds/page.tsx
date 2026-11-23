'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  graphqlQuery,
  graphqlMutation,
  COMPLIANCE_FUND_BOARD_QUERY,
  UPSERT_COMPLIANCE_THRESHOLD_MUTATION,
  DELETE_COMPLIANCE_THRESHOLD_MUTATION,
  EVALUATE_COMPLIANCE_RULE_MUTATION,
} from '@/lib/graphql';
import { fundUsesRule } from '@/lib/fund-enrollment';

interface FundNode {
  entityId: string;
  entityCode: string;
  entityName?: string | null;
  parentEntityId?: string | null;
}

interface FundRule {
  id: string;
  ruleCode: string;
  ruleName: string;
  ruleCategory: string;
  resultUnit?: string | null;
  limitDirection?: string | null;
  groupByAttributeCode?: string | null;
  consolidateDescendants: boolean;
  isActive: boolean;
}

interface Threshold {
  id: string;
  ruleId: string;
  entityId?: string | null;
  groupValue?: string | null;
  rankFrom?: number | null;
  rankTo?: number | null;
  limitDirection?: string | null;
  softLimitValue?: number | null;
  hardLimitValue?: number | null;
  applies: boolean;
  notes?: string | null;
}

interface FundResult {
  id: string;
  ruleId: string;
  anchorEntityId: string;
  groupByValue?: string | null;
  computedValue?: number | null;
  limitDirection?: string | null;
  softLimitValue?: number | null;
  hardLimitValue?: number | null;
  status: string;
  rankPosition?: number | null;
  contributingCount?: number | null;
}

interface Board {
  funds: FundNode[];
  rules: FundRule[];
  thresholds: Threshold[];
  results: FundResult[];
}

function unitWord(unit?: string | null) {
  if (unit === 'PERCENTAGE') return 'Percentage';
  if (unit === 'CURRENCY') return 'Currency';
  if (unit === 'COUNT') return 'Count';
  if (unit === 'RATIO') return 'Ratio';
  return 'Value';
}

function groupWord(code?: string | null) {
  if (code === 'ISSUER_LEGAL_NAME') return 'issuer';
  if (code === 'SECTOR') return 'sector';
  if (code === 'SPONSOR_NAME') return 'sponsor';
  return 'group';
}

function formatValue(value: number | null | undefined, unit?: string | null) {
  if (value == null) return '—';
  if (unit === 'PERCENTAGE') return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  if (unit === 'CURRENCY') return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  if (unit === 'COUNT') return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function rankLabel(row: Threshold) {
  if (row.rankFrom == null) return 'Every rank';
  if (row.rankTo == null) return `Rank ${row.rankFrom} and after`;
  if (row.rankFrom === row.rankTo) return `Rank ${row.rankFrom}`;
  return `Ranks ${row.rankFrom}–${row.rankTo}`;
}

export default function FundThresholdsPage() {
  const router = useRouter();
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openRuleId, setOpenRuleId] = useState<string | null>(null);
  const [asOfDate, setAsOfDate] = useState('2026-09-30');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await graphqlQuery<{ complianceFundBoard: Board }, {}>(COMPLIANCE_FUND_BOARD_QUERY, {}, 'network-only');
      if (result.error) throw result.error;
      const next = result.data?.complianceFundBoard;
      if (next) {
        setBoard(next);
        setSelectedId((current) => current || next.funds.find((fund) => !fund.parentEntityId)?.entityId || next.funds[0]?.entityId || null);
      }
    } catch (err: any) {
      setError(err.message || 'Could not load fund thresholds');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const tree = useMemo(() => {
    const funds = board?.funds || [];
    const ids = new Set(funds.map((fund) => fund.entityId));
    const children = new Map<string, FundNode[]>();
    const roots: FundNode[] = [];
    for (const fund of funds) {
      if (fund.parentEntityId && ids.has(fund.parentEntityId)) {
        const list = children.get(fund.parentEntityId) || [];
        list.push(fund);
        children.set(fund.parentEntityId, list);
      } else {
        roots.push(fund);
      }
    }
    return { roots, children };
  }, [board]);

  const selected = board?.funds.find((fund) => fund.entityId === selectedId) || null;

  const save = async (input: Record<string, unknown>) => {
    setBusy(true);
    setNotice('');
    try {
      const result = await graphqlMutation<{ upsertComplianceThreshold: { errors: Array<{ message: string }> } }, any>(
        UPSERT_COMPLIANCE_THRESHOLD_MUTATION,
        { input },
      );
      const errors = result.data?.upsertComplianceThreshold?.errors || [];
      if (errors.length) throw new Error(errors.map((item) => item.message).join(', '));
      await load();
      setNotice('Threshold saved.');
    } catch (err: any) {
      setNotice(err.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setNotice('');
    try {
      const result = await graphqlMutation<{ deleteComplianceThreshold: { errors: Array<{ message: string }> } }, any>(
        DELETE_COMPLIANCE_THRESHOLD_MUTATION,
        { id },
      );
      const errors = result.data?.deleteComplianceThreshold?.errors || [];
      if (errors.length) throw new Error(errors.map((item) => item.message).join(', '));
      await load();
    } catch (err: any) {
      setNotice(err.message || 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const recalculate = async () => {
    if (!selected || !board) return;
    setBusy(true);
    setNotice('');
    try {
      for (const rule of board.rules) {
        const result = await graphqlMutation<{ evaluateComplianceRule: { errors: Array<{ message: string }> } }, any>(
          EVALUATE_COMPLIANCE_RULE_MUTATION,
          { input: { ruleCode: rule.ruleCode, asOfDate, entityId: selected.entityId } },
        );
        const errors = result.data?.evaluateComplianceRule?.errors || [];
        if (errors.length) throw new Error(`${rule.ruleCode}: ${errors.map((item) => item.message).join(', ')}`);
      }
      await load();
      setNotice(`Recalculated ${selected.entityName || selected.entityCode} as of ${asOfDate}. Child-fund positions are included when the rule consolidates.`);
    } catch (err: any) {
      setNotice(err.message || 'Recalculation failed');
    } finally {
      setBusy(false);
    }
  };

  const ruleStats = board && selected
    ? board.rules.map((rule) => fundUsesRule(board.thresholds, rule.id, selected.entityId))
    : [];
  const appliedCount = ruleStats.filter(Boolean).length;
  const appliedShare = ruleStats.length ? Math.round((appliedCount / ruleStats.length) * 100) : 0;
  const childCount = selected ? (tree.children.get(selected.entityId) || []).length : 0;
  const appliedRule = board && selected
    ? board.rules.find((rule) => fundUsesRule(board.thresholds, rule.id, selected.entityId))
    : null;
  const openRule = board?.rules.find((rule) => rule.id === openRuleId) || appliedRule || board?.rules[0] || null;

  return (
    <div className="view-fade da">
      <div className="da-crumbs">
        <Link href="/">Master Data</Link>
        <span>/</span>
        <Link href="/admin/compliance">Compliance</Link>
        <span>/</span>
        <strong>Thresholds by fund</strong>
      </div>

      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Fund limits</span>
          <h1>{selected?.entityName || 'Thresholds'}</h1>
          <p>{childCount
            ? `${childCount} child funds. A fund is scored, and limits a deal allocation, only for a rule that has a threshold here. There is no rule-wide limit. A parent includes the positions of its children when the rule consolidates.`
            : 'A fund is scored, and limits a deal allocation, only for a rule that has a threshold here. There is no rule-wide limit.'}</p>
        </div>
        <div className="da-facts">
          <div className="da-fact big"><span>Rules on the book</span><strong>{board ? board.rules.length : '—'}</strong></div>
          <div className="da-fact"><span>Applied here</span><strong>{selected ? appliedCount : '—'}</strong></div>
          <div className="da-fact"><span>Not used</span><strong>{selected ? ruleStats.length - appliedCount : '—'}</strong></div>
          <div className="da-fact">
            <span>As of</span>
            <strong><input type="date" value={asOfDate} aria-label="As of" onChange={(event) => setAsOfDate(event.target.value)} /></strong>
          </div>
        </div>
        <div className="da-holdbox">
          <div className="da-holdtop"><span>Rules applied to this fund</span><b>{selected ? `${appliedShare}%` : '—'}</b></div>
          <div className="da-bar"><i style={{ width: `${appliedShare}%` }} /></div>
          <p>{selected ? `${appliedCount} of ${ruleStats.length} rules score ${selected.entityName || 'this fund'}.` : 'Select a fund.'}</p>
        </div>
      </header>

      <div className="da-tabs" role="tablist">
        <button type="button" onClick={() => router.push('/admin/compliance')}>Dashboard</button>
        <button type="button" onClick={() => router.push('/admin/compliance?tab=rules')}>Rules</button>
        <button type="button" className="on">Thresholds by fund</button>
      </div>

      {error && <div className="xp-error">{error}</div>}
      {notice && <p className="da-note">{notice}</p>}
      {loading && !board ? <div className="xp-empty">Loading fund thresholds…</div> : (
        <section className="da-sec">
          <div className="da-sechead">
            <div>
              <h2>Limits</h2>
              <p>Select a fund, then a rule. The panel sets the limit for that fund.</p>
            </div>
            <div className="page-actions">
              <button type="button" className="btn btn-primary" disabled={busy || !selected} onClick={recalculate}>{busy ? 'Working…' : 'Recalculate this fund'}</button>
            </div>
          </div>
          <div className="dc-layout">
            <div>
              <div className="dc-kicker">Funds</div>
              <div className="dc-tree" role="tree" aria-label="Funds">
                {tree.roots.map((fund) => (
                  <FundBranch key={fund.entityId} fund={fund} childrenOf={tree.children} selectedId={selectedId} onSelect={setSelectedId} />
                ))}
              </div>
            </div>
            {selected && board && (
              <div className="da-main">
                <div className="da-gridwrap">
                  <table className="da-grid" style={{ minWidth: 520 }}>
                    <thead>
                      <tr>
                        <th>Rule</th>
                        <th>Measure</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {board.rules.map((rule) => {
                        const applied = fundUsesRule(board.thresholds, rule.id, selected.entityId);
                        const scored = board.results.filter((item) => item.ruleId === rule.id && item.anchorEntityId === selected.entityId && item.status !== 'NO_DATA');
                        const outcome = scored.some((item) => item.status === 'HARD_BREACH') ? 'HARD_BREACH'
                          : scored.some((item) => item.status === 'SOFT_BREACH') ? 'SOFT_BREACH'
                          : scored[0]?.status || null;
                        const active = (openRule?.id || null) === rule.id;
                        return (
                          <tr key={rule.id} className={active ? 'sel' : ''} onClick={() => setOpenRuleId(rule.id)}>
                            <td>
                              <b>{rule.ruleName}</b>
                              {rule.consolidateDescendants && <small>Includes child funds</small>}
                            </td>
                            <td>
                              <b>{unitWord(rule.resultUnit)}</b>
                              <small>{rule.groupByAttributeCode ? `By ${groupWord(rule.groupByAttributeCode)}` : 'Fund total'}</small>
                            </td>
                            <td><span className={`da-st ${!applied ? 'na' : outcome ? statusTone(outcome) : 'ok'}`}>{!applied ? 'Not used' : outcome ? statusLabel(outcome, rule.limitDirection) : 'Applied'}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <aside className="da-panel">
                  {openRule ? (
                    <RuleLimit
                      rule={openRule}
                      fund={selected}
                      thresholds={board.thresholds}
                      results={board.results}
                      busy={busy}
                      onSave={save}
                      onDelete={remove}
                    />
                  ) : <p className="da-note" style={{ padding: 16 }}>Select a rule to set its limit.</p>}
                </aside>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function RuleLimit({ rule, fund, thresholds, results, busy, onSave, onDelete }: {
  rule: FundRule;
  fund: FundNode;
  thresholds: Threshold[];
  results: FundResult[];
  busy: boolean;
  onSave: (input: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
}) {
  const rows = thresholds.filter((item) => item.ruleId === rule.id && item.entityId === fund.entityId);
  const fundDefault = rows.find((item) => !item.groupValue && item.rankFrom == null) || null;
  const groups = rows.filter((item) => item.groupValue);
  const ranks = rows.filter((item) => !item.groupValue && item.rankFrom != null);
  const scored = results.filter((item) => item.ruleId === rule.id && item.anchorEntityId === fund.entityId);
  const applied = fundUsesRule(thresholds, rule.id, fund.entityId);
  const headline = fundDefault?.hardLimitValue ?? fundDefault?.softLimitValue;
  const way = fundDefault?.limitDirection || rule.limitDirection || 'MAX';
  return (
    <>
      <div className="da-ph">
        <small>{rule.resultUnit || 'Value'}</small>
        <h3>{rule.ruleName}</h3>
        <div className="da-big">{headline != null ? formatValue(headline, rule.resultUnit) : '—'}</div>
        <p className="da-note">{applied ? `${directionWord(way)}. A result outside it is a breach.` : 'This fund skips the rule.'}</p>
        <span className={`da-st ${applied ? 'ok' : 'na'}`}>{applied ? 'Applied' : 'Not used'}</span>
      </div>
      <section>
        <h4>Fund limit</h4>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={applied}
            disabled={busy}
            onChange={(event) => onSave({
              id: fundDefault?.id,
              ruleId: rule.id,
              entityId: fund.entityId,
              applies: event.target.checked,
              limitDirection: way,
              softLimitValue: fundDefault?.softLimitValue,
              hardLimitValue: fundDefault?.hardLimitValue,
            })}
          />
          This fund uses this rule
        </label>
        {applied && (
          <LimitEditor
            label="Fund limit"
            hint="A maximum is breached when the result is higher. A minimum is breached when the result is lower."
            direction={way}
            soft={fundDefault?.softLimitValue}
            hard={fundDefault?.hardLimitValue}
            unit={rule.resultUnit}
            disabled={busy}
            onSave={(direction, soft, hard) => onSave({
              id: fundDefault?.id,
              ruleId: rule.id,
              entityId: fund.entityId,
              applies: true,
              limitDirection: direction,
              softLimitValue: soft,
              hardLimitValue: hard,
            })}
          />
        )}
        {applied && rule.groupByAttributeCode && (
          <GroupEditor
            label={`Limits by ${rule.groupByAttributeCode}`}
            rows={groups}
            suggestions={[...new Set(scored.map((item) => item.groupByValue).filter(Boolean) as string[])]}
            direction={way}
            disabled={busy}
            onSave={(row, direction, soft, hard, applies) => onSave({
              id: row?.id,
              ruleId: rule.id,
              entityId: fund.entityId,
              groupValue: row?.groupValue,
              applies,
              limitDirection: direction,
              softLimitValue: soft,
              hardLimitValue: hard,
            })}
            onCreate={(groupValue, direction, soft, hard) => onSave({
              ruleId: rule.id,
              entityId: fund.entityId,
              groupValue,
              applies: true,
              limitDirection: direction,
              softLimitValue: soft,
              hardLimitValue: hard,
            })}
            onDelete={onDelete}
          />
        )}
        {applied && rule.groupByAttributeCode && (
          <RankEditor
            rows={ranks}
            direction={way}
            disabled={busy}
            onCreate={(rankFrom, rankTo, direction, soft, hard) => onSave({
              ruleId: rule.id,
              entityId: fund.entityId,
              rankFrom,
              rankTo,
              applies: true,
              limitDirection: direction,
              softLimitValue: soft,
              hardLimitValue: hard,
            })}
            onDelete={onDelete}
          />
        )}
      </section>
      <section>
        <h4>Latest results</h4>
        {!applied ? <p className="da-note">This fund is not scored for this rule until it has a threshold.</p>
          : scored.length === 0 ? <p className="da-note">No result for this fund. Recalculate to score it.</p> : (
          <table className="da-mini">
            <thead>
              <tr>
                <th>Group</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {scored.slice().sort((a, b) => (a.rankPosition || 99) - (b.rankPosition || 99)).map((result) => (
                <tr key={result.id}>
                  <td>
                    <b>{result.groupByValue || 'Fund total'}</b>
                    <small>{directionWord(result.limitDirection)} · soft {formatValue(result.softLimitValue, rule.resultUnit)} · hard {formatValue(result.hardLimitValue, rule.resultUnit)}</small>
                  </td>
                  <td className="num">
                    {formatValue(result.computedValue, rule.resultUnit)}
                    <small><span className={`da-st ${statusTone(result.status)}`}>{statusLabel(result.status, result.limitDirection)}</span></small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function statusTone(status: string) {
  if (status === 'PASS') return 'ok';
  if (status === 'SOFT_BREACH') return 'near';
  if (status === 'HARD_BREACH') return 'breach';
  return 'na';
}

function directionWord(direction?: string | null) {
  return direction === 'MIN' ? 'Minimum' : 'Maximum';
}

function statusLabel(status: string, direction?: string | null) {
  if (status === 'PASS') return 'Within limit';
  if (status === 'SOFT_BREACH') return direction === 'MIN' ? 'Near minimum' : 'Near maximum';
  if (status === 'HARD_BREACH') return direction === 'MIN' ? 'Below minimum' : 'Above maximum';
  if (status === 'NO_DATA') return 'No data';
  return status.replaceAll('_', ' ');
}

function FundBranch({ fund, childrenOf, selectedId, onSelect }: {
  fund: FundNode;
  childrenOf: Map<string, FundNode[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const children = childrenOf.get(fund.entityId) || [];
  return (
    <div className="dc-branch">
      <div className={selectedId === fund.entityId ? 'dc-row on' : 'dc-row'}>
        <button type="button" className="dc-node" onClick={() => onSelect(fund.entityId)}>
          <b>{fund.entityName || 'Fund'}</b>
          {children.length > 0 && <small>{children.length} child funds</small>}
        </button>
      </div>
      {children.length > 0 && (
        <div className="dc-kids">
          {children.map((child) => (
            <FundBranch key={child.entityId} fund={child} childrenOf={childrenOf} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

function LimitEditor({ label, hint, direction, soft, hard, unit, disabled, onSave }: {
  label: string;
  hint: string;
  direction?: string | null;
  soft?: number | null;
  hard?: number | null;
  unit?: string | null;
  disabled: boolean;
  onSave: (direction: string, soft: number | null, hard: number | null) => void;
}) {
  const [way, setWay] = useState(direction === 'MIN' ? 'MIN' : 'MAX');
  const [softText, setSoftText] = useState(soft != null ? String(soft) : '');
  const [hardText, setHardText] = useState(hard != null ? String(hard) : '');
  useEffect(() => {
    setWay(direction === 'MIN' ? 'MIN' : 'MAX');
    setSoftText(soft != null ? String(soft) : '');
    setHardText(hard != null ? String(hard) : '');
  }, [direction, soft, hard]);
  const parse = (value: string) => value.trim() === '' ? null : Number(value);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{label}{unit ? ` (${unit.toLowerCase()})` : ''}</div>
      <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>{hint}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
        <DirectionSelect value={way} disabled={disabled} onChange={setWay} />
        <div className="field" style={{ margin: 0 }}>
          <label>Soft</label>
          <input className="text-input mono" value={softText} onChange={(event) => setSoftText(event.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Hard</label>
          <input className="text-input mono" value={hardText} onChange={(event) => setHardText(event.target.value)} />
        </div>
        <button className="btn" disabled={disabled} onClick={() => onSave(way, parse(softText), parse(hardText))}>Save</button>
      </div>
    </div>
  );
}

function DirectionSelect({ value, disabled, onChange }: { value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <div className="field" style={{ margin: 0 }}>
      <label>Limit</label>
      <select className="select" aria-label="Minimum or maximum" value={value === 'MIN' ? 'MIN' : 'MAX'} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="MAX">Maximum</option>
        <option value="MIN">Minimum</option>
      </select>
    </div>
  );
}

function GroupEditor({ label, rows, suggestions, direction, disabled, onSave, onCreate, onDelete }: {
  label: string;
  rows: Threshold[];
  suggestions: string[];
  direction?: string | null;
  disabled: boolean;
  onSave: (row: Threshold, direction: string, soft: number | null, hard: number | null, applies: boolean) => void;
  onCreate: (groupValue: string, direction: string, soft: number | null, hard: number | null) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState(suggestions[0] || '');
  const [way, setWay] = useState(direction === 'MIN' ? 'MIN' : 'MAX');
  const [soft, setSoft] = useState('');
  const [hard, setHard] = useState('');
  useEffect(() => { setWay(direction === 'MIN' ? 'MIN' : 'MAX'); }, [direction]);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{label}</div>
      {rows.map((row) => (
        <GroupRow key={row.id} row={row} disabled={disabled} onSave={onSave} onDelete={onDelete} />
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'end', marginTop: 8 }}>
        <div className="field" style={{ margin: 0, flex: 1 }}>
          <label>Group</label>
          <input className="text-input" list="group-suggestions" value={name} onChange={(event) => setName(event.target.value)} placeholder="Industry name" />
          <datalist id="group-suggestions">
            {suggestions.map((item) => <option key={item} value={item} />)}
          </datalist>
        </div>
        <DirectionSelect value={way} disabled={disabled} onChange={setWay} />
        <div className="field" style={{ margin: 0 }}>
          <label>Soft</label>
          <input className="text-input mono" value={soft} onChange={(event) => setSoft(event.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Hard</label>
          <input className="text-input mono" value={hard} onChange={(event) => setHard(event.target.value)} />
        </div>
        <button className="btn" disabled={disabled || !name.trim()} onClick={() => onCreate(name.trim(), way, soft.trim() === '' ? null : Number(soft), hard.trim() === '' ? null : Number(hard))}>Add</button>
      </div>
    </div>
  );
}

function GroupRow({ row, disabled, onSave, onDelete }: {
  row: Threshold;
  disabled: boolean;
  onSave: (row: Threshold, direction: string, soft: number | null, hard: number | null, applies: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [way, setWay] = useState(row.limitDirection === 'MIN' ? 'MIN' : 'MAX');
  const [soft, setSoft] = useState(row.softLimitValue != null ? String(row.softLimitValue) : '');
  const [hard, setHard] = useState(row.hardLimitValue != null ? String(row.hardLimitValue) : '');
  useEffect(() => {
    setWay(row.limitDirection === 'MIN' ? 'MIN' : 'MAX');
    setSoft(row.softLimitValue != null ? String(row.softLimitValue) : '');
    setHard(row.hardLimitValue != null ? String(row.hardLimitValue) : '');
  }, [row.limitDirection, row.softLimitValue, row.hardLimitValue]);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 12 }}>
      <span style={{ minWidth: 140 }}>{row.groupValue}</span>
      <select className="select" aria-label={`Minimum or maximum for ${row.groupValue}`} value={way} disabled={disabled} onChange={(event) => setWay(event.target.value)} style={{ maxWidth: 120 }}>
        <option value="MAX">Maximum</option>
        <option value="MIN">Minimum</option>
      </select>
      <input className="text-input mono" aria-label="Soft" style={{ maxWidth: 90 }} value={soft} onChange={(event) => setSoft(event.target.value)} />
      <input className="text-input mono" aria-label="Hard" style={{ maxWidth: 90 }} value={hard} onChange={(event) => setHard(event.target.value)} />
      <button className="btn" disabled={disabled} onClick={() => onSave(row, way, soft.trim() === '' ? null : Number(soft), hard.trim() === '' ? null : Number(hard), true)}>Save</button>
      <button className="btn" disabled={disabled} onClick={() => onDelete(row.id)}>Remove</button>
    </div>
  );
}

function RankEditor({ rows, direction, disabled, onCreate, onDelete }: {
  rows: Threshold[];
  direction?: string | null;
  disabled: boolean;
  onCreate: (rankFrom: number, rankTo: number | null, direction: string, soft: number | null, hard: number | null) => void;
  onDelete: (id: string) => void;
}) {
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('1');
  const [way, setWay] = useState(direction === 'MIN' ? 'MIN' : 'MAX');
  const [soft, setSoft] = useState('');
  const [hard, setHard] = useState('');
  useEffect(() => { setWay(direction === 'MIN' ? 'MIN' : 'MAX'); }, [direction]);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>Limits by rank</div>
      <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>
        {direction === 'MIN' ? 'Rank 1 is the smallest group.' : 'Rank 1 is the largest group.'} Leave the end rank blank for every rank after the start.
      </div>
      {rows.map((row) => (
        <div key={row.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 12 }}>
          <span style={{ minWidth: 160 }}>{rankLabel(row)}</span>
          <span className="mono">{directionWord(row.limitDirection)} · soft {row.softLimitValue ?? '—'} / hard {row.hardLimitValue ?? '—'}</span>
          <button className="btn" disabled={disabled} onClick={() => onDelete(row.id)}>Remove</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'end', marginTop: 8 }}>
        <div className="field" style={{ margin: 0 }}>
          <label>From</label>
          <input className="text-input mono" style={{ maxWidth: 70 }} value={from} onChange={(event) => setFrom(event.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>To</label>
          <input className="text-input mono" style={{ maxWidth: 70 }} value={to} onChange={(event) => setTo(event.target.value)} placeholder="open" />
        </div>
        <DirectionSelect value={way} disabled={disabled} onChange={setWay} />
        <div className="field" style={{ margin: 0 }}>
          <label>Soft</label>
          <input className="text-input mono" style={{ maxWidth: 90 }} value={soft} onChange={(event) => setSoft(event.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Hard</label>
          <input className="text-input mono" style={{ maxWidth: 90 }} value={hard} onChange={(event) => setHard(event.target.value)} />
        </div>
        <button className="btn" disabled={disabled || !from.trim()} onClick={() => onCreate(Number(from), to.trim() === '' ? null : Number(to), way, soft.trim() === '' ? null : Number(soft), hard.trim() === '' ? null : Number(hard))}>Add band</button>
      </div>
    </div>
  );
}
