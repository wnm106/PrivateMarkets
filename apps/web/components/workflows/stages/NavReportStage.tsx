'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ConfirmButton } from '@/components/feeds/ConfirmButton';
import { SourcePane, type SourceTarget } from '@/components/feeds/SourcePane';
import type { readNavReport } from '@tapestrai/mcp-server/src/feeds/nav-report';
import type { StageScreenProps } from './index';
import { useReportProgress } from './useProgress';

type NavReport = Awaited<ReturnType<typeof readNavReport>>;
type Statement = NavReport['report']['statements'][number];

const card: CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, padding: 12, background: '#fff', display: 'grid', gap: 6, minWidth: 0 };
const label: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.4 };
const cell: CSSProperties = { padding: '3px 6px', borderBottom: '1px solid var(--line)', fontSize: 12, verticalAlign: 'top' };
const num: CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const linkButton: CSSProperties = { border: 'none', background: 'none', padding: 0, font: 'inherit', cursor: 'pointer', textAlign: 'left', textDecoration: 'underline dotted', textUnderlineOffset: 3, color: 'inherit' };

async function json<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'That could not be done');
  return data as T;
}

/** Whole dollars as $ millions; share counts and per-share amounts as printed. */
function amount(value: number | null | undefined, unit: string = 'AMOUNT'): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (unit === 'SHARES') return Math.round(value).toLocaleString('en-US');
  if (unit === 'PER_SHARE') return value.toFixed(2);
  const millions = value / 1e6;
  const text = Math.abs(millions).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return millions < 0 ? `(${text})` : text;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

function statementName(kind: string): string {
  return ({ BALANCE_SHEET: 'Balance sheet', OPERATIONS: 'Operations', CHANGES: 'Changes in net assets', CASH_FLOWS: 'Cash flows' } as Record<string, string>)[kind] || kind;
}

/**
 * A filed report the NAV reconciliation could not load on its own. The reasons
 * come first, then the fund to choose when the report does not name one on
 * file, and what the load would write: the report on the left, and on the right
 * the period and the date it compares with, the report's own checks, each
 * statement on the NAV chart with the lines behind each figure, the lines left
 * out, the schedule of investments, and a trial load. Pointing at a line shows
 * it in the report.
 */
export function NavReportStage({ stage, busy, onComplete, onProgress }: StageScreenProps) {
  const fileId = String(stage.args.importInstanceId || '');
  const selection = Array.isArray(stage.args.entityIds) ? stage.args.entityIds.map(String).filter(Boolean) : [];
  const selectionKey = selection.join(',');
  const periodEnd = String(stage.args.periodEnd || '');
  const [chosenFund, setChosenFund] = useState('');
  const [report, setReport] = useState<NavReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [pointing, setPointing] = useState<SourceTarget | null>(null);
  const [shownTable, setShownTable] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState<string>('BALANCE_SHEET');

  useEffect(() => {
    if (!fileId) {
      setError('This stage was not given a file.');
      return;
    }
    let live = true;
    setError(null);
    const query = new URLSearchParams({
      ...(chosenFund ? { fundId: chosenFund } : {}),
      ...(selectionKey ? { entityIds: selectionKey } : {}),
      ...(periodEnd ? { periodEnd } : {}),
    });
    json<NavReport>(`/api/feeds/position-file/${fileId}/nav-report?${query}`)
      .then((next) => live && setReport(next))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [fileId, chosenFund, selectionKey, periodEnd]);

  /** Show a line of a statement in the report: that statement's table is chosen, then the row and column are pointed at. */
  const show = useCallback(async (tableId: string, row: number, column: string | null, text: string) => {
    try {
      if (shownTable !== tableId) {
        await json(`/api/feeds/position-file/${fileId}/table`, { tableId });
        setShownTable(tableId);
        setRevision((value) => value + 1);
      }
      setPointing({ row, column: column || undefined, label: text });
    } catch (err: any) {
      setError(err.message);
    }
  }, [fileId, shownTable]);

  async function confirm() {
    setWorking(true);
    setError(null);
    try {
      await onComplete('confirmed', {
        fundId: report?.fund?.id || chosenFund || null,
        confirmed: true,
        periodEnd: report?.report.periodEnd || periodEnd || null,
        comparativeDate: report?.report.comparativeDate || null,
        holds: report?.holds ?? [],
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  }

  const unmapped = useMemo(() => (report ? report.report.statements.flatMap((item) => item.unmapped.map((entry) => ({ ...entry, statement: item }))) : []), [report]);
  const notTied = report?.checks.notTied ?? [];
  useReportProgress(onProgress, report ? {
    parts: [
      { label: 'Choose the fund', done: Boolean(report.fund), note: report.fund ? report.fund.name : 'Not found from the report' },
      { label: 'Read why the report was held', done: true, note: plural(report.holds.length, 'reason') },
      { label: 'Check the period and the date it compares with', done: Boolean(report.report.periodEnd), note: report.report.comparativeDate ? `${report.report.periodEnd} against ${report.report.comparativeDate}` : report.report.periodEnd || undefined },
      { label: 'Check the report\'s own checks', done: true, note: `${report.checks.ties} of ${report.checks.total} tie` },
      { label: 'Check the lines left out', done: true, note: plural(unmapped.length, 'line') },
      { label: 'Confirm and load', done: false },
    ],
  } : null);

  if (error && !report) return <div role="alert" style={{ color: 'var(--red)' }}>{error}</div>;
  if (!report) return <div style={{ color: 'var(--ink-3)' }}>Reading the report…</div>;

  const disabled = busy || working;
  const statementTrial = report.trial?.statement;
  const positionTrial = report.trial?.positions;
  const columnOf = (statement: Statement, which: 'period' | 'comparative') => (which === 'period' ? statement.periodColumn : statement.comparativeColumn);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {error && <div role="alert" style={{ color: 'var(--red)' }}>{error}</div>}
      <div className="stage-split stage-split-file-first">
        <div className="stage-source">
          <SourcePane instanceId={fileId} fileName={report.fileName} target={pointing} revision={revision} height="min(75vh, 680px)" />
        </div>

        <div style={{ display: 'grid', gap: 10, minWidth: 0, alignContent: 'start' }}>
          {report.holds.length > 0 && (
            <div style={{ ...card, borderColor: '#f79009', background: '#fffaeb' }} role="status">
              <span style={label}>Why this needs you</span>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {report.holds.map((hold) => <li key={hold}>{hold}</li>)}
              </ul>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Everything else in the run goes on without a person. Loading confirms you have looked at these.</span>
            </div>
          )}

          <div style={card}>
            <span style={label}>Fund</span>
            {report.fund
              ? <span style={{ fontSize: 13 }}><b>{report.fund.name}</b> ({report.fund.code}). {report.fundNote}</span>
              : <span style={{ fontSize: 13, color: '#b42318' }}>{report.fundNote}</span>}
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>{report.fund ? 'Load it onto another fund' : 'Choose the fund the report is for'}</span>
              <select aria-label="Fund the report is for" value={chosenFund || report.fund?.id || ''} disabled={disabled} onChange={(event) => { setReport(null); setChosenFund(event.target.value); }}>
                {!report.fund && <option value="">Choose a fund</option>}
                {report.fundChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.name} ({choice.code})</option>)}
              </select>
            </label>
          </div>

          <div style={card}>
            <span style={label}>What this is</span>
            <span style={{ fontSize: 14 }}>
              <b>{report.report.form ? `${report.report.form} ` : ''}{report.report.entityName || report.fileName}</b>
            </span>
            <span style={{ fontSize: 13 }}>
              Period end <b>{report.report.periodEnd || 'not found'}</b>
              {report.report.comparativeDate ? <>, compared with <b>{report.report.comparativeDate}</b> ({plural(report.report.months || 0, 'month')} of flows)</> : null}.
            </span>
            {report.fund && report.statement && (
              <span style={{ fontSize: 13 }}>
                Loads onto <b>{report.fund.name}</b> ({report.fund.code}) as the administrator&apos;s figures, on {report.statement.exists ? 'its NAV statement' : 'a new NAV statement'} {report.statement.code}.
              </span>
            )}
            {report.problems.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#b42318' }}>
                {report.problems.map((problem) => <li key={problem}>{problem}</li>)}
              </ul>
            )}
          </div>

          <div style={card}>
            <span style={label}>The report&apos;s own checks</span>
            <span style={{ fontSize: 13 }}>
              {report.checks.total === 0
                ? 'The report has no subtotals or share classes to check.'
                : <><b>{report.checks.ties} of {report.checks.total}</b> of its subtotals, totals and share-class NAV checks tie.</>}
            </span>
            {notTied.length > 0 && (
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th style={cell}>Check</th><th style={num}>Printed</th><th style={num}>Adds up to</th><th style={num}>Difference</th></tr></thead>
                <tbody>
                  {notTied.map((item) => (
                    <tr key={`${item.label}-${item.where}`}>
                      <td style={cell}>{item.label}<div style={{ color: 'var(--ink-3)' }}>{item.where} · {item.result}</div></td>
                      <td style={num}>{amount(item.reported)}</td>
                      <td style={num}>{amount(item.computed)}</td>
                      <td style={num}>{amount(item.difference)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {report.report.statements.map((statement) => {
            const isOpen = open === statement.kind;
            return (
              <div key={statement.kind} style={card}>
                <button type="button" onClick={() => setOpen(isOpen ? '' : statement.kind)} aria-expanded={isOpen} style={{ ...linkButton, textDecoration: 'none', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={label}>{statementName(statement.kind)}</span>
                  <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                    {plural(statement.lines.length, 'chart line')}{statement.unmapped.length ? `, ${plural(statement.unmapped.length, 'line')} left out` : ''} {isOpen ? '▾' : '▸'}
                  </span>
                </button>
                {isOpen && (
                  <>
                    <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                      Read from “{statement.periodColumn || 'no column'}”{statement.comparativeColumn ? ` and “${statement.comparativeColumn}”` : ''}.
                    </span>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                        <thead>
                          <tr>
                            <th style={cell}>NAV chart line</th>
                            <th style={num}>{report.report.periodEnd}</th>
                            {statement.comparativeColumn && <th style={num}>{report.report.comparativeDate}</th>}
                            <th style={cell}>From the report</th>
                          </tr>
                        </thead>
                        <tbody>
                          {statement.lines.map((line) => (
                            <tr key={line.code}>
                              <td style={cell}>{line.name}{line.note && <div style={{ color: '#b42318' }}>{line.note}</div>}</td>
                              <td style={num}>{amount(line.period, line.unit)}</td>
                              {statement.comparativeColumn && <td style={num}>{amount(line.comparative, line.unit)}</td>}
                              <td style={cell}>
                                {line.from.map((source, index) => (
                                  <div key={`${line.code}-${index}`}>
                                    <button type="button" style={linkButton} title="Show this line in the report" onClick={() => void show(statement.tableId, line.rows[index], columnOf(statement, 'period'), source)}>{source}</button>
                                  </div>
                                ))}
                                {line.detail > 0 && <div style={{ color: 'var(--ink-3)' }}>The report&apos;s total is used; {plural(line.detail, 'line')} under it are detail.</div>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {statement.unmapped.length > 0 && (
                      <div style={{ display: 'grid', gap: 4 }}>
                        <span style={label}>Left out</span>
                        {statement.unmapped.map((entry) => (
                          <span key={`${entry.row}-${entry.label}`} style={{ fontSize: 12 }}>
                            <button type="button" style={linkButton} onClick={() => void show(statement.tableId, entry.row, null, entry.label)}>{entry.section ? `${entry.section}: ` : ''}{entry.label}</button>
                            <span style={{ color: 'var(--ink-3)' }}> — {entry.reason}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}

          <div style={card}>
            <span style={label}>Schedule of investments</span>
            {report.report.schedule ? (
              <>
                <span style={{ fontSize: 13 }}>
                  <b>{plural(report.report.schedule.investments, 'investment')}</b> at {report.report.schedule.date}, each loaded as a position of the fund.
                </span>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr><th style={cell}>Asset class</th><th style={num}>Investments</th><th style={num}>Cost</th><th style={num}>Fair value</th></tr></thead>
                  <tbody>
                    {report.report.schedule.classes.map((item) => (
                      <tr key={item.name}>
                        <td style={cell}>{item.name || 'Unclassified'}</td>
                        <td style={num}>{item.investments}</td>
                        <td style={num}>{amount(item.cost)}</td>
                        <td style={num}>{amount(item.fairValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {report.report.schedules.filter((item) => !item.loaded).map((item) => (
                  <span key={String(item.date)} style={{ fontSize: 12, color: 'var(--ink-3)' }}>The schedule at {item.date} ({plural(item.investments, 'investment')}) is checked but not loaded.</span>
                ))}
              </>
            ) : (
              <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>No schedule of investments at the period end, so no positions load.</span>
            )}
          </div>

          <div style={card}>
            <span style={label}>What the load would do</span>
            {!report.trial ? (
              <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>No trial was run, because the report is not ready to load.</span>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {statementTrial && (
                  <li>
                    NAV statement: {statementTrial.records.map((item) => `${item.created ? 'created' : 'matched'}`).join(', ')}; {plural(statementTrial.values.created, 'value')} added, {statementTrial.values.updated} changed, {statementTrial.values.unchanged} already on file.
                  </li>
                )}
                {positionTrial && (
                  <li>
                    Positions: {positionTrial.records.map((item) => `${item.created} created, ${item.matched} matched${item.failed ? `, ${item.failed} refused` : ''}`).join('; ')}; {plural(positionTrial.values.created, 'value')} added, {positionTrial.values.updated} changed.
                  </li>
                )}
                {[statementTrial, positionTrial].filter(Boolean).flatMap((trial) => trial!.rejects).slice(0, 8).map((reject, index) => (
                  <li key={`reject-${index}`} style={{ color: '#b42318' }}>{reject.entityCode}{reject.attributeCode ? ` ${reject.attributeCode}` : ''}: {reject.message}</li>
                ))}
                {[statementTrial, positionTrial].some((trial) => trial && trial.resolutions > 0) && (
                  <li style={{ color: '#b42318' }}>Some records match more than one stored record. Resolve them in Load data before loading.</li>
                )}
              </ul>
            )}
          </div>
        </div>
      </div>

      <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <ConfirmButton className="load-btn sec" disabled={disabled} confirmLabel="Yes, stop the run" title="Nothing has been loaded." onConfirm={() => void onComplete('abandoned', {})}>Stop this run</ConfirmButton>
        <button type="button" className="load-btn" disabled={disabled || !report.ready} onClick={confirm}>
          {working || busy ? 'Working…' : report.holds.length ? 'I have checked these, load the report' : 'This is right, load the report'}
        </button>
      </span>
    </div>
  );
}
