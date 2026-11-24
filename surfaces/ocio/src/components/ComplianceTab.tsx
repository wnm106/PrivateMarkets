'use client';

import { Fragment, useState } from 'react';
import { useSurfaceHost } from '@tapestrai/surface-sdk/react';
import type { Fund } from '../lib/types';
import { RULE_STATUS, fmtRuleValue, type ComplianceCounts, type RuleResult, type RuleStatus } from '../lib/compliance';
import type { BandIssue } from '../lib/summary';
import { LENS_INFO } from '../lib/tree';
import { fmtUsd } from '../lib/format';
import { Derived, Empty, ErrorPanel, Loading, type Derivation } from './common';

type Row = RuleResult & { sleeveId: string; sleeveName: string };

const TILES: Array<[RuleStatus, string]> = [['breach', 'bad'], ['soft', 'soft'], ['watch', 'warn'], ['pending', 'pend'], ['pass', 'ok']];

const isScreen = (r: RuleResult) => r.unit === 'COUNT' && r.direction === 'MAX' && !r.attestation && (r.limit == null || r.limit === 0);

function requirement(r: RuleResult): string {
  if (r.attestation) return 'Every commitment cleared';
  if (isScreen(r)) return 'None allowed';
  if (r.limit == null) return '—';
  return `${r.direction === 'MIN' ? '≥' : '≤'} ${fmtRuleValue(r.unit, r.limit)}`;
}

function result(r: RuleResult): string {
  if (r.attestation) return r.value ? `${r.value} open` : 'All cleared';
  if (isScreen(r)) return r.value ? `${r.value} exception${r.value === 1 ? '' : 's'}` : 'None found';
  return fmtRuleValue(r.unit, r.value);
}

export function ComplianceTab({ fund, rules, counts, errors, bandIssues, onRetry }: {
  fund: Fund;
  rules: Row[] | null;
  counts: ComplianceCounts | null;
  errors: string[];
  bandIssues: BandIssue[];
  onRetry: () => void;
}) {
  const host = useSurfaceHost();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<RuleStatus | null>(null);
  if (!rules || !counts) {
    return errors.length
      ? <ErrorPanel message={`This ${fund.kind === 'client' ? 'client’s sleeves' : 'mandate'} could not be scored, so there is no result to show: ${errors.join('; ')}`} onRetry={onRetry} />
      : <Loading text="Scoring this mandate's rules with the compliance engine…" />;
  }
  const shown = rules.filter((r) => !filter || r.status === filter);
  /** A rule's result as the engine scored it: the limit, the figure, and each group it measured. */
  const how = (r: Row): Derivation => ({
    title: `${r.ruleName}${fund.kind === 'client' ? ` · ${r.sleeveName}` : ''}`,
    value: result(r),
    formula: `Scored by the compliance engine at your As Of and Knowledge dates. Requirement: ${requirement(r)}. The limit and its severity are set for the sleeve in the rule book; the surface shows the engine's result and does not evaluate the rule.${r.description ? ` ${r.description}` : ''}`,
    rows: r.groups.filter((g) => g.status !== 'na' || r.groups.length === 1).slice(0, 12).map((g) => ({ label: g.label, sub: g.numerator != null && r.unit === 'PERCENTAGE' ? `${fmtUsd(g.numerator)} of ${fmtUsd(g.denominator)}` : undefined, value: `${fmtRuleValue(r.unit, g.value)} · ${RULE_STATUS[g.status].label}` })),
    more: r.groups.length > 12 ? r.groups.length - 12 : undefined,
  });
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <section className="da-sec">
      {errors.length > 0 && <ErrorPanel message={`Some rules could not be scored: ${errors.join('; ')}`} onRetry={onRetry} />}
      <div className="fs-tiles">
        {TILES.map(([st, cls]) => (
          <button key={st} className="fs-tile x-tile" aria-pressed={filter === st} onClick={() => setFilter(filter === st ? null : st)}>
            <b className={cls}><Derived name={`${RULE_STATUS[st].label} count`} how={() => ({ title: `Rules: ${RULE_STATUS[st].label}`, value: String(counts[st]), formula: 'The number of rules the compliance engine scored with this status, at your As Of and Knowledge dates.', rows: rules.filter((r) => r.status === st).slice(0, 12).map((r) => ({ label: r.ruleName, sub: fund.kind === 'client' ? r.sleeveName : undefined, value: result(r) })) })}>{counts[st]}</Derived></b>
            <span>{RULE_STATUS[st].label}</span>
          </button>
        ))}
        <div className="fs-tile">
          <b><Derived name="Rules scored" how={() => ({ title: 'Rules scored', value: String(counts.total), formula: `Every rule ${fund.kind === 'client' ? 'this client’s sleeves are' : 'this sleeve is'} enrolled in, as the compliance engine returned them at your As Of and Knowledge dates.`, rows: rules.slice(0, 12).map((r) => ({ label: r.ruleName, sub: fund.kind === 'client' ? r.sleeveName : undefined, value: RULE_STATUS[r.status].label })), more: rules.length > 12 ? rules.length - 12 : undefined })}>{counts.total}</Derived></b>
          <span>Rules on {fund.kind === 'client' ? 'its sleeves' : 'this mandate'}</span>
        </div>
      </div>
      <div className="da-toolbar">
        <span className="da-note">
          Scored by the compliance engine at your As Of and Knowledge dates. Limits are set per sleeve in the rule book.{' '}
          <a href={host.href('/admin/compliance')}>Open the rule book</a>
        </span>
      </div>
      {rules.length === 0 ? (
        <Empty>No compliance rules are assigned to {fund.kind === 'client' ? 'this client’s sleeves' : 'this mandate'}.</Empty>
      ) : (
        <div className="da-main solo">
          <div className="da-gridwrap x-gridwrap">
            <table className="da-grid x-rules">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Rule</th>
                  {fund.kind === 'client' && <th>Sleeve</th>}
                  <th>Severity</th>
                  <th>Requirement</th>
                  <th className="num">Result</th>
                  <th className="num">Cushion</th>
                  <th>Worst dimension</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const key = `${r.sleeveId}:${r.ruleCode}`;
                  const isOpen = open.has(key);
                  const groups = r.groups.filter((g) => g.status !== 'na' || r.groups.length === 1);
                  return (
                    <Fragment key={key}>
                      <tr>
                        <td><span className={`da-st ${RULE_STATUS[r.status].tone}`}>{RULE_STATUS[r.status].label}</span></td>
                        <td className="x-nw">
                          <div className="da-name">
                            {groups.length > 1 ? <button className="da-caret" aria-expanded={isOpen} onClick={() => toggle(key)}>{isOpen ? '▾' : '▸'}</button> : <span className="x-sp" />}
                            <b title={r.description || undefined}>{r.ruleName}</b>
                          </div>
                        </td>
                        {fund.kind === 'client' && <td>{r.sleeveName}</td>}
                        <td>{r.severity ? <span className="cr-rule">{r.severity === 'Hard' ? 'Limit' : 'Guideline'}</span> : <span className="x-nil">·</span>}</td>
                        <td className="x-nw"><Derived name={`${r.ruleName} requirement`} how={() => how(r)}>{requirement(r)}</Derived></td>
                        <td className="num x-nw"><b><Derived name={`${r.ruleName} result`} how={() => how(r)}>{result(r)}</Derived></b></td>
                        <td className="num">{r.cushion != null && !r.attestation ? <Derived name={`${r.ruleName} cushion`} how={() => ({ ...how(r), title: `${r.ruleName}: cushion`, value: fmtRuleValue(r.unit, r.cushion), formula: 'The room left before the limit: the limit less the result for a maximum, the result less the limit for a minimum. Negative means the limit is passed.', rows: [{ label: 'Requirement', value: requirement(r) }, { label: 'Result', value: result(r) }] })}>{fmtRuleValue(r.unit, r.cushion)}</Derived> : ''}</td>
                        <td className="x-nw">{r.worst || r.dimension || ''}{r.measured < r.groups.length && r.unit === 'PERCENTAGE' && r.groups.length > 1 ? <small className="da-note"> · {r.measured} of {r.groups.length} measurable</small> : null}</td>
                      </tr>
                      {isOpen && groups.slice(0, 12).map((g) => (
                        <tr key={`${key}:${g.label}`} className="sub">
                          <td />
                          <td colSpan={fund.kind === 'client' ? 4 : 3} style={{ paddingLeft: 36 }}>{g.label}</td>
                          <td className="num"><Derived name={`${r.ruleName} ${g.label}`} how={() => how(r)}>{fmtRuleValue(r.unit, g.value)}</Derived></td>
                          <td className="num">{g.numerator != null && r.unit === 'PERCENTAGE' ? `${fmtUsd(g.numerator)} of ${fmtUsd(g.denominator)}` : ''}</td>
                          <td><span className={`da-st ${RULE_STATUS[g.status].tone}`}>{RULE_STATUS[g.status].label}</span></td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="da-sechead"><h2>Target bands</h2></div>
      <p className="da-note">Levels whose typed band is breached. These come from the targets on the Strategy, Region and Structure tabs, not from the rule book.</p>
      {bandIssues.length === 0 ? <p className="da-note">Every typed band is met.</p> : (
        <div className="da-gridwrap x-gridwrap">
          <table className="da-grid fit">
            <thead><tr><th>Hierarchy</th><th>Level</th><th>Measure</th><th>Status</th></tr></thead>
            <tbody>
              {bandIssues.slice(0, 40).map((b) => (
                <tr key={`${b.lens}:${b.key}:${b.measure}`}>
                  <td>{LENS_INFO[b.lens].label}</td>
                  <td>{b.label}</td>
                  <td>{b.measure}</td>
                  <td><span className="da-st breach">{b.text}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
