'use client';

import { useEffect, useState } from 'react';
import {
  DATA_SOURCES_QUERY,
  graphqlClient,
  graphqlQuery,
  UPDATE_ATTRIBUTE_MUTATION,
  UPDATE_ATTRIBUTE_PRECEDENCE_MUTATION,
} from '@/lib/graphql';
import { CalculationWorkspace, type CalculationSpec } from '@/components/admin/CalcExpressionEditor';

const NUMERIC_DATA_TYPES = ['NUMBER', 'INTEGER', 'DECIMAL', 'FLOAT', 'CURRENCY', 'PERCENTAGE', 'PERCENT'];
const VALID_DATA_TYPES = [
  'STRING', 'NUMBER', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'JSON',
  'REFERENCE', 'REFERENCE_LIST', 'CURRENCY', 'PERCENTAGE', 'EMAIL', 'URL', 'PHONE',
];
const FALLBACK_SOURCES = ['BLOOMBERG', 'WSO', 'DEALCLOUD', 'ALLVUE', 'SPCIQ'];

export interface ExpandableAttribute {
  id: string;
  attributeCode: string;
  attributeName: string;
  dataType: string;
  description?: string;
  isRequired: boolean;
  isMultiValued: boolean;
  unitOfMeasure?: string;
  displayFormat?: string;
  listValues?: string[];
  validationRules?: any;
  defaultValue?: string;
  displaySection?: string;
  displayGroup?: number;
  isEditable?: boolean;
  isVisible?: boolean;
  aggregationType?: string;
  weightAttributeCode?: string;
  numericPrecision?: number;
  referenceListCode?: string;
  defaultPrecedenceChain?: string[];
}

interface ReferenceListOpt {
  listCode: string;
  listName: string;
}


export function AttributeExpandPanel({
  attribute,
  weightAttributes,
  referenceLists,
  onSaved,
  onCancel,
}: {
  attribute: ExpandableAttribute;
  weightAttributes: ExpandableAttribute[];
  referenceLists: ReferenceListOpt[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    attributeName: attribute.attributeName || '',
    dataType: attribute.dataType || 'STRING',
    description: attribute.description || '',
    unitOfMeasure: attribute.unitOfMeasure || '',
    displayFormat: attribute.displayFormat || '',
    isMultiValued: attribute.isMultiValued || false,
    defaultValue: attribute.defaultValue || '',
    displaySection: attribute.displaySection || 'General',
    isEditable: attribute.isEditable ?? true,
    isVisible: attribute.isVisible ?? true,
    aggregationType: attribute.aggregationType || 'NONE',
    weightAttributeCode: attribute.weightAttributeCode || '',
    numericPrecision: attribute.numericPrecision,
    referenceListCode: attribute.referenceListCode || '',
  });
  const [chain, setChain] = useState<string[]>(
    (attribute.defaultPrecedenceChain || []).filter((code) => code && code !== 'MANUAL'),
  );
  const [sources, setSources] = useState<string[]>(FALLBACK_SOURCES);
  const [savingFields, setSavingFields] = useState(false);
  const [savingChain, setSavingChain] = useState(false);
  const [message, setMessage] = useState('');
  const [calculation, setCalculation] = useState<CalculationSpec | null>(null);

  useEffect(() => {
    let cancelled = false;
    graphqlQuery<{ calcDefinitions: CalculationSpec[] }>(
      `query AttributeCalculation {
        calcDefinitions {
          id
          attributeCode
          domainCode
          calcKind
          evaluationMode
          outputGrain
          expression
          aggregateFn
          seriesFn
          inputs { inputRole attributeCode traversal relationshipCodes }
        }
      }`,
      {},
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      const match = (result.data?.calcDefinitions || []).find((item) => item.attributeCode === attribute.attributeCode);
      setCalculation(match || null);
    });
    return () => { cancelled = true; };
  }, [attribute.attributeCode]);

  useEffect(() => {
    graphqlQuery<{ dataSources: Array<{ sourceCode: string; precedenceRank: number }> }, { isActive: boolean }>(
      DATA_SOURCES_QUERY,
      { isActive: true },
    ).then((result) => {
      const codes = (result.data?.dataSources || [])
        .filter((source) => source.sourceCode && source.sourceCode !== 'MANUAL')
        .sort((a, b) => a.precedenceRank - b.precedenceRank)
        .map((source) => source.sourceCode);
      if (codes.length) setSources(codes);
    });
  }, []);

  const saveFields = async () => {
    setSavingFields(true);
    setMessage('');
    try {
      const result = await graphqlClient.mutation(UPDATE_ATTRIBUTE_MUTATION, {
        input: {
          id: attribute.id,
          attributeName: form.attributeName || null,
          dataType: form.dataType || 'STRING',
          description: form.description || null,
          unitOfMeasure: form.unitOfMeasure || null,
          displayFormat: form.displayFormat || null,
          isMultiValued: form.isMultiValued,
          defaultValue: form.defaultValue || null,
          displaySection: form.displaySection || 'General',
          isEditable: form.isEditable,
          isVisible: form.isVisible,
          aggregationType: form.aggregationType || 'NONE',
          weightAttributeCode: form.aggregationType === 'WEIGHTED_AVG' ? (form.weightAttributeCode || null) : null,
          numericPrecision: form.numericPrecision,
          referenceListCode: form.referenceListCode || null,
        },
      }).toPromise();
      if (result.data?.updateAttributeDefinition?.success) {
        setMessage('Attribute saved.');
        onSaved();
      } else {
        setMessage(result.data?.updateAttributeDefinition?.errors?.[0]?.message || 'Could not save the attribute.');
      }
    } catch (error: any) {
      setMessage(error?.message || 'Could not save the attribute.');
    } finally {
      setSavingFields(false);
    }
  };

  const saveChain = async () => {
    setSavingChain(true);
    setMessage('');
    try {
      const result = await graphqlClient.mutation(UPDATE_ATTRIBUTE_PRECEDENCE_MUTATION, {
        attributeCode: attribute.attributeCode,
        chain,
      }).toPromise();
      if (result.data?.updateAttributeDefaultPrecedence?.success) {
        setMessage('Global source sequence saved. Templates keep using it unless they set an override.');
        onSaved();
      } else {
        setMessage(result.data?.updateAttributeDefaultPrecedence?.errors?.[0]?.message || 'Could not save the sequence.');
      }
    } catch (error: any) {
      setMessage(error?.message || 'Could not save the sequence.');
    } finally {
      setSavingChain(false);
    }
  };

  const move = (from: number, to: number) => {
    setChain((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const fieldStyle = { width: '100%', padding: '8px', border: '1px solid var(--ink-4)', borderRadius: '4px', fontSize: '14px', background: 'white' };

  return (
    <div style={{ padding: '4px 4px 8px', display: 'grid', gap: '14px' }} onClick={(event) => event.stopPropagation()}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <label style={{ fontSize: '13px', fontWeight: 500 }}>
          Attribute name
          <input style={{ ...fieldStyle, marginTop: '4px' }} value={form.attributeName} onChange={(e) => setForm({ ...form, attributeName: e.target.value })} />
        </label>
        <label style={{ fontSize: '13px', fontWeight: 500 }}>
          Data type
          <select style={{ ...fieldStyle, marginTop: '4px' }} value={form.dataType} onChange={(e) => setForm({ ...form, dataType: e.target.value })}>
            {VALID_DATA_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
      </div>
      <label style={{ fontSize: '13px', fontWeight: 500 }}>
        Description
        <textarea style={{ ...fieldStyle, marginTop: '4px', minHeight: '56px' }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
        <label style={{ fontSize: '13px', fontWeight: 500 }}>
          Unit of measure
          <input style={{ ...fieldStyle, marginTop: '4px' }} value={form.unitOfMeasure} onChange={(e) => setForm({ ...form, unitOfMeasure: e.target.value })} placeholder="USD, %, bps" />
        </label>
        <label style={{ fontSize: '13px', fontWeight: 500 }}>
          Display format
          <input style={{ ...fieldStyle, marginTop: '4px' }} value={form.displayFormat} onChange={(e) => setForm({ ...form, displayFormat: e.target.value })} placeholder="currency, date" />
        </label>
        <label style={{ fontSize: '13px', fontWeight: 500 }}>
          Default value
          <input style={{ ...fieldStyle, marginTop: '4px' }} value={form.defaultValue} onChange={(e) => setForm({ ...form, defaultValue: e.target.value })} />
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <label style={{ fontSize: '13px', fontWeight: 500 }}>
          Display section
          <input style={{ ...fieldStyle, marginTop: '4px' }} value={form.displaySection} onChange={(e) => setForm({ ...form, displaySection: e.target.value })} placeholder="General, Pricing, Details" />
        </label>
        <label style={{ fontSize: '13px', fontWeight: 500 }}>
          Numeric precision
          <input
            style={{ ...fieldStyle, marginTop: '4px' }}
            type="number"
            value={form.numericPrecision ?? ''}
            onChange={(e) => setForm({ ...form, numericPrecision: e.target.value ? parseInt(e.target.value, 10) : undefined })}
            placeholder="2"
          />
        </label>
      </div>
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '13px' }}>
        <label><input type="checkbox" checked={form.isMultiValued} onChange={(e) => setForm({ ...form, isMultiValued: e.target.checked })} /> Multi-valued</label>
        <label><input type="checkbox" checked={form.isEditable} onChange={(e) => setForm({ ...form, isEditable: e.target.checked })} /> Editable</label>
        <label><input type="checkbox" checked={form.isVisible} onChange={(e) => setForm({ ...form, isVisible: e.target.checked })} /> Visible</label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <label style={{ fontSize: '13px', fontWeight: 500 }}>
          Reference list
          <select
            style={{ ...fieldStyle, marginTop: '4px' }}
            value={form.referenceListCode}
            onChange={(e) => setForm({ ...form, referenceListCode: e.target.value, dataType: e.target.value ? 'REFERENCE_LIST' : form.dataType })}
          >
            <option value="">None</option>
            {referenceLists.map((list) => <option key={list.listCode} value={list.listCode}>{list.listName}</option>)}
          </select>
        </label>
        <label style={{ fontSize: '13px', fontWeight: 500 }}>
          Aggregation
          <select style={{ ...fieldStyle, marginTop: '4px' }} value={form.aggregationType} onChange={(e) => setForm({ ...form, aggregationType: e.target.value })}>
            <option value="NONE">None</option>
            <option value="MIN">Min</option>
            <option value="MAX">Max</option>
            <option value="SUM">Sum</option>
            <option value="AVG">Average</option>
            <option value="WEIGHTED_AVG">Weighted average</option>
          </select>
        </label>
      </div>
      {form.aggregationType === 'WEIGHTED_AVG' && (
        <label style={{ fontSize: '13px', fontWeight: 500 }}>
          Weight attribute
          <select style={{ ...fieldStyle, marginTop: '4px' }} value={form.weightAttributeCode} onChange={(e) => setForm({ ...form, weightAttributeCode: e.target.value })}>
            <option value="">Select a numeric attribute</option>
            {weightAttributes.filter((item) => NUMERIC_DATA_TYPES.includes(item.dataType)).map((item) => (
              <option key={item.id} value={item.attributeCode}>{item.attributeName}</option>
            ))}
          </select>
        </label>
      )}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button className="btn btn-primary" type="button" onClick={saveFields} disabled={savingFields}>{savingFields ? 'Saving…' : 'Save attribute'}</button>
        <button className="btn" type="button" onClick={onCancel}>Close</button>
      </div>

      <div style={{ borderTop: '1px solid var(--line)', paddingTop: '14px' }}>
        <div style={{ fontWeight: 600, fontSize: '13px' }}>Calculation</div>
        {calculation ? (
          <CalculationWorkspace spec={calculation} onSaved={setCalculation} />
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '6px' }}>
            This attribute is not calculated. Its value comes from a source.
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--line)', paddingTop: '14px' }}>
        <div style={{ fontWeight: 600, fontSize: '13px' }}>Global source sequence</div>
        <div style={{ fontSize: '12px', color: 'var(--ink-3)', margin: '4px 0 10px' }}>
          This order is the default for every template. A template uses it until that template sets its own override. Manual override always stays first.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <SequenceChip label="Manual override" hint="always #1" pinned />
          <span style={{ color: 'var(--ink-3)' }}>→</span>
          {chain.length === 0 && <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>No sources yet. Add the order below.</span>}
          {chain.map((code, index) => (
            <div key={code} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <SequenceChip
                label={code}
                hint={`#${index + 2}`}
                onUp={index > 0 ? () => move(index, index - 1) : undefined}
                onDown={index < chain.length - 1 ? () => move(index, index + 1) : undefined}
                onRemove={() => setChain((prev) => prev.filter((item) => item !== code))}
              />
              {index < chain.length - 1 && <span style={{ color: 'var(--ink-3)' }}>→</span>}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>Add source</span>
          {sources.filter((code) => !chain.includes(code)).map((code) => (
            <button key={code} type="button" className="btn" style={{ fontSize: '11px', padding: '4px 8px' }} onClick={() => setChain((prev) => [...prev, code])}>
              + {code}
            </button>
          ))}
        </div>
        <button className="btn btn-primary" type="button" style={{ marginTop: '12px' }} onClick={saveChain} disabled={savingChain}>
          {savingChain ? 'Saving…' : 'Save global sequence'}
        </button>
      </div>
      {message && <div style={{ fontSize: '12px', color: 'var(--ink-2)' }}>{message}</div>}
    </div>
  );
}

function SequenceChip({
  label,
  hint,
  pinned,
  onUp,
  onDown,
  onRemove,
}: {
  label: string;
  hint: string;
  pinned?: boolean;
  onUp?: () => void;
  onDown?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '8px 12px',
      borderRadius: '6px',
      border: pinned ? '2px dashed #b4530960' : '1px solid var(--line)',
      background: pinned ? '#b4530908' : 'white',
      position: 'relative',
    }}>
      {!pinned && (
        <span style={{ display: 'flex', gap: '2px' }}>
          {onUp && <button type="button" className="btn" style={{ fontSize: '10px', padding: '0 4px' }} onClick={onUp}>↑</button>}
          {onDown && <button type="button" className="btn" style={{ fontSize: '10px', padding: '0 4px' }} onClick={onDown}>↓</button>}
          {onRemove && <button type="button" className="btn" style={{ fontSize: '10px', padding: '0 4px', color: 'var(--red)' }} onClick={onRemove}>×</button>}
        </span>
      )}
      <span style={{ fontSize: '12px', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: '9px', color: 'var(--ink-3)', textTransform: 'uppercase' }}>{hint}</span>
    </div>
  );
}
