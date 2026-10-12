'use client';

import { useState } from 'react';
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
      }
    }
  }
`;

interface PreviewRow {
  entityId: string;
  entityCode: string;
  entityName?: string | null;
  values: Record<string, string | null>;
}

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
  let value: string | undefined = cond.value;
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
    logicOperator: cond.logicOperator,
  };
}

export function CompliancePopulationPreview({
  domainCode,
  domainLabel,
  conditions,
  options,
}: {
  domainCode: string;
  domainLabel: string;
  conditions: ComplianceCondition[];
  options: TreeAttributeOption[];
}) {
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

  return (
    <div style={{ marginTop: '12px' }}>
      <button
        type="button"
        className="add-cond"
        onClick={() => load(0)}
        disabled={!domainCode || loading}
      >
        {loading ? 'Looking up records…' : 'Show matching records'}
      </button>
      <span className="field-hint" style={{ marginLeft: '10px' }}>
        {domainCode
          ? `Lists every ${domainLabel || domainCode} record that qualifies under the conditions above.`
          : 'Choose the entity type being measured to drill into matching records.'}
      </span>
      {error && <div className="field-hint" style={{ color: 'var(--red)', marginTop: '8px' }}>{error}</div>}
      {open && result && (
        <div style={{ marginTop: '10px', border: '1px solid var(--line)', borderRadius: '6px', overflow: 'auto' }}>
          <div style={{ padding: '8px 12px', fontSize: '12px', background: 'var(--bg)' }}>
            <strong>{result.total.toLocaleString()}</strong> matching {domainLabel || domainCode} record{result.total === 1 ? '' : 's'}
            {result.truncated ? ` (searched the first ${result.scanned.toLocaleString()} records)` : ''}
          </div>
          <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 10px' }}>ID</th>
                <th style={{ textAlign: 'left', padding: '6px 10px' }}>Name</th>
                {active.map((cond) => (
                  <th key={attributeValueKey(cond.attributePath, cond.attributeCode)} style={{ textAlign: 'left', padding: '6px 10px' }}>{labelFor(cond)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={2 + active.length} style={{ padding: '12px', color: 'var(--ink-3)' }}>
                    No records match these conditions.
                  </td>
                </tr>
              )}
              {result.rows.map((row) => (
                <tr key={row.entityId}>
                  <td className="mono" style={{ padding: '6px 10px' }}>{row.entityCode}</td>
                  <td style={{ padding: '6px 10px' }}>{row.entityName || '—'}</td>
                  {active.map((cond) => (
                    <td key={attributeValueKey(cond.attributePath, cond.attributeCode)} style={{ padding: '6px 10px' }}>
                      {row.values?.[attributeValueKey(cond.attributePath, cond.attributeCode)] ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
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
}
