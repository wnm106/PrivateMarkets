'use client';

import { useMemo, useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { AppGrid } from '@/components/grid/AppGrid';
import { graphqlQuery } from '@/lib/graphql';
import type { OperandField } from '@/lib/condition-expression';

const PREVIEW_QUERY = `
  query DQRulePreview($input: DQRulePreviewInput!) {
    dqRulePreview(input: $input) {
      total
      passed
      failed
      rows {
        entityId
        entityCode
        entityName
        passed
        message
        actualValue
        values
      }
    }
  }
`;

type Outcome = 'FAIL' | 'PASS' | 'ALL';

interface PreviewRow {
  entityId: string;
  entityCode: string;
  entityName?: string | null;
  passed: boolean;
  message?: string | null;
  actualValue?: string | null;
  values?: Record<string, string | null> | null;
}

interface PreviewResult {
  total: number;
  passed: number;
  failed: number;
  rows: PreviewRow[];
}

const OUTCOMES: Array<{ value: Outcome; label: string }> = [
  { value: 'FAIL', label: 'Failing' },
  { value: 'PASS', label: 'Passing' },
  { value: 'ALL', label: 'All' },
];

const PAGE_SIZE = 20;

/** Runs the rule as it is being edited against current records. Same shape as the compliance preview. */
export function useDqRulePreview({
  domainCode,
  domainLabel,
  attributeCode,
  expression,
  issue,
  columns: columnCodes,
  fields,
}: {
  domainCode: string;
  domainLabel: string;
  attributeCode: string;
  expression: string;
  /** The first reason the expression cannot be run yet. */
  issue: string | null;
  /** Attributes the rule reads, shown next to each record. */
  columns: string[];
  fields: OperandField[];
}): { button: React.ReactNode; panel: React.ReactNode; run: () => void; close: () => void; isOpen: boolean; ready: boolean; loading: boolean } {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [outcome, setOutcome] = useState<Outcome>('FAIL');
  const [result, setResult] = useState<PreviewResult | null>(null);

  const shown = useMemo(
    () => columnCodes.map((code) => fields.find((field) => field.attributeCode === code)).filter((field): field is OperandField => !!field),
    [columnCodes, fields],
  );
  const subject = domainLabel || domainCode || 'record';
  const ready = !!expression.trim() && !issue;

  const gridColumns = useMemo<ColDef<PreviewRow>[]>(() => [
    { field: 'entityCode', headerName: 'ID', minWidth: 140, flex: 1, cellClass: 'mono' },
    { field: 'entityName', headerName: 'Name', minWidth: 180, flex: 1.2, valueFormatter: (params) => params.value || '—' },
    {
      field: 'passed',
      headerName: 'Result',
      minWidth: 100,
      cellRenderer: (params: { data?: PreviewRow }) => (
        params.data ? <span className={`da-st ${params.data.passed ? 'ok' : 'na'}`}>{params.data.passed ? 'Passes' : 'Fails'}</span> : null
      ),
    },
    ...shown.map((field): ColDef<PreviewRow> => ({
      colId: `v-${field.attributeCode}`,
      headerName: field.attributeName,
      flex: 1,
      minWidth: 140,
      valueGetter: (params) => params.data?.values?.[field.attributeCode.toLowerCase()] ?? '—',
    })),
    {
      field: 'message',
      headerName: 'Why it fails',
      minWidth: 220,
      flex: 1.4,
      valueFormatter: (params) => params.value || '—',
    },
  ], [shown]);

  const load = async (nextPage: number, nextOutcome: Outcome) => {
    if (!ready) return;
    setLoading(true);
    setError('');
    try {
      const response = await graphqlQuery<{ dqRulePreview: PreviewResult }, { input: Record<string, unknown> }>(
        PREVIEW_QUERY,
        {
          input: {
            domainCode: domainCode || null,
            ruleExpression: expression,
            attributeCode: attributeCode || null,
            columns: shown.map((field) => field.attributeCode),
            outcome: nextOutcome,
            offset: nextPage * PAGE_SIZE,
            limit: PAGE_SIZE,
          },
        },
        'network-only',
      );
      if (response.error || !response.data?.dqRulePreview) {
        setResult(null);
        setError(response.error?.message || 'Could not run the rule.');
        return;
      }
      setResult(response.data.dqRulePreview);
      setPage(nextPage);
      setOutcome(nextOutcome);
      setOpen(true);
    } catch (err: any) {
      setResult(null);
      setError(err?.message || 'Could not run the rule.');
    } finally {
      setLoading(false);
    }
  };

  const button = (
    <button
      type="button"
      className="add-cond cg-preview-btn"
      onClick={() => load(0, outcome)}
      disabled={!ready || loading}
      title={ready ? `Runs this rule on current ${subject.toLowerCase()} records without saving it` : (issue || 'Add a condition first')}
    >
      {loading ? 'Running the rule…' : 'Test on current records'}
    </button>
  );

  const matching = result ? (outcome === 'FAIL' ? result.failed : outcome === 'PASS' ? result.passed : result.total) : 0;
  const pageCount = Math.max(1, Math.ceil(matching / PAGE_SIZE));

  const panel = (
    <div>
      {error && <div className="field-hint" style={{ color: 'var(--red)', marginTop: 8 }}>{error}</div>}
      {open && result && (
        <div style={{ marginTop: 10, border: '1px solid var(--line)', borderRadius: 6, overflow: 'auto' }}>
          <div style={{ padding: '8px 12px', fontSize: 12, background: 'var(--bg)', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>
              <strong>{result.total.toLocaleString()}</strong> {subject.toLowerCase()} record{result.total === 1 ? '' : 's'} checked ·{' '}
              <strong style={{ color: 'var(--green)' }}>{result.passed.toLocaleString()}</strong> pass ·{' '}
              <strong style={{ color: result.failed ? 'var(--red)' : undefined }}>{result.failed.toLocaleString()}</strong> fail
            </span>
            <div className="rb-seg small" role="radiogroup" aria-label="Which records to list">
              {OUTCOMES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  aria-checked={outcome === item.value}
                  className={outcome === item.value ? 'on' : ''}
                  disabled={loading}
                  onClick={() => load(0, item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <AppGrid
            rows={result.rows}
            columns={gridColumns}
            getRowId={(row) => row.entityId}
            autoHeight
            enableSortFilter={false}
            emptyMessage={outcome === 'FAIL' ? 'No records fail this rule.' : outcome === 'PASS' ? 'No records pass this rule.' : 'No records to check.'}
          />
          {matching > PAGE_SIZE && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', fontSize: 12 }}>
              <button type="button" className="add-cond" disabled={page === 0 || loading} onClick={() => load(page - 1, outcome)}>Previous</button>
              <span>Page {page + 1} of {pageCount}</span>
              <button type="button" className="add-cond" disabled={page + 1 >= pageCount || loading} onClick={() => load(page + 1, outcome)}>Next</button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return { button, panel, run: () => load(0, outcome), close: () => setOpen(false), isOpen: open, ready, loading };
}
