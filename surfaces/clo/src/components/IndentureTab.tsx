'use client';

import { useState } from 'react';
import type { Term, Test, Vehicle } from '../lib/data';
import { limitBind, onTxn, recordPath } from '../lib/binds';
import { testHow } from '../lib/how';
import { fmtDay, fmtNum, fmtPct, fmtTest, words } from '../lib/format';
import { groupCounts, termSections, testGroups } from '../lib/view';
import { Bound, BoundOr, Derived, Gauge, RecordLink, StatusPill } from './common';

export const INDENTURE_TAB = {
  label: 'Indenture',
  purpose: 'The open CLO’s indenture terms, and every test the indenture sets, as the compliance engine scores it today, with a drill-down into what drives each one.',
};

function termShown(t: Term): string {
  if (t.value == null || t.value === '') return '';
  if (t.dataType === 'DATE') return fmtDay(t.value);
  if (t.dataType === 'PERCENTAGE') return fmtPct(t.numeric);
  if (t.dataType === 'CURRENCY') return t.numeric != null ? `$${Math.round(t.numeric).toLocaleString('en-US')}` : t.value;
  if (t.dataType === 'BOOLEAN') return /^(true|t|1|yes)$/i.test(t.value) ? 'Yes' : 'No';
  if (t.dataType === 'JSON') {
    try { const parsed = JSON.parse(t.value); return Array.isArray(parsed) ? `${parsed.length} rows` : `${Object.keys(parsed).length} entries`; } catch { return t.value; }
  }
  if (t.numeric != null && /DECIMAL|NUMBER|INTEGER/.test(t.dataType)) return fmtNum(t.numeric, Number.isInteger(t.numeric) ? 0 : 2);
  return t.value;
}

/** What drives one test: the engine's own figures, the limit's source, and the records it reads. */
function Drill({ v, asOf, t, onClose }: { v: Vehicle; asOf: string; t: Test; onClose: () => void }) {
  const how = testHow(v, asOf, t);
  return (
    <section className="x-drill" aria-label={`What drives ${t.ruleName}`}>
      <header>
        <div>
          <h3>{t.ruleName}{t.group ? ` · ${t.group}` : ''}</h3>
          <p>{how.formula}</p>
        </div>
        <div className="x-acts"><StatusPill status={t.status} /> <button className="btn btn-sm" onClick={onClose}>Close</button></div>
      </header>
      <div className="x-frame x-short">
        <table className="da-grid x-table">
          <thead><tr><th className="x-name">What it reads</th><th className="num">Value</th></tr></thead>
          <tbody>
            {(how.rows || []).map((row, i) => (
              <tr key={`${row.label}-${i}`}>
                <td className="x-name"><div className="x-namebox"><b>{row.label}</b>{row.sub ? <small>{row.sub}</small> : null}</div></td>
                <td className="num">{row.bind ? <Bound {...row.bind} value={row.value}>{row.value}</Bound> : <Derived name={row.label} how={() => ({ title: `${t.ruleName} · ${row.label}`, value: row.value, formula: how.formula })}>{row.value}</Derived>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {how.more ? <p className="x-note">and {how.more} more holdings</p> : null}
    </section>
  );
}

export function IndentureTab({ v, asOf }: { v: Vehicle; asOf: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const key = (t: Test) => `${t.ruleCode}|${t.group ?? ''}`;
  const groups = testGroups(v);
  const openTest = v.tests.find((t) => key(t) === open) ?? null;
  return (
    <>
      <div className="x-section">
        <h2>Indenture terms</h2>
        <p>
          From the CLO&rsquo;s transaction record{v.transactionId ? <> (<RecordLink path={recordPath.transaction(v.transactionId)}>{v.transactionName}</RecordLink>)</> : null}. Right-click any term for its sources.
        </p>
        <div className="x-terms">
          {termSections(v).map(({ section, terms }) => (
            <section key={section}>
              <h3>{section}</h3>
              <dl>
                {terms.map((t) => (
                  <div key={t.code} style={{ display: 'contents' }}>
                    <dt>{t.name}</dt>
                    <dd><BoundOr bind={onTxn(v, t.code, t.name)} value={t.value} shown={termShown(t)} /></dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>

      <div className="x-section">
        <h2>Tests</h2>
        <p>Every test the compliance engine scores for this CLO as of {fmtDay(asOf)}, breaches first. A grouped test (industry, single obligor) shows its failing groups and its tightest passing one. Select a test to see what drives it.</p>
        {openTest && <Drill v={v} asOf={asOf} t={openTest} onClose={() => setOpen(null)} />}
        <div className="x-frame">
          <table className="da-grid x-table">
            <thead>
              <tr>
                <th className="x-name">Test</th>
                <th className="num">Value</th>
                <th className="num">Limit</th>
                <th className="num">Cushion</th>
                <th>Used</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => [
                <tr key={g.category} className="x-group"><td className="x-name" colSpan={6}>{g.label}</td></tr>,
                ...g.tests.map((t) => {
                  const lb = limitBind(v, t);
                  const counts = t.group ? groupCounts(v, t.ruleCode) : null;
                  const limitShown = fmtTest(t, t.limit);
                  return (
                    <tr key={key(t)} className={`x-click${open === key(t) ? ' x-on' : ''}`} onClick={() => setOpen(open === key(t) ? null : key(t))}>
                      <td className="x-name">
                        <div className="x-namebox">
                          <b>{t.ruleName}</b>
                          <small>{[t.group, counts ? `${counts.failing} of ${counts.scored} groups fail` : null, t.direction === 'MIN' ? 'minimum' : 'maximum', t.error ? `error: ${t.error}` : null].filter(Boolean).join(' · ')}</small>
                        </div>
                      </td>
                      <td className="num">{t.value == null ? <span className="x-nil">—</span> : <Derived className={t.status === 'HARD_BREACH' ? 'x-dn' : undefined} name={t.ruleName} how={() => testHow(v, asOf, t)}>{fmtTest(t, t.value)}</Derived>}</td>
                      <td className="num">{t.limit == null ? <span className="x-nil">—</span> : lb ? <Bound {...lb} value={limitShown}>{limitShown}</Bound> : <Derived name={`${t.ruleName} limit`} how={() => ({ title: `${t.ruleName} · Limit`, value: limitShown, formula: 'The rule’s own limit: the indenture data holds no number for it.' })}>{limitShown}</Derived>}</td>
                      <td className="num">{t.cushion == null ? <span className="x-nil">—</span> : <Derived className={t.cushion < 0 ? 'x-dn' : undefined} name={`${t.ruleName} cushion`} how={() => testHow(v, asOf, t)}>{fmtTest(t, t.cushion)}</Derived>}</td>
                      <td><Gauge value={t.value} limit={t.limit} direction={t.direction} /></td>
                      <td><StatusPill status={t.status} /></td>
                    </tr>
                  );
                }),
              ])}
            </tbody>
          </table>
        </div>
        <p className="x-note">Units: coverage and concentration tests are percent; WARF is a rating factor; WAS is basis points; WAL is years; eligibility tests count holdings. Category names come from the rule: {[...new Set(v.tests.map((t) => words(t.category)))].join(', ')}.</p>
      </div>
    </>
  );
}
