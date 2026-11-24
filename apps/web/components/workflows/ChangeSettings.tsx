'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { attributeFor, isLockedArg, type MissingField, type ProposalItem } from '@tapestrai/graphql/src/lib/workflow-proposal';
import { AttributeName, AttributeValueInput, listDisplayLabel, useAttributeDisplay, useAttributeListOptions } from '@/components/forms/AttributeValueInput';
import { formatAttributeDisplay } from '@/lib/attribute-display';
import { listOf, mappingView } from '@/lib/workflow-step-detail';
import { argRows, showValue } from '@/lib/workflows';

/**
 * What a proposed change will set, one row per setting, each shown once.
 *
 * A value the reviewer can change is edited in place. Where the value belongs
 * to an attribute, the control is that attribute's own: its list of values as
 * a dropdown, a date picker for a date, its number format. So an edit is held
 * to the same rules as editing the record directly.
 *
 * A value the agent could not establish is the same kind of row, marked as a
 * question, with the agent's suggestion filled in to accept or change.
 */

/** What a setting in a proposed change holds, read by its dotted key ("attributes.CURRENCY"). */
export function readArg(args: Record<string, unknown>, key: string): unknown {
  let current: unknown = args;
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Whether the reviewer may edit this setting: not what the change is aimed at, and a plain value. */
export function editableArg(args: Record<string, unknown>, key: string): boolean {
  if (isLockedArg(key.split('.')[0])) return false;
  const value = readArg(args, key);
  return value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value);
}

/** Settings that are dates whatever the tool: when a value starts or stops applying. */
function dataTypeFor(key: string, field: MissingField | undefined): string | undefined {
  if (field?.dataType) return field.dataType.toUpperCase();
  return /(^|\.)(valid(From|To)|asOfDate|\w*Date)$/.test(key) ? 'DATE' : undefined;
}

const LABELS: Record<string, string> = {
  value: 'New value',
  valueCode: 'Code stored on records',
  valueLabel: 'Name people see',
  validFrom: 'Effective from',
  validTo: 'Effective to',
  overrideReason: 'Reason',
  resolutionNotes: 'Notes',
  attributeCode: 'Attribute',
  entityId: 'Record',
  exceptionId: 'Exception',
  status: 'Status',
  entityCode: 'Code',
  entityName: 'Name',
  domainCode: 'Type',
  templateCode: 'Template',
};

function labelFor(key: string, field: MissingField | undefined): string {
  if (field?.label && field.label !== key) return field.label;
  if (LABELS[key]) return LABELS[key];
  const last = key.split('.').pop() || key;
  // "MATURITY_DATE" and "maturityDate" both read as "Maturity date".
  const words = last.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A value shown the way its attribute shows it: the list label, the date and number format. */
function SettingValue({ attributeCode, dataType, value }: { attributeCode: string | null; dataType?: string; value: string }) {
  const display = useAttributeDisplay(attributeCode);
  const options = useAttributeListOptions(attributeCode);
  if (!value) return <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>—</span>;
  const listed = listDisplayLabel(value, options);
  if (listed) return <>{listed}</>;
  return <>{formatAttributeDisplay(value, { ...(display || {}), dataType: display?.dataType || dataType }) || value}</>;
}

/** The control for a value that is not an attribute's: the agent's own list of answers, yes or no, or free text. */
function PlainInput({ field, dataType, value, onChange, label, style }: { field?: MissingField; dataType?: string; value: string; onChange(value: string): void; label: string; style: CSSProperties }) {
  if (field?.options && field.options.length > 0) {
    return (
      <select className="select" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} style={style}>
        <option value="">Select...</option>
        {(value && !field.options.includes(value) ? [value, ...field.options] : field.options).map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }
  if (dataType === 'BOOLEAN') {
    return (
      <select className="select" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} style={style}>
        <option value="">Select...</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  return <AttributeValueInput value={value} onChange={onChange} dataType={dataType} ariaLabel={label} style={style} />;
}

const link: CSSProperties = { border: 'none', background: 'none', padding: 0, fontSize: 11, color: 'var(--entity-link)', cursor: 'pointer', fontWeight: 600 };
const note: CSSProperties = { fontSize: 11, color: 'var(--ink-4)', fontWeight: 400, lineHeight: 1.4 };
const th: CSSProperties = { padding: '4px 10px', fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textAlign: 'left', borderBottom: '1px solid var(--line)', background: 'var(--bg-alt)', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '4px 10px', fontSize: 12.5, fontWeight: 400, verticalAlign: 'top', borderBottom: '1px solid var(--line)', wordBreak: 'break-word' };
const ROWS_SHOWN = 12;

/** Whether a setting holds a list of records, which is shown as a table and not as one value. */
function isRows(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.every((row) => row && typeof row === 'object' && !Array.isArray(row));
}

/**
 * A setting that is a list of records. A file's column mappings read as where
 * each column goes; any other list is a table of its own columns.
 */
function RowsSetting({ label, value }: { label: string; value: unknown[] }) {
  const [all, setAll] = useState(false);
  const mapping = mappingView(value);
  const table = mapping
    ? { columns: ['Column in the file', 'Goes to', 'Read as'], rows: mapping.rows.map((row) => ({ cells: [row.column, row.code ? <AttributeName key="to" code={row.code} fallback={row.goesTo} /> : row.goesTo, row.readAs] as ReactNode[], title: row.code || undefined })) }
    : (() => {
        const list = listOf(label, value, value.length);
        return { columns: list.columns, rows: list.rows.map((cells) => ({ cells: cells as ReactNode[], title: undefined as string | undefined })) };
      })();
  const shown = all ? table.rows : table.rows.slice(0, ROWS_SHOWN);
  return (
    <div style={{ padding: '6px 10px 8px 13px' }}>
      <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 4 }}>
        {label}
        <span style={{ color: 'var(--ink-4)' }}>
          {' '}· {mapping ? `${mapping.rows.length} of ${value.length} columns used` : `${value.length}`}
        </span>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th key={column} scope="col" style={th}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index} title={row.title}>
                {row.cells.map((cell, at) => (
                  <td key={at} style={{ ...td, fontWeight: at === 0 ? 600 : 400, whiteSpace: mapping && at === 2 ? 'nowrap' : undefined }}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > ROWS_SHOWN && (
        <button type="button" style={{ ...link, marginTop: 4, fontSize: 12 }} onClick={() => setAll((current) => !current)}>
          {all ? 'Show the first few' : `Show all ${table.rows.length}`}
        </button>
      )}
      {mapping && mapping.leftOut.length > 0 && (
        <div style={{ ...note, fontSize: 12, marginTop: 4 }}>
          Left out of the load: {mapping.leftOut.join(', ')}.
        </div>
      )}
    </div>
  );
}

interface Props {
  item: ProposalItem;
  /** True while the review is open and this person may decide it. */
  canDecide: boolean;
  /** Answers to the item's questions, by key. */
  answers: Record<string, string>;
  /** The reviewer's edits to proposed values, by key. */
  edits: Record<string, string>;
  /** On a decided review: the settings the reviewer recorded, when they edited any. */
  recordedArgs?: Record<string, unknown>;
  onAnswer(key: string, value: string): void;
  /** null puts the proposed value back. */
  onEdit(key: string, value: string | null): void;
}

export function ChangeSettings({ item, canDecide, answers, edits, recordedArgs, onAnswer, onEdit }: Props) {
  const proposed = argRows(item.args).map((row) => ({ key: row.key, value: row.value === '—' ? '' : row.value }));
  const proposedKeys = new Set(proposed.map((row) => row.key));
  const questions = new Map(item.missing.map((field) => [field.key, field]));
  const rows = [...proposed, ...item.missing.filter((field) => !proposedKeys.has(field.key)).map((field) => ({ key: field.key, value: '' }))];

  return (
    <div style={{ display: 'grid', gap: 2 }}>
      {rows.map((row) => {
        const field = questions.get(row.key);
        const held = field ? undefined : readArg(item.args, row.key);
        if (isRows(held)) return <RowsSetting key={row.key} label={labelFor(row.key, field)} value={held} />;
        const attributeCode = attributeFor(item.args, row.key);
        const dataType = dataTypeFor(row.key, field);
        const label = labelFor(row.key, field);
        const editable = canDecide && (Boolean(field) || editableArg(item.args, row.key));
        const value = field ? answers[row.key] ?? '' : edits[row.key] ?? row.value;
        const change = (next: string) => (field ? onAnswer(row.key, next) : onEdit(row.key, next));
        const suggestion = field && field.suggested !== undefined && field.suggested !== null ? showValue(field.suggested) : '';
        const edited = !field && edits[row.key] !== undefined;
        const waiting = Boolean(field?.required) && !value;
        // A decided review shows what was applied, and says when that is not what the agent proposed.
        const recorded = !canDecide && !field && recordedArgs ? readArg(recordedArgs, row.key) : undefined;
        const applied = recorded !== undefined && showValue(recorded) !== row.value ? showValue(recorded) : null;
        const inputStyle: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '5px 7px', fontSize: 12.5, fontWeight: 600, borderColor: waiting ? '#b91c1c' : edited || (field && value !== suggestion) ? '#b45309' : undefined };

        return (
          <div
            key={row.key}
            style={{
              display: 'grid',
              gridTemplateColumns: '130px minmax(0, 1fr)',
              gap: 10,
              alignItems: 'start',
              padding: field ? '8px 10px' : '3px 10px',
              margin: field ? '4px 0' : 0,
              background: field ? '#fffbeb' : undefined,
              borderLeft: `3px solid ${field ? '#b45309' : 'transparent'}`,
              borderRadius: 4,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--ink-3)', paddingTop: editable ? 6 : 1 }} title={row.key}>
              {label}
              {field?.required && canDecide && <span style={{ color: '#b91c1c' }}> *</span>}
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, wordBreak: 'break-word' }}>
              {field && <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 5 }}>{field.question}</div>}
              {editable ? (
                attributeCode ? (
                  <AttributeValueInput attributeCode={attributeCode} dataType={dataType} value={value} onChange={change} ariaLabel={label} style={inputStyle} />
                ) : (
                  <PlainInput field={field} dataType={dataType} value={value} onChange={change} label={label} style={inputStyle} />
                )
              ) : applied !== null ? (
                <>
                  <SettingValue attributeCode={attributeCode} dataType={dataType} value={applied} />
                  <div style={note}>Edited by the reviewer. The agent proposed {row.value || 'nothing'}.</div>
                </>
              ) : row.key === 'entityId' && value && value === item.target.entityId && item.target.label ? (
                <span title={value}>{item.target.label}</span>
              ) : (
                <SettingValue attributeCode={attributeCode} dataType={dataType} value={value} />
              )}

              {editable && field && (
                <div style={{ ...note, marginTop: 4 }}>
                  {field.origin === 'AGENT' && 'The agent could not establish this. '}
                  {suggestion && value === suggestion && <span style={{ color: '#92400e' }}>Filled in with the agent&apos;s suggestion. Change it if it is wrong.</span>}
                  {suggestion && value !== suggestion && (
                    <button type="button" style={link} onClick={() => onAnswer(row.key, suggestion)}>
                      Use the agent&apos;s suggestion: {suggestion}
                    </button>
                  )}
                  {!suggestion && !field.required && 'Optional.'}
                </div>
              )}
              {editable && edited && (
                <div style={{ ...note, marginTop: 3 }}>
                  The agent proposed {row.value || 'nothing'}.{' '}
                  <button type="button" style={link} onClick={() => onEdit(row.key, null)}>
                    Undo edit
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
