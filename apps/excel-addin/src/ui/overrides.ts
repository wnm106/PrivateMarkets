import type { ExcelAuth } from '../lib/auth';
import type { GraphQLClient } from '../lib/graphql';
import {
  MAX_OVERRIDE_CELLS,
  readOverrideCell,
  statusText,
  SUBMIT_TAP_OVERRIDES_MUTATION,
  summarize,
  TAP_OVERRIDE_PREVIEW_QUERY,
  type OverridePlan,
  type OverrideRow,
} from '../lib/overrides';
import { errorResult } from '../lib/tap-client';
import { readSelectedTapCells } from '../office/workbook';
import { h } from './dom';

/**
 * Override values: the Excel version of a manual entry on the record screen.
 * Select TAP cells, type new values, Check, then Save. A save goes through the same
 * writer as the record screen. The formulas never write; this panel does, when asked.
 */

interface Deps {
  auth: ExcelAuth;
  graphql: GraphQLClient;
  setStatus: (text: string, tone?: 'info' | 'error') => void;
  /** Recalculate so the TAP cells show what was saved. */
  afterSave: () => Promise<void>;
}

interface Line {
  row: OverrideRow;
  value: HTMLInputElement;
  validFrom: HTMLInputElement;
  now: HTMLElement;
  status: HTMLElement;
  plan: OverridePlan | null;
}

function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'blank';
  if (typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function mountOverrides(container: HTMLElement, deps: Deps): void {
  let lines: Line[] = [];
  let checked = false;
  let working = false;

  const list = h('div', { className: 'override-list' });
  const problems = h('ul', { className: 'override-problems' });
  const reason = h('textarea', { id: 'override-reason', rows: '2', placeholder: 'Why, for example "Q3 administrator statement"', spellcheck: 'true' });
  const checkButton = h('button', { type: 'button' }, ['Check']);
  const saveButton = h('button', { type: 'button', className: 'primary' }, ['Save overrides']);
  const cancelButton = h('button', { type: 'button' }, ['Cancel']);
  const summary = h('p', { className: 'override-summary', 'aria-live': 'polite' });
  const editor = h('div', { className: 'override-editor', hidden: true }, [
    list,
    problems,
    h('label', { for: 'override-reason' }, ['Reason ', h('span', { className: 'optional' }, ['required'])]),
    reason,
    h('div', { className: 'actions' }, [checkButton, saveButton, cancelButton]),
    summary,
  ]);

  const refreshButtons = () => {
    const hasValues = lines.some((line) => line.value.value.trim());
    checkButton.disabled = working || !hasValues;
    const ready = checked && lines.some((line) => line.plan?.status === 'READY');
    saveButton.disabled = working || !ready || !reason.value.trim();
    saveButton.textContent = ready
      ? `Save ${lines.filter((line) => line.plan?.status === 'READY').length} override${lines.filter((line) => line.plan?.status === 'READY').length === 1 ? '' : 's'}`
      : 'Save overrides';
  };

  const invalidate = () => {
    if (!checked) return refreshButtons();
    checked = false;
    for (const line of lines) {
      line.plan = null;
      line.status.textContent = '';
      line.status.className = 'override-status';
    }
    summary.textContent = 'Changed since the check. Check again before saving.';
    refreshButtons();
  };

  const showPlan = (line: Line, plan: OverridePlan) => {
    line.plan = plan;
    if (plan.entityName || plan.attributeName) {
      line.now.textContent = `Now ${shown(plan.currentValue)}${plan.newText !== null && plan.status !== 'SAVED' ? `  →  ${shown(plan.newValue)}` : ''}`;
    }
    line.status.textContent = statusText(plan);
    const tone = plan.status === 'SAVED' ? 'ok' : plan.status === 'READY' ? 'ready' : plan.status === 'UNCHANGED' ? 'muted' : 'error';
    line.status.className = `override-status ${tone}`;
  };

  const sent = () => lines.filter((line) => line.value.value.trim());

  const payload = (withExpected: boolean) => sent().map((line) => ({
    attribute: line.row.attribute,
    entity: line.row.entity,
    validFrom: line.validFrom.value.trim() || null,
    value: line.value.value,
    ...(withExpected && line.plan ? { expected: line.plan.currentText } : {}),
  }));

  const check = async () => {
    working = true;
    refreshButtons();
    summary.textContent = 'Checking…';
    try {
      const data = await deps.graphql.request<{ tapOverridePreview: OverridePlan[] }>(TAP_OVERRIDE_PREVIEW_QUERY, { overrides: payload(false) });
      sent().forEach((line, index) => showPlan(line, data.tapOverridePreview[index]));
      for (const line of lines) {
        if (!line.value.value.trim()) {
          line.plan = null;
          line.status.textContent = 'No new value, skipped';
          line.status.className = 'override-status muted';
        }
      }
      checked = true;
      summary.textContent = summarize(data.tapOverridePreview);
    } catch (error) {
      const result = errorResult(error);
      summary.textContent = result.ok ? '' : result.message;
    } finally {
      working = false;
      refreshButtons();
    }
  };

  const save = async () => {
    if (!checked || !reason.value.trim()) return;
    working = true;
    refreshButtons();
    summary.textContent = 'Saving…';
    try {
      const data = await deps.graphql.request<{ submitTapOverrides: OverridePlan[] }>(
        SUBMIT_TAP_OVERRIDES_MUTATION,
        { overrides: payload(true), reason: reason.value.trim() },
      );
      sent().forEach((line, index) => showPlan(line, data.submitTapOverrides[index]));
      const savedCount = data.submitTapOverrides.filter((plan) => plan.status === 'SAVED').length;
      summary.textContent = summarize(data.submitTapOverrides);
      checked = false;
      if (savedCount) {
        deps.setStatus(`${savedCount} manual entr${savedCount === 1 ? 'y' : 'ies'} saved. Recalculating TAP formulas…`);
        await deps.afterSave();
        deps.setStatus(`${savedCount} manual entr${savedCount === 1 ? 'y' : 'ies'} saved.`);
      }
    } catch (error) {
      const result = errorResult(error);
      summary.textContent = result.ok ? '' : result.message;
    } finally {
      working = false;
      refreshButtons();
    }
  };

  const close = () => {
    lines = [];
    checked = false;
    list.replaceChildren();
    problems.replaceChildren();
    summary.textContent = '';
    editor.hidden = true;
  };

  const loadSelection = async () => {
    if (!deps.auth.email()) {
      deps.setStatus('Sign in to override values.', 'error');
      return;
    }
    try {
      const selection = await readSelectedTapCells(MAX_OVERRIDE_CELLS);
      const readings = selection.cells.map((cell) => readOverrideCell(cell, selection.references, today()));
      lines = readings.flatMap((reading) => {
        if (!reading.ok) return [];
        const value = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': `New value for ${reading.row.address}`, placeholder: 'New value' });
        const validFrom = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': `From date for ${reading.row.address}`, value: reading.row.validFrom });
        return [{ row: reading.row, value, validFrom, now: h('span', { className: 'override-now' }, [`Now ${shown(reading.row.shown)}`]), status: h('span', { className: 'override-status' }), plan: null }];
      });
      const refused = readings.filter((reading): reading is { ok: false; address: string; problem: string } => !reading.ok);
      if (!lines.length && !refused.length) {
        deps.setStatus('Select one or more cells with a TAP formula, then choose Override selected cells.', 'error');
        return;
      }
      checked = false;
      list.replaceChildren(...lines.map((line) => h('div', { className: 'override-line' }, [
        h('div', { className: 'override-head' }, [
          h('span', { className: 'code' }, [line.row.address]),
          h('span', {}, [`${line.row.entity} · ${line.row.attribute}`]),
        ]),
        line.now,
        h('div', { className: 'override-inputs' }, [
          line.value,
          h('span', { className: 'override-from' }, ['from']),
          line.validFrom,
        ]),
        line.status,
      ])));
      problems.replaceChildren(
        ...refused.map((reading) => h('li', {}, [h('span', { className: 'code' }, [reading.address]), ` ${reading.problem}`])),
        ...(selection.more ? [h('li', {}, [`Only the first ${MAX_OVERRIDE_CELLS} TAP cells are listed. Override the rest in another pass.`])] : []),
      );
      for (const line of lines) {
        line.value.addEventListener('input', invalidate);
        line.validFrom.addEventListener('input', invalidate);
      }
      summary.textContent = '';
      editor.hidden = false;
      refreshButtons();
      lines[0]?.value.focus();
    } catch (error) {
      deps.setStatus(error instanceof Error ? error.message : 'The selection could not be read.', 'error');
    }
  };

  reason.addEventListener('input', refreshButtons);
  checkButton.addEventListener('click', () => { void check(); });
  saveButton.addEventListener('click', () => { void save(); });
  cancelButton.addEventListener('click', close);

  container.replaceChildren(
    h('h2', {}, ['Override values']),
    h('p', { className: 'help' }, [
      'Select TAP cells and type new values. Each is saved as a manual entry, as on the record screen: it wins over every other source from its date until it is cleared in Tapestry. Values that have not changed are skipped.',
    ]),
    h('button', { type: 'button', onClick: () => { void loadSelection(); } }, ['Override selected cells']),
    editor,
  );
}
