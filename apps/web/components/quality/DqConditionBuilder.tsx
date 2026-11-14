'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ComplianceCondition } from '@/components/forms/ComplianceRuleForm';
import { ConditionBuilder } from '@/components/forms/ConditionBuilder';
import {
  DQ_CONDITION_OPERATORS,
  dqOperandContext,
  dqPatchLeft,
  dqPatchRight,
  rowsFromExpression,
  rowsToExpression,
  type DqAttribute,
} from '@/lib/dq-conditions';
import { describeRule, parseExpression } from '@/lib/dq-expression';

interface DqDomainOption {
  domainCode: string;
  domainName: string;
}

interface DqConditionBuilderProps {
  expression: string;
  attributes: DqAttribute[];
  domains: DqDomainOption[];
  /** Test button, owned by the page so the ribbon and this box run the same test. */
  preview?: { button: React.ReactNode; panel: React.ReactNode };
  onChange: (expression: string, issue: string | null) => void;
}

/** The compliance condition builder, reading and writing a data quality expression. */
export function DqConditionBuilder({ expression, attributes, domains, preview, onChange }: DqConditionBuilderProps) {
  const initial = useMemo(() => rowsFromExpression(expression), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [rows, setRows] = useState<ComplianceCondition[]>(initial.rows);
  const [rawMode, setRawMode] = useState(initial.raw);
  const [rawText, setRawText] = useState(expression);
  const [rawIssue, setRawIssue] = useState<string | null>(null);

  const domainName = (code: string) => domains.find((domain) => domain.domainCode === code)?.domainName || code;
  const ctx = useMemo(() => dqOperandContext(attributes, domainName), [attributes, domains]); // eslint-disable-line react-hooks/exhaustive-deps
  const dataTypeOf = (code: string) => attributes.find((attribute) => attribute.attributeCode === code)?.dataType;
  const nameFor = (code: string) => attributes.find((attribute) => attribute.attributeCode === code)?.attributeName || code;

  const built = useMemo(
    () => rowsToExpression(rows, dataTypeOf),
    [rows, attributes], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const current = rawMode ? rawText : built.expression;
  const issue = rawMode ? (rawText.trim() ? null : 'Write an expression, or switch back to the condition builder.') : built.issue;

  useEffect(() => {
    onChange(current, issue);
    // The parent stores the expression this effect reports.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, issue]);

  const parsedForSummary = parseExpression(current);
  const summary = parsedForSummary.raw
    ? 'This expression is edited as text.'
    : describeRule(parsedForSummary.clauses, nameFor);

  const openBuilder = () => {
    const parsed = rowsFromExpression(rawText);
    if (parsed.raw) {
      setRawIssue('The builder understands attribute checks joined by and or or. Simplify the text, or keep editing it here.');
      return;
    }
    setRows(parsed.rows);
    setRawMode(false);
    setRawIssue(null);
  };

  return (
    <div className="dq-builder">
      <div className="dq-summary">
        <div>
          <div className="dq-kicker">A record passes when</div>
          <p>{summary}</p>
          {!rawMode && issue && rows.length > 0 && <p className="dq-note">Finish the marked condition before saving.</p>}
        </div>
        {rawMode ? (
          <button type="button" className="dq-text-btn" onClick={openBuilder}>Use condition builder</button>
        ) : (
          <button
            type="button"
            className="dq-text-btn"
            onClick={() => {
              setRawText(built.expression || expression);
              setRawIssue(null);
              setRawMode(true);
            }}
          >
            Edit as text
          </button>
        )}
      </div>

      {rawMode ? (
        <div className="dq-raw">
          <textarea
            className="text-input mono"
            value={rawText}
            rows={6}
            aria-label="Rule expression"
            onChange={(event) => {
              setRawText(event.target.value);
              setRawIssue(null);
            }}
          />
          {rawIssue && <p className="dq-clause-issue">{rawIssue}</p>}
          {preview && <div style={{ marginTop: 8 }}>{preview.button}</div>}
        </div>
      ) : (
        <ConditionBuilder
          appliesTo="BASE"
          conditions={rows}
          ctx={ctx}
          operators={DQ_CONDITION_OPERATORS}
          patchLeft={dqPatchLeft}
          patchRight={(text, operator) => dqPatchRight(text, operator)}
          allowMixed={false}
          emptyText="No conditions yet. A rule needs at least one."
          leadText="Record passes when"
          preview={preview}
          onCommit={setRows}
        />
      )}
    </div>
  );
}
