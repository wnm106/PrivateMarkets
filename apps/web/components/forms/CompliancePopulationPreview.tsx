'use client';

import { useMemo, useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { AppGrid } from '@/components/grid/AppGrid';
import { graphqlQuery } from '@/lib/graphql';
import { attributeValueKey, type AttributePathHop, type TreeAttributeOption } from './ComplianceAttributeSelect';
import type { ComplianceCondition } from './ComplianceRuleForm';

const PREVIEW_QUERY = `
  query CompliancePopulationPreview($input: CompliancePopulationPreviewInput!) {
    compliancePopulationPreview(input: $input) {
      total
      scanned
      truncated
      rows {
        entityId
        entityCode
        entityName
        values
        parents {
          domainCode
          entityId
          entityCode
          entityName
          relationshipCode
          isCompositeMember
        }
      }
    }
  }
`;

interface PreviewRow {
  entityId: string;
  entityCode: string;
  entityName?: string | null;
  values: Record<string, string | null>;
  parents: Array<{
    domainCode: string;
    entityId: string;
    entityCode?: string | null;
    entityName?: string | null;
    isCompositeMember: boolean;
  }>;
}

const domainTitle = (code: string) =>
  code.toLowerCase().split('_').filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
const parentLabel = (parent: PreviewRow['parents'][number]) => parent.entityName || parent.entityCode || '—';

interface PreviewResult {
  total: number;
  scanned: number;
  truncated: boolean;
  rows: PreviewRow[];
}

function conditionInput(cond: ComplianceCondition, order: number) {
  const dimension = (path?: AttributePathHop[]) =>
    path && path.length
      ? { relationshipPath: path.map((hop) => ({ relationshipCode: hop.relationshipCode, direction: hop.direction, recursive: false })) }
      : undefined;
  let value: string | undefined = cond.rightExpression ? undefined : cond.value;
  const compareCode = cond.compareAttributeCode === '__PICK__' ? '' : cond.compareAttributeCode;
  if (compareCode || cond.operator === 'is_null' || cond.operator === 'is_not_null') value = undefined;
  else if ((cond.operator === 'in' || cond.operator === 'not_in') && value && !value.trim().startsWith('[')) {
    value = JSON.stringify(value.split(',').map((part) => part.trim()).filter(Boolean));
  }
  return {
    appliesTo: cond.appliesTo,
    conditionGroup: cond.conditionGroup,
    conditionOrder: order,
    attributeCode: cond.attributeCode,
    operator: cond.operator,
    value,
    compareAttributeCode: compareCode || undefined,
    attributeDimension: dimension(cond.attributePath),
    compareDimension: compareCode ? dimension(cond.compareAttributePath) : undefined,
    leftExpression: cond.leftExpression || undefined,
    rightExpression: cond.rightExpression || undefined,
    logicOperator: cond.logicOperator,
  };
}

/** The button belongs in the conditions box header; the panel goes under the box. */
export function usePopulationPreview({
  domainCode,
  domainLabel,
  conditions,
  options,
}: {
  domainCode: string;
  domainLabel: string;
  conditions: ComplianceCondition[];
  options: TreeAttributeOption[];
}): { button: React.ReactNode; panel: React.ReactNode } {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const pageSize = 20;
  const active = conditions.filter((cond) => cond.attributeCode);

  const labelFor = (cond: ComplianceCondition) => {
    const match = options.find(
      (option) => option.attributeCode === cond.attributeCode && attributeValueKey(option.path, option.attributeCode) === attributeValueKey(cond.attributePath, cond.attributeCode),
    );
    return match ? `${match.groupLabel} · ${match.attributeName}` : cond.attributeCode;
  };

  // One column per kind of parent record found in this page, composite members first.
  const parentDomains = useMemo(() => {
    const seen = new Map<string, boolean>();
    for (const row of result?.rows || []) {
      for (const parent of row.parents) seen.set(parent.domainCode, (seen.get(parent.domainCode) || false) || parent.isCompositeMember);
    }
    return [...seen.entries()].sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));
  }, [result]);
  const hasComposite = parentDomains.some(([, member]) => member);

  const columns = useMemo<ColDef[]>(() => [
    { field: 'entityCode', headerName: 'ID', minWidth: 140, flex: 1, cellClass: 'mono' },
    { field: 'entityName', headerName: 'Name', minWidth: 180, flex: 1.2, valueFormatter: (params) => params.value || '—' },
    ...(hasComposite ? [{
      colId: '__composite',
      headerName: 'Composite of',
      flex: 1.6,
      minWidth: 220,
      valueGetter: (params: any) => {
        const names = (params.data?.parents || []).filter((p: PreviewRow['parents'][number]) => p.isCompositeMember).map(parentLabel);
        return names.length ? names.join(' · ') : '—';
      },
    }] : []),
    ...parentDomains.map(([domain]) => ({
      colId: `__parent_${domain}`,
      headerName: domainTitle(domain),
      flex: 1,
      minWidth: 160,
      valueGetter: (params: any) => {
        const match = (params.data?.parents || []).filter((p: PreviewRow['parents'][number]) => p.domainCode === domain);
        return match.length ? match.map(parentLabel).join(', ') : '—';
      },
    })),
    ...active.map((cond) => {
      const key = attributeValueKey(cond.attributePath, cond.attributeCode);
      return {
        colId: key,
        headerName: labelFor(cond),
        flex: 1,
        minWidth: 140,
        valueGetter: (params: any) => params.data?.values?.[key] ?? '—',
      };
    }),
  ], [active, options, parentDomains, hasComposite]);

  const load = async (nextPage: number) => {
    if (!domainCode) return;
    setLoading(true);
    setError('');
    const response = await graphqlQuery<{ compliancePopulationPreview: PreviewResult }, { input: any }>(
      PREVIEW_QUERY,
      {
        input: {
          domainCode,
          conditions: active.map(conditionInput),
          offset: nextPage * pageSize,
          limit: pageSize,
        },
      },
      'network-only',
    );
    setLoading(false);
    if (response.error || !response.data?.compliancePopulationPreview) {
      setResult(null);
      setError(response.error?.message || 'Could not load matching records');
      return;
    }
    setResult(response.data.compliancePopulationPreview);
    setPage(nextPage);
    setOpen(true);
  };

  const pageCount = result ? Math.max(1, Math.ceil(result.total / pageSize)) : 1;

  const button = (
    <button
      type="button"
      className="add-cond cg-preview-btn"
      onClick={() => load(0)}
      disabled={!domainCode || loading}
      title={domainCode ? `Lists every ${domainLabel || domainCode} record that qualifies under these conditions` : 'Choose the entity type being measured first'}
    >
      {loading ? 'Looking up records…' : 'Show matching records'}
    </button>
  );

  const panel = (
    <div>
      {error && <div className="field-hint" style={{ color: 'var(--red)', marginTop: '8px' }}>{error}</div>}
      {open && result && (
        <div style={{ marginTop: '10px', border: '1px solid var(--line)', borderRadius: '6px', overflow: 'auto' }}>
          <div style={{ padding: '8px 12px', fontSize: '12px', background: 'var(--bg)' }}>
            <strong>{result.total.toLocaleString()}</strong> matching {domainLabel || domainCode} record{result.total === 1 ? '' : 's'}
            {result.truncated ? ` (searched the first ${result.scanned.toLocaleString()} records)` : ''}
          </div>
          <AppGrid
            rows={result.rows}
            columns={columns}
            getRowId={(row) => row.entityId}
            autoHeight
            enableSortFilter={false}
            emptyMessage="No records match these conditions."
          />
          {result.total > pageSize && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', padding: '8px 12px', fontSize: '12px' }}>
              <button type="button" className="add-cond" disabled={page === 0 || loading} onClick={() => load(page - 1)}>Previous</button>
              <span>Page {page + 1} of {pageCount}</span>
              <button type="button" className="add-cond" disabled={page + 1 >= pageCount || loading} onClick={() => load(page + 1)}>Next</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
  return { button, panel };
}
