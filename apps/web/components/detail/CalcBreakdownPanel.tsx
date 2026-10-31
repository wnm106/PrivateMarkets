'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatAttributeDisplay, type AttributeDisplay } from '@/lib/attribute-display';
import { peekAttributeDisplay, useAttributeDisplay } from '@/components/forms/AttributeValueInput';
import { decompileCalcExpression } from '@/lib/calc-expression';
import { domainHref } from '@/lib/domain-routes';
import { graphqlQuery } from '@/lib/graphql';

function formatPart(value: string, meta?: AttributeDisplay | null): string {
  if (!meta?.dataType) return value;
  return formatAttributeDisplay(value, meta) || value;
}

const FORMULA_WORDS: Record<string, string> = { add: '+', sub: '−', mul: '×', div: '÷' };

function operandText(code: string, components: CalcComponent[], kind: 'name' | 'value'): string {
  const match = components.find((component) => component.attributeCode === code && component.role === 'OPERAND')
    || components.find((component) => component.attributeCode === code);
  if (kind === 'name') return match?.attributeName || code.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (!match || match.value == null || match.value === '') return '—';
  return formatPart(match.value, peekAttributeDisplay(code));
}

function describeExpression(expr: unknown, components: CalcComponent[], kind: 'name' | 'value'): string {
  if (expr == null) return '';
  if (typeof expr === 'string' || typeof expr === 'number') return String(expr);
  if (typeof expr !== 'object') return String(expr);
  const node = expr as Record<string, unknown>;
  if (typeof node.ref === 'string') return operandText(node.ref, components, kind);
  if ('const' in node) {
    if (kind !== 'value') return String(node.const);
    const literal = String(node.const);
    const typed = literal.includes('.') ? { dataType: 'FLOAT' } : { dataType: 'INTEGER' };
    return formatPart(literal, typed);
  }
  if (node.op === 'neg' && Array.isArray(node.args)) return `−${describeExpression(node.args[0], components, kind)}`;
  if (typeof node.op === 'string' && Array.isArray(node.args) && node.args.length === 2) {
    const symbol = FORMULA_WORDS[node.op] || node.op;
    return `${describeExpression(node.args[0], components, kind)} ${symbol} ${describeExpression(node.args[1], components, kind)}`;
  }
  if (typeof node.fn === 'string' && Array.isArray(node.args)) {
    const args = node.args.map((arg) => describeExpression(arg, components, kind)).filter(Boolean).join(', ');
    return `${node.fn}(${args})`;
  }
  return '';
}

export interface CalcComponent {
  attributeCode: string;
  attributeName: string;
  role: string;
  traversal: string;
  relationshipCodes: string[];
  relationshipNames: string[];
  domainCode: string | null;
  domainName: string | null;
  homeDomainCode: string | null;
  homeDomainName: string | null;
  entityId: string | null;
  entityCode: string | null;
  entityName: string | null;
  value: string | null;
  detail: string | null;
  calculated: boolean;
}

interface CalcBreakdown {
  attributeCode: string;
  calcKind: string;
  domainCode: string;
  expression: unknown;
  value: string | null;
  truncated: boolean;
  components: CalcComponent[];
}

const BREAKDOWN_QUERY = `
  query CalcBreakdown($entityId: ID!, $attributeCode: String!, $asOfDate: Date) {
    calcBreakdown(entityId: $entityId, attributeCode: $attributeCode, asOfDate: $asOfDate) {
      attributeCode
      calcKind
      domainCode
      expression
      value
      truncated
      components {
        attributeCode
        attributeName
        role
        traversal
        relationshipCodes
        relationshipNames
        domainCode
        domainName
        homeDomainCode
        homeDomainName
        entityId
        entityCode
        entityName
        value
        detail
        calculated
      }
    }
  }
`;

export function CalcBreakdownPanel({
  entityId,
  attributeCode,
  asOfDate,
  formula,
  displayedValue,
  displayedSourceName,
  refreshKey = '',
  depth = 0,
}: {
  entityId: string;
  attributeCode: string;
  asOfDate?: string;
  formula?: string;
  displayedValue?: string;
  displayedSourceName?: string;
  refreshKey?: string;
  depth?: number;
}) {
  const display = useAttributeDisplay(attributeCode);
  const [breakdown, setBreakdown] = useState<CalcBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openCode, setOpenCode] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    graphqlQuery<{ calcBreakdown: CalcBreakdown | null }>(
      BREAKDOWN_QUERY,
      { entityId, attributeCode, asOfDate: asOfDate || null },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      if (result.error) setError(result.error.message || 'Could not load the calculation');
      setBreakdown(result.data?.calcBreakdown || null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [entityId, attributeCode, asOfDate, refreshKey]);

  if (loading) return <div className="calc-break-note">Loading the values used in this calculation…</div>;
  if (error) return <div className="calc-break-note">{error}</div>;
  if (!breakdown) return <div className="calc-break-note">{formula || 'This value is calculated.'}</div>;

  const expression = decompileCalcExpression(breakdown.expression) || formula;
  const english = describeExpression(breakdown.expression, breakdown.components, 'name') || expression;
  const substituted = describeExpression(breakdown.expression, breakdown.components, 'value');
  const formulaValue = breakdown.value != null && breakdown.value !== '' ? formatPart(breakdown.value, display) : '';
  const shownValue = displayedValue && displayedValue !== '—' ? formatPart(displayedValue, display) : '';
  const missingInputs = breakdown.components.filter((component) => component.value == null || component.value === '');

  return (
    <div className="calc-break">
      <div className="calc-break-formula">
        {english && <div className="calc-break-english">{english}</div>}
        {(substituted || formulaValue) && (
          <div className="calc-break-worked">
            {substituted && <span>{substituted}</span>}
            {formulaValue && <span className="calc-break-equals">= {formulaValue}</span>}
          </div>
        )}
      </div>
      {!formulaValue && missingInputs.length > 0 && (
        <div className="calc-break-note">
          {missingInputs.map((component) => component.attributeName).join(' and ')} {missingInputs.length === 1 ? 'has' : 'have'} no stored value, so this formula did not produce a result.
          {shownValue ? ` The ${shownValue} on this record is from ${displayedSourceName || 'a source'}.` : ''}
        </div>
      )}
      <div className="sa-drill-table">
        <div className="sa-drill-thead calc-break-head">
          <div className="sa-drill-th">Attribute</div>
          <div className="sa-drill-th">Entity</div>
          <div className="sa-drill-th">Record</div>
          <div className="sa-drill-th">Value</div>
        </div>
        {breakdown.components.length === 0 && (
          <div className="calc-break-note">No component values were found for this date.</div>
        )}
        {breakdown.components.map((component, index) => {
          const key = `${component.attributeCode}-${component.entityId || index}-${component.role}`;
          const opened = openCode === key;
          const sameRecord = component.entityId === entityId;
          const via = (component.relationshipNames || []).filter(Boolean).join(' → ');
          const entityName = component.domainName || component.homeDomainName || component.domainCode || 'Record';
          return (
            <div key={key}>
              <div className="sa-drill-trow calc-break-row">
                <div className="sa-drill-td">
                  <div>{component.attributeName}</div>
                  <div className="calc-break-meta">{component.attributeCode}{component.role !== 'OPERAND' ? ` · ${component.role.toLowerCase()}` : ''}</div>
                </div>
                <div className="sa-drill-td">
                  <div>{entityName}</div>
                  {via && <div className="calc-break-meta">via {via}</div>}
                  {!via && component.traversal === 'SELF' && <div className="calc-break-meta">this record</div>}
                </div>
                <div className="sa-drill-td">
                  {component.entityId && component.domainCode ? (
                    <Link href={`${domainHref(component.domainCode)}/${component.entityId}`} className="entity-link" onClick={(event) => event.stopPropagation()}>
                      {component.entityName || component.entityCode}
                    </Link>
                  ) : (
                    <span className="calc-break-meta">No related record</span>
                  )}
                  {sameRecord && <div className="calc-break-meta">this record</div>}
                  {component.detail && <div className="calc-break-meta">{component.detail}</div>}
                </div>
                <div className="sa-drill-td sa-drill-value">
                  {component.value == null || component.value === '' ? 'No value stored' : formatPart(component.value, peekAttributeDisplay(component.attributeCode))}
                  {component.calculated && component.entityId && depth < 3 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ marginLeft: '8px' }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenCode(opened ? '' : key);
                      }}
                    >
                      {opened ? 'Hide parts' : 'Show parts'}
                    </button>
                  )}
                </div>
              </div>
              {opened && component.entityId && (
                <div className="calc-break-nested">
                  <CalcBreakdownPanel
                    entityId={component.entityId}
                    attributeCode={component.attributeCode}
                    asOfDate={asOfDate}
                    refreshKey={refreshKey}
                    depth={depth + 1}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {breakdown.truncated && <div className="calc-break-note">Showing the first 40 records used in this calculation.</div>}
    </div>
  );
}
