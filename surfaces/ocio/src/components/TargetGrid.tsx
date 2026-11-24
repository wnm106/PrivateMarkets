'use client';

import { useMemo, useState, type KeyboardEvent } from 'react';
import type { Commitment, Fund, Lens, OcioData, TargetMatrix } from '../lib/types';
import { MEASURES, fmtMeasure, fmtPct, fmtUsd, parseMeasure, type Measure } from '../lib/format';
import {
  LENS_INFO, actualMap, band, childSums, comparatorOf, countBelow, effPct, effUsd, hasTarget, measureStatus, nodeLabel, tagKeys, walk, withCell, worstStatus,
  type Actuals, type Suf, type TreeNode, type Trees,
} from '../lib/tree';
import { cellBind, commitmentBind, fundBind, shownTargetBind, targetBind } from '../lib/binds';
import { BandBar, Bound, BoundIf, Derived, Dot, useInputInspect, type BindTarget, type Derivation } from './common';

const SUFS: Suf[] = ['Min', '', 'Max'];
const LISTED = 12;

export interface TargetEdit {
  /** The next matrix, when a band cell changed. */
  matrix?: TargetMatrix;
  /** Program dollars or investment count, when the Total program target changed. */
  program?: { k: 'usd' | 'n'; v: number };
  reason: string;
}

function Cell({ k, value, placeholder, disabled, target, label, onCommit, col, bind, implied, autoFocus }: {
  k: Measure;
  value: number | null | undefined;
  placeholder: string;
  disabled?: boolean;
  target?: boolean;
  label: string;
  col: string;
  /** This value's own attribute on the level's target record. Null while the level has no record. */
  bind: BindTarget | null;
  /** How the figure in the box is implied by another measure, when nothing is typed here. */
  implied?: () => Derivation;
  autoFocus?: boolean;
  onCommit: (v: number | null) => void;
}) {
  const shown = value == null ? '' : fmtMeasure(k, value);
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const menu = useInputInspect(bind, shown || undefined, implied);
  const commit = () => {
    if (draft == null) return;
    const parsed = parseMeasure(k, draft);
    if (!parsed.ok) { setBad(true); return; }
    setBad(false);
    setDraft(null);
    if ((parsed.v ?? null) !== (value ?? null)) onCommit(parsed.v);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      commit();
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(`.ocio input[data-col="${col}"]:not(:disabled)`));
      const i = inputs.indexOf(e.currentTarget);
      inputs[e.key === 'ArrowUp' ? i - 1 : i + 1]?.focus();
    } else if (e.key === 'Escape') {
      setDraft(null);
      setBad(false);
    }
  };
  // An implied value (≈) or a typed one fills the box; an empty min or max stays a quiet hint.
  const quiet = !target && shown === '' && !placeholder.startsWith('≈');
  return (
    <input
      className={`${target ? 'tgt' : 'mm'}${quiet ? ' quiet' : ''}`}
      value={draft ?? shown}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      aria-label={label}
      aria-invalid={bad || undefined}
      data-col={col}
      data-attr={bind?.code}
      data-derived={implied && (!shown || !bind) ? label : undefined}
      data-editable="true"
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={onKey}
      {...menu}
    />
  );
}

function defaultOpen(f: Fund, lens: Lens, root: TreeNode): Set<string> {
  const open = new Set<string>(['']);
  walk(root, (n) => { if (n.depth >= 1 && countBelow(f, lens, n) > 0) open.add(n.key); });
  return open;
}

/** The commitments that count toward a level, largest first. */
function behind(list: Commitment[], lens: Lens, node: TreeNode): Commitment[] {
  return list.filter((c) => tagKeys(c.tags, lens).includes(node.key)).sort((a, b) => b.amount - a.amount);
}

function commitmentRows(rows: Commitment[]): Pick<Derivation, 'rows' | 'more'> {
  return {
    rows: rows.slice(0, LISTED).map((c) => ({ label: c.name, sub: [c.manager, c.date].filter(Boolean).join(' · '), value: fmtUsd(c.amount), bind: commitmentBind.amount(c) })),
    more: rows.length > LISTED ? rows.length - LISTED : undefined,
  };
}

export function TargetGrid({ fund, lens, data, trees, list, editable, onEdit }: {
  fund: Fund;
  lens: Lens;
  data: OcioData;
  trees: Trees;
  list: Commitment[];
  editable: boolean;
  onEdit: (edit: TargetEdit) => void;
}) {
  const root = trees.roots[lens];
  const [open, setOpen] = useState<Set<string>>(() => defaultOpen(fund, lens, root));
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [assignedOnly, setAssignedOnly] = useState(false);
  const A: Actuals = useMemo(() => actualMap(list, lens), [list, lens]);
  const info = LENS_INFO[lens];
  const client = fund.kind === 'sleeve' ? data.funds.find((f) => f.id === fund.parentId) ?? null : null;
  const sleeves = fund.kind === 'client' ? data.funds.filter((s) => s.parentId === fund.id) : [];

  const rows = useMemo(() => {
    const out: TreeNode[] = [];
    const q = query.trim().toLowerCase();
    const matches = (n: TreeNode): boolean => n.name.toLowerCase().includes(q) || n.children.some(matches);
    const visit = (n: TreeNode) => {
      if (n.depth > 0) {
        if (q && !matches(n)) return;
        if (assignedOnly && !hasTarget(fund.matrix[lens][n.key]) && countBelow(fund, lens, n) === 0) return;
      }
      out.push(n);
      if (q || open.has(n.key)) n.children.forEach(visit);
    };
    visit(root);
    return out;
  }, [root, open, query, assignedOnly, fund, lens]);

  const toggle = (key: string) => setOpen((s) => { const next = new Set(s); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const setCell = (n: TreeNode, k: Measure, suf: Suf, v: number | null) => {
    const label = `${nodeLabel(n)} ${MEASURES.find((m) => m.k === k)?.name.toLowerCase()} ${suf ? suf.toLowerCase() : 'target'}`;
    if (n.depth === 0 && suf === '' && (k === 'usd' || k === 'n')) {
      if (v == null) return;
      onEdit({ program: { k, v }, reason: `OCIO target: ${label} set to ${fmtMeasure(k, v)}` });
      return;
    }
    onEdit({ matrix: withCell(fund, lens, n.key, k, suf, v), reason: `OCIO target: ${label} ${v == null ? 'cleared' : `set to ${fmtMeasure(k, v)}`}` });
  };
  const clearRow = (n: TreeNode) => {
    const matrix = structuredClone(fund.matrix);
    delete matrix[lens][n.key];
    onEdit({ matrix, reason: `OCIO target: cleared ${nodeLabel(n)}` });
  };
  const startEditing = (n: TreeNode) => {
    setEditing((s) => new Set(s).add(n.key));
    setFocus(n.key);
  };
  const pctNote = fund.basis === 'PARENT_LEVEL' ? '% of parent level' : '% of program';

  /** How the committed figure beside a band is worked out. */
  const actualHow = (n: TreeNode, k: Measure, a: number | null) => (): Derivation => {
    const mine = behind(list, lens, n);
    const where = n.depth === 0 ? `${fund.name}` : `${nodeLabel(n)} in the ${info.label} hierarchy`;
    if (k === 'pct') {
      const baseKey = fund.basis === 'PARENT_LEVEL' ? n.parent?.key ?? '' : '';
      return {
        title: `${nodeLabel(n)} share of committed`,
        value: fmtPct(a),
        formula: `Dollars committed at this level, divided by dollars committed ${fund.basis === 'PARENT_LEVEL' ? 'at the level above' : 'across the whole program'}, as of your As Of date. Only a typed percent band is judged against it.`,
        rows: [
          { label: 'Committed at this level', value: fmtUsd(A[n.key]?.usd ?? 0) || '$0' },
          { label: fund.basis === 'PARENT_LEVEL' ? 'Committed at the level above' : 'Committed across the program', value: fmtUsd(A[baseKey]?.usd ?? 0) || '$0' },
        ],
      };
    }
    return {
      title: `${nodeLabel(n)} ${k === 'usd' ? 'committed' : 'investments made'}`,
      value: fmtMeasure(k, a),
      formula: k === 'usd'
        ? `Original commitments booked to ${where}, added up, as of your As Of date.`
        : `The number of original commitments booked to ${where}, as of your As Of date.`,
      ...commitmentRows(mine),
    };
  };

  return (
    <section className="da-sec">
      <div className="da-toolbar">
        <input className="pipe-search" type="search" placeholder="Find a level, e.g. Mid Cap" aria-label="Find a level" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label><input type="checkbox" checked={assignedOnly} onChange={(e) => setAssignedOnly(e.target.checked)} /> Assigned only</label>
        <button className="btn btn-sm" onClick={() => { const all = new Set<string>(); walk(root, (n) => { if (n.children.length) all.add(n.key); }); setOpen(all); }}>Expand all</button>
        <button className="btn btn-sm" onClick={() => setOpen(new Set(['']))}>Collapse</button>
        <span className="da-note">$ in millions unless you type K or B · Tab across min / target / max · Enter moves down · {pctNote} · right-click any figure for its sources</span>
      </div>
      <div className="da-gridwrap x-gridwrap">
        <table className="da-grid x-grid">
          <thead>
            <tr>
              <th className="x-namecol">{info.path}</th>
              {MEASURES.map((m) => (
                <th key={m.k} className={`num x-m x-m-${m.k}`} title="Minimum, target and maximum. The bar shows commitments against the band (shaded) and target (tick).">
                  {m.sym} {m.name}
                  <div className="x-mh"><i>Min</i><i>Target</i><i>Max</i></div>
                </th>
              ))}
              <th className="num" title="Sum of the next level's targets compared with this row">Children Σ</th>
              <th className="num" title={fund.kind === 'client' ? 'Total of the sleeves’ dollar targets' : 'This client’s macro target for the same level'}>{fund.kind === 'client' ? 'Σ Sleeves' : 'Client target'}</th>
              <th className="x-clearcol" aria-label="Clear" />
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => {
              const t = n.depth === 0 ? null : fund.matrix[lens][n.key];
              const has = hasTarget(t);
              const below = n.children.length && !open.has(n.key) ? countBelow(fund, lens, n) : 0;
              const worst = worstStatus(fund, lens, n, A);
              const cmp = comparatorOf(fund, data.funds, lens, n);
              const sums = childSums(fund, lens, n);
              // A level with no target and no commitments is one quiet line until someone sets a target on it.
              const full = n.depth === 0 || has || A[n.key] != null || editing.has(n.key);
              return (
                <tr
                  key={n.key || 'root'}
                  className={`${n.depth === 0 ? 'x-root' : ''}${has ? ' x-has' : ''}${full ? '' : ' x-bare'}`}
                  onBlur={(e) => {
                    if (!editing.has(n.key) || e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                    setEditing((s) => { const next = new Set(s); next.delete(n.key); return next; });
                    setFocus(null);
                  }}
                >
                  <td className="x-namecol" style={{ paddingLeft: 10 + n.depth * 14 }}>
                    <div className="da-name">
                      {n.children.length
                        ? <button className="da-caret" aria-expanded={open.has(n.key)} aria-label={`${open.has(n.key) ? 'Collapse' : 'Expand'} ${n.name}`} onClick={() => toggle(n.key)}>{open.has(n.key) ? '▾' : '▸'}</button>
                        : <span className="x-sp" />}
                      <span className="cr-type other">{n.tag}</span>
                      <b>{n.name}</b>
                      {below > 0 && <span className="cr-n" title={`${below} targets below`}>{below} below</span>}
                      {worst.cls !== 'none' && <Dot cls={worst.cls} title={worst.text} />}
                    </div>
                  </td>
                  {!full ? MEASURES.map((m, i) => (
                    // One cell per group, so the dividers between groups run unbroken down the grid.
                    <td key={m.k} className={`x-m x-m-${m.k} x-barecell`}>
                      {i === 0 && (editable
                        ? <button className="x-addtarget" aria-label={`Set a target for ${n.name}`} onClick={() => startEditing(n)}>+ Set target</button>
                        : <span className="x-nil">No target</span>)}
                    </td>
                  )) : MEASURES.map((m) => {
                    const ms = measureStatus(fund, lens, n, A, m.k);
                    const hint = band(fund, lens, n, m.k);
                    const pctRoot = n.depth === 0 && m.k === 'pct';
                    return (
                      <td key={m.k} className={`num x-m x-m-${m.k}`}>
                        <div className="x-trio">
                          {SUFS.map((suf) => {
                            const typed = n.depth === 0 ? (pctRoot ? (suf === '' ? 100 : null) : (suf === '' ? (m.k === 'usd' ? fund.programUsd : m.k === 'n' ? fund.programN : null) : (fund.matrix.program as Record<string, number | undefined>)[`${m.k}${suf}`] ?? null)) : (t as Record<string, number | undefined> | undefined)?.[`${m.k}${suf}`] ?? null;
                            const h = hint[SUFS.indexOf(suf)];
                            const placeholder = typed == null && h.imp && h.v != null ? `≈${fmtMeasure(m.k, h.v)}` : suf === '' ? '—' : suf.toLowerCase();
                            return (
                              <Cell
                                key={suf || 't'}
                                k={m.k}
                                col={`${lens}-${m.k}-${suf || 't'}`}
                                value={typed}
                                target={suf === ''}
                                placeholder={placeholder}
                                disabled={!editable || pctRoot}
                                autoFocus={focus === n.key && m.k === 'usd' && suf === ''}
                                bind={cellBind(fund, lens, n, m.k, suf)}
                                implied={pctRoot && suf === '' ? () => ({ title: 'Total program percent', value: '100%', formula: 'The total program is the whole: every percent target is a share of it, or of the level above when the percent basis is Parent level. It is not entered.' }) : typed == null && h.imp && h.v != null ? () => ({
                                  title: `${nodeLabel(n)}: ${m.name.toLowerCase()} ${suf ? suf.toLowerCase() : 'target'}`,
                                  value: `≈${fmtMeasure(m.k, h.v)}`,
                                  formula: m.k === 'usd'
                                    ? `Not entered. Implied by this level's percent ${suf ? suf.toLowerCase() : 'target'}: that share of ${fund.basis === 'PARENT_LEVEL' ? 'the level above' : 'the program'}. Type a figure here to set it directly.`
                                    : `Not entered. Implied by this level's dollar ${suf ? suf.toLowerCase() : 'target'}: its share of ${fund.basis === 'PARENT_LEVEL' ? 'the level above' : 'the program'}. Type a figure here to set it directly.`,
                                  rows: (() => {
                                    const from = `${m.k === 'usd' ? 'pct' : 'usd'}${suf}` as 'usd';
                                    const entered = n.depth === 0 ? null : fund.matrix[lens][n.key]?.[from];
                                    return entered != null ? [{ label: 'Entered', value: fmtMeasure(m.k === 'usd' ? 'pct' : 'usd', entered), bind: targetBind(fund, lens, n.key, from) ?? undefined }] : [];
                                  })(),
                                }) : undefined}
                                label={`${n.name} ${m.name} ${suf ? suf.toLowerCase() : 'target'}`}
                                onCommit={(v) => setCell(n, m.k, suf, v)}
                              />
                            );
                          })}
                        </div>
                        {pctRoot
                          ? <div className="x-band"><span className="x-nil">of program</span></div>
                          : (
                            <BandBar
                              k={m.k}
                              a={ms.a}
                              b={ms.b}
                              st={ms.st}
                              actual={ms.a != null ? <Derived name={`${n.name} ${m.name.toLowerCase()} committed`} how={actualHow(n, m.k, ms.a)}>{fmtMeasure(m.k, ms.a)}</Derived> : undefined}
                            />
                          )}
                      </td>
                    );
                  })}
                  <td className="num">
                    <div className="x-sum">
                      {sums.map((s) => (
                        <Derived
                          key={s.sym}
                          name={`${n.name} children ${s.sym === '$' ? 'dollar' : 'investment'} targets`}
                          how={() => ({
                            title: `${nodeLabel(n)}: next level's ${s.sym === '$' ? 'dollar targets' : 'investment counts'}`,
                            value: s.text,
                            formula: s.sym === '$'
                              ? 'The next level’s dollar targets (typed, or implied by a percent) added up, as a share of this row’s target. Children do not have to add up; this shows the gap.'
                              : 'The next level’s investment-count targets added up, against this row’s count.',
                            rows: n.children
                              .map((ch) => ({ ch, v: s.sym === '$' ? effUsd(fund, lens, ch) : fund.matrix[lens][ch.key]?.n ?? null }))
                              .filter((x) => x.v != null)
                              .map((x) => ({ label: x.ch.name, value: s.sym === '$' ? fmtUsd(x.v) : String(x.v), bind: (s.sym === '$' ? shownTargetBind(fund, lens, x.ch.key, 'usd') : targetBind(fund, lens, x.ch.key, 'n')) ?? undefined })),
                          })}
                        >
                          <span className={`da-st ${s.tone === 'ok' ? 'ok' : s.tone === 'under' ? 'near' : 'breach'}`} title={s.title}>{s.text}</span>
                        </Derived>
                      ))}
                    </div>
                  </td>
                  <td className="num x-cmp">
                    {!cmp ? <span className="x-nil">·</span>
                      : fund.kind === 'client'
                        ? (
                          <Derived
                            name={`${n.name} sleeves' dollar targets`}
                            how={() => ({
                              title: `${nodeLabel(n)}: sleeves' dollar targets`,
                              value: fmtUsd(cmp.usd),
                              formula: `Each sleeve's dollar target for this level (typed, or implied by a percent), added up. ${cmp.sleevesSet} of ${cmp.sleeves} sleeves set one.`,
                              rows: sleeves.map((s) => ({ s, v: effUsd(s, lens, n) })).filter((x) => x.v != null).map((x) => ({ label: x.s.name, value: fmtUsd(x.v), bind: (n.depth === 0 ? fundBind.program(x.s) : shownTargetBind(x.s, lens, n.key, 'usd')) ?? undefined })),
                            })}
                          >
                            {fmtUsd(cmp.usd)} · {cmp.sleevesSet}/{cmp.sleeves}
                          </Derived>
                        )
                        : client && (
                          <>
                            {cmp.usd != null && <BoundIf bind={n.depth === 0 ? fundBind.program(client) : shownTargetBind(client, lens, n.key, 'usd')} value={fmtUsd(cmp.usd)}>{fmtUsd(cmp.usd)}</BoundIf>}
                            {cmp.pct != null && <> · <BoundIf bind={shownTargetBind(client, lens, n.key, 'pct')} value={fmtPct(cmp.pct)}>{fmtPct(cmp.pct)}</BoundIf></>}
                            {cmp.n != null && <> · <BoundIf bind={n.depth === 0 ? fundBind.count(client) : targetBind(client, lens, n.key, 'n')} value={`${cmp.n}`}>{cmp.n}#</BoundIf></>}
                          </>
                        )}
                  </td>
                  <td className="x-clearcol">
                    {has && editable && <button className="btn btn-sm" title="Clear targets on this row" aria-label={`Clear ${n.name} targets`} onClick={() => clearRow(n)}>×</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The side list of every assigned target across the three hierarchies. */
export function AssignedTargets({ fund, trees, list, onOpen, onHide }: { fund: Fund; trees: Trees; list: Commitment[]; onOpen: (lens: Lens) => void; onHide: () => void }) {
  return (
    <aside className="x-side" aria-label="Assigned targets">
      <div className="x-sidehead">
        <h2>Assigned targets</h2>
        <button className="btn btn-sm" onClick={onHide} title="Hide this panel to give the grid more room">Hide</button>
      </div>
      {(['strategy', 'region', 'structure'] as Lens[]).map((lens) => {
        const A = actualMap(list, lens);
        const nodes: TreeNode[] = [];
        walk(trees.roots[lens], (n) => { if (n.depth && hasTarget(fund.matrix[lens][n.key])) nodes.push(n); });
        return (
          <section key={lens}>
            <button className="x-gh" title={`Open the ${LENS_INFO[lens].label} targets`} onClick={() => onOpen(lens)}>
              <span>{LENS_INFO[lens].label}</span>
              <small>{nodes.length} target{nodes.length === 1 ? '' : 's'}</small>
            </button>
            <p className="da-note">{LENS_INFO[lens].path}</p>
            {nodes.length === 0 && <p className="da-note">No targets yet.</p>}
            {nodes.map((n) => {
              const t = fund.matrix[lens][n.key] || {};
              const w = worstStatus(fund, lens, n, A);
              const u = effUsd(fund, lens, n);
              const pc = effPct(fund, lens, n);
              // Each figure opens the value that was entered: its own attribute, or the one it is implied by.
              const values = [
                t.usd != null ? { text: fmtUsd(t.usd), bind: targetBind(fund, lens, n.key, 'usd') } : u != null ? { text: `≈${fmtUsd(u)}`, bind: shownTargetBind(fund, lens, n.key, 'usd') } : null,
                t.pct != null ? { text: fmtPct(t.pct), bind: targetBind(fund, lens, n.key, 'pct') } : pc != null ? { text: `≈${fmtPct(pc)}`, bind: shownTargetBind(fund, lens, n.key, 'pct') } : null,
                t.n != null ? { text: `${t.n}#`, bind: targetBind(fund, lens, n.key, 'n') } : null,
              ].filter((v): v is { text: string; bind: BindTarget | null } => v != null);
              const ranges = [
                t.usdMin != null || t.usdMax != null ? { text: `${fmtUsd(t.usdMin) || '…'}–${fmtUsd(t.usdMax) || '…'}`, bind: targetBind(fund, lens, n.key, t.usdMin != null ? 'usdMin' : 'usdMax') } : null,
                t.nMin != null || t.nMax != null ? { text: `${t.nMin ?? '…'}–${t.nMax ?? '…'}#`, bind: targetBind(fund, lens, n.key, t.nMin != null ? 'nMin' : 'nMax') } : null,
                t.pctMin != null || t.pctMax != null ? { text: `${fmtPct(t.pctMin) || '…'}–${fmtPct(t.pctMax) || '…'}`, bind: targetBind(fund, lens, n.key, t.pctMin != null ? 'pctMin' : 'pctMax') } : null,
              ].filter((v): v is { text: string; bind: BindTarget | null } => v != null);
              return (
                <div key={n.key} className="x-srow" style={{ paddingLeft: (n.depth - 1) * 10 }} title={nodeLabel(n)}>
                  <button className="x-sname" onClick={() => onOpen(lens)}><Dot cls={w.cls === 'none' ? '' : w.cls} title={w.text} />{n.name}</button>
                  <span className="x-vals">
                    {values.map((v, i) => <BoundIf key={i} bind={v.bind} value={v.text} className={v.text.startsWith('≈') ? 'x-imp' : 'x-typed'}>{v.text}</BoundIf>)}
                  </span>
                  {ranges.length > 0 && <span className="x-rgl">range {ranges.map((v, i) => <span key={i}>{i > 0 ? ' · ' : ''}<BoundIf bind={v.bind} value={v.text}>{v.text}</BoundIf></span>)}</span>}
                </div>
              );
            })}
          </section>
        );
      })}
      <div className="x-legend">
        <span><Dot cls="in" />In range or at target</span>
        <span><Dot cls="under" />Building toward a target</span>
        <span><Dot cls="below" />Below a minimum</span>
        <span><Dot cls="above" />Above a maximum or over target</span>
      </div>
    </aside>
  );
}
