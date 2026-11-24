'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useSurfaceHost } from '@tapestrai/surface-sdk/react';
import type { Commitment, Fund, Lens, OcioData } from '../lib/types';
import { fmtUsd } from '../lib/format';
import { KEY_SEP } from '../lib/tree';
import type { RuleResult } from '../lib/compliance';
import { commitmentBind, securityBind, type SECURITY_FIELDS } from '../lib/binds';
import { commitmentRows } from '../lib/how';
import { Bound, Derived, Empty, useInspect } from './common';

type GroupKey = 'none' | 'year' | 'cat' | 'ac' | 'st' | 'sub' | 'rg' | 'ty' | 'det' | 'investmentType' | 'manager' | 'market' | 'country' | 'sector' | 'currency' | 'relationship';
const GROUPS: Array<[GroupKey, string]> = [
  ['none', 'No grouping'], ['year', 'Investment year'], ['cat', 'Category'], ['ac', 'Asset Class'], ['st', 'Strategy'], ['sub', 'Sub-Strategy'],
  ['rg', 'Region'], ['ty', 'Structure Type'], ['det', 'Structure Detail'], ['investmentType', 'Investment Type'], ['manager', 'Manager / GP Firm'],
  ['market', 'Market Classification'], ['country', 'Single-Country Focus'], ['sector', 'Primary Industry Sector'], ['currency', 'Commitment Currency'], ['relationship', 'Relationship'],
];

const TAG_COLS: Array<[keyof Commitment['tags'], string, Lens]> = [
  ['cat', 'Category', 'strategy'], ['ac', 'Asset Class', 'strategy'], ['st', 'Strategy', 'strategy'], ['sub', 'Sub-Strategy', 'strategy'],
  ['rg', 'Region', 'region'], ['ty', 'Structure Type', 'structure'], ['det', 'Detail', 'structure'],
];

/** Which rules flag a commitment: a group that is its asset, manager, sector or year, out of tolerance. */
export function flagsFor(c: Commitment, rules: RuleResult[]): Array<{ rule: string; status: string }> {
  const keys = new Set([c.asset, c.manager, c.sector, c.allocationYear].filter(Boolean) as string[]);
  const out: Array<{ rule: string; status: string }> = [];
  for (const r of rules) {
    if (r.status === 'pass' || r.status === 'na') continue;
    const hit = r.groups.some((g) => g.status !== 'pass' && g.status !== 'na' && keys.has(g.label));
    if (hit) out.push({ rule: r.ruleName, status: r.status });
  }
  return out;
}

const yesNo = (v: boolean | null) => (v == null ? '—' : v ? 'Yes' : 'No');

export function CommitmentsTab({ fund, list, data, rules, onJump }: {
  fund: Fund;
  list: Commitment[];
  data: OcioData;
  rules: RuleResult[] | null;
  onJump: (lens: Lens, key: string) => void;
}) {
  const host = useSurfaceHost();
  const inspect = useInspect();
  const [year, setYear] = useState('all');
  const [group, setGroup] = useState<GroupKey>('year');
  const [detail, setDetail] = useState<string | null>(null);
  const label = (code: string | null) => (code ? data.taxonomy.labels[code] || code : null);
  const sleeveName = (id: string) => data.funds.find((f) => f.id === id)?.name || '';
  const years = useMemo(() => [...new Set(list.map((c) => c.date.slice(0, 4)))].sort().reverse(), [list]);
  const shown = list.filter((c) => year === 'all' || c.date.startsWith(year));
  const total = shown.reduce((s, c) => s + c.amount, 0);
  const groupValue = (c: Commitment): string => {
    if (group === 'year') return c.date.slice(0, 4);
    if (group in c.tags) return label(c.tags[group as keyof Commitment['tags']]) || 'Not classified';
    return String((c as unknown as Record<string, unknown>)[group] ?? 'Not recorded');
  };
  const groups = ((): Array<[string, Commitment[]]> => {
    if (group === 'none') return [['', shown]];
    const m = new Map<string, Commitment[]>();
    shown.forEach((c) => { const g = groupValue(c); m.set(g, [...(m.get(g) || []), c]); });
    return [...m.entries()].sort((a, b) => (group === 'year' ? b[0].localeCompare(a[0]) : b[1].reduce((s, c) => s + c.amount, 0) - a[1].reduce((s, c) => s + c.amount, 0)));
  })();

  if (!list.length) return <Empty>No commitments booked to {fund.name} yet.</Empty>;
  const open = detail ? list.find((c) => c.id === detail) : null;
  const pathKey = (c: Commitment, col: keyof Commitment['tags'], lens: Lens) => {
    const seq = lens === 'strategy' ? ['cat', 'ac', 'st', 'sub'] : lens === 'region' ? ['rg', 'ac'] : ['cat', 'ty', 'det'];
    const upto = seq.slice(0, seq.indexOf(col) + 1) as Array<keyof Commitment['tags']>;
    return upto.map((k) => c.tags[k]).join(KEY_SEP);
  };
  const sec = (c: Commitment, field: keyof typeof SECURITY_FIELDS, text: string | null) => <Bound {...securityBind(c, field)} value={text || undefined}>{text || '—'}</Bound>;
  const pos = (c: Commitment, field: keyof typeof commitmentBind, text: string | null) => <Bound {...commitmentBind[field](c)} value={text || undefined}>{text || '—'}</Bound>;
  const groupLabel = GROUPS.find(([k]) => k === group)?.[1];

  const card: Array<[string, ReactNode]> = open ? [
    ['Commitment', pos(open, 'amount', fmtUsd(open.amount))],
    ['Commit date', pos(open, 'date', open.date)],
    ['Allocation tranche', pos(open, 'allocationYear', open.allocationYear)],
    ['Currency', pos(open, 'currency', open.currency)],
    ['Investment type', sec(open, 'investmentType', open.investmentType)],
    ['Underlying asset', sec(open, 'asset', open.asset)],
    ['Manager', sec(open, 'manager', open.manager)],
    ['Market', sec(open, 'market', open.market)],
    ['Country focus', sec(open, 'country', open.country)],
    ['Sector', sec(open, 'sector', open.sector)],
    ['Underlying fund size', sec(open, 'fundSize', open.fundSize != null ? fmtUsd(open.fundSize) : null)],
    ['Share of underlying fund', open.fundSize
      ? <Derived name="Share of underlying fund" how={() => ({ title: `${open.name}: share of underlying fund`, value: `${((open.amount / open.fundSize!) * 100).toFixed(2)}%`, formula: 'The original commitment divided by the size of the fund it was made to.', rows: [{ label: 'Original commitment', value: fmtUsd(open.amount), bind: commitmentBind.amount(open) }, { label: 'Underlying fund size', value: fmtUsd(open.fundSize), bind: securityBind(open, 'fundSize') }] })}>{((open.amount / open.fundSize) * 100).toFixed(2)}%</Derived>
      : '—'],
    ['First-time fund', sec(open, 'firstTime', yesNo(open.firstTime))],
    ['Relationship', sec(open, 'relationship', open.relationship)],
    ['Contractual review', pos(open, 'contractual', open.contractual)],
    ['ESG questionnaire', pos(open, 'esg', open.esg)],
    ['Strategy questionnaire', pos(open, 'strategyReview', open.strategyReview)],
  ] : [];

  return (
    <section className="da-sec">
      <div className="da-toolbar">
        <label htmlFor="ocioYear">Year</label>
        <select className="x-sel" id="ocioYear" value={year} onChange={(e) => setYear(e.target.value)}>
          <option value="all">All years</option>
          {years.map((y) => <option key={y}>{y}</option>)}
        </select>
        <label htmlFor="ocioGroup">Group by</label>
        <select className="x-sel" id="ocioGroup" value={group} onChange={(e) => setGroup(e.target.value as GroupKey)}>
          {GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <span className="x-hint">{shown.length} original commitments · {fmtUsd(total) || '$0'} committed · select a row for its detail, a tag to open that target level, or right-click a value for its sources</span>
      </div>
      {open && (
        <div className="x-detail">
          <div className="da-phrow">
            <div>
              <small>{sleeveName(open.sleeveId)}</small>
              <h3><a href={host.href(`/positions/${open.id}`)}>{open.name}</a></h3>
            </div>
            <span>
              <a className="btn btn-sm" href={host.href(`/positions/${open.id}`)}>Open the record</a>{' '}
              <button className="btn btn-sm" onClick={() => setDetail(null)}>Close</button>
            </span>
          </div>
          <dl className="x-dl">
            {card.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        </div>
      )}
      <div className="da-gridwrap x-gridwrap">
        <table className="da-grid x-hgrid">
          <thead>
            <tr>
              <th>Commitment</th>
              {fund.kind === 'client' && <th>Sleeve</th>}
              <th className="num">Commit date</th>
              <th className="num">Commitment</th>
              {TAG_COLS.map(([, l]) => <th key={l}>{l}</th>)}
              <th title="Rules on the mandate that flag this commitment">Compliance</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([g, rows]) => {
              const sum = rows.reduce((s, c) => s + c.amount, 0);
              return [
                g ? (
                  <tr key={`g-${g}`} className="x-grouprow">
                    <td colSpan={TAG_COLS.length + 4 + (fund.kind === 'client' ? 1 : 0)}>
                      {groupLabel}: {g}
                      <small>
                        {' '}{rows.length} commitments ·{' '}
                        <Derived name={`${groupLabel} ${g} committed`} how={() => ({ title: `${groupLabel}: ${g}`, value: fmtUsd(sum), formula: `Original commitments in this group, added up. ${total ? Math.round((sum / total) * 100) : 0}% of the ${fmtUsd(total)} shown.`, ...commitmentRows(rows) })}>{fmtUsd(sum)}</Derived>
                        {' '}· {total ? Math.round((sum / total) * 100) : 0}% of shown
                      </small>
                    </td>
                  </tr>
                ) : null,
                ...rows.map((c) => {
                  const flags = rules ? flagsFor(c, rules) : [];
                  return (
                    <tr key={c.id} tabIndex={0} className={detail === c.id ? 'sel x-rowlink' : 'x-rowlink'} onClick={() => setDetail(c.id)} onKeyDown={(e) => { if (e.key === 'Enter') setDetail(c.id); }}>
                      <td><b><a href={host.href(`/positions/${c.id}`)} title="Open the record" onClick={(e) => e.stopPropagation()}>{c.name}</a></b><small>{sec(c, 'manager', c.manager)}</small></td>
                      {fund.kind === 'client' && <td>{sleeveName(c.sleeveId)}</td>}
                      <td className="num">{pos(c, 'date', c.date)}</td>
                      <td className="num">{pos(c, 'amount', fmtUsd(c.amount))}</td>
                      {TAG_COLS.map(([col, colLabel, lens]) => (
                        <td key={col}>
                          {c.tags[col]
                            ? (
                              <button
                                className="x-tag attr-inspectable"
                                data-attr={securityBind(c, col).code}
                                title={`${colLabel}: select to open this target level, right-click for sources`}
                                onClick={(e) => { e.stopPropagation(); onJump(lens, pathKey(c, col, lens)); }}
                                onContextMenu={inspect(securityBind(c, col), label(c.tags[col]) || undefined)}
                              >
                                {label(c.tags[col])}
                              </button>
                            )
                            : <span className="x-tag na">n/a</span>}
                        </td>
                      ))}
                      <td>
                        {flags.length
                          ? (
                            <Derived name={`${c.name} compliance flags`} how={() => ({ title: `${c.name}: rules that flag it`, value: `${flags.length} flag${flags.length === 1 ? '' : 's'}`, formula: 'Rules on this mandate where the compliance engine scored a group out of tolerance, and that group is this commitment’s asset, manager, sector or allocation year.', rows: flags.map((f) => ({ label: f.rule, value: f.status })) })}>
                              <span className={`da-st ${flags.some((f) => f.status === 'breach') ? 'breach' : 'near'}`}>{flags.length} flag{flags.length === 1 ? '' : 's'}</span>
                            </Derived>
                          )
                          : <span className="x-nil">·</span>}
                      </td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={fund.kind === 'client' ? 3 : 2}>Total shown</td>
              <td className="num"><b><Derived name="Total committed, shown" how={() => ({ title: 'Total shown', value: fmtUsd(total), formula: `Original commitments in the list${year === 'all' ? '' : ` for ${year}`}, added up.`, ...commitmentRows(shown) })}>{fmtUsd(total)}</Derived></b></td>
              <td colSpan={TAG_COLS.length + 1}>{shown.length} commitments</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
