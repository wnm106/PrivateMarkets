'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePublishViewContext } from '@/lib/view-context';
import { useSurfaceNav } from '@/lib/surface-nav';
import {
  CREATE_DQ_RULE_MUTATION,
  DQ_RULES_QUERY,
  UPDATE_DQ_RULE_MUTATION,
  graphqlMutation,
  graphqlQuery,
} from '@/lib/graphql';
import { DqRuleForm, type DqRuleFormData } from '@/components/forms/DqRuleForm';

interface DQRule {
  id: string;
  ruleCode: string;
  ruleName: string;
  domainCode: string | null;
  attributeCode: string | null;
  ruleType: string;
  severity: string;
  ruleExpression: string;
  ruleDescription: string | null;
  isActive: boolean;
}

type Payload = { rule: DQRule | null; errors: Array<{ message: string }> };

const LIST_HREF = '/admin/dq-rules';

/** Full-page editor for one data quality rule. Pass no ruleCode to create a new one. */
export function DqRuleEditorPage({ ruleCode }: { ruleCode?: string }) {
  const router = useRouter();
  const creating = !ruleCode;
  const [rule, setRule] = useState<DQRule | null>(null);
  const [loading, setLoading] = useState(!creating);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<DqRuleFormData | null>(null);

  useEffect(() => {
    if (!ruleCode) return;
    let cancelled = false;
    setLoading(true);
    graphqlQuery<{ dqRules: DQRule[] }, { filter: { ruleCode: { equals: string } } }>(
      DQ_RULES_QUERY,
      { filter: { ruleCode: { equals: ruleCode } } },
      'network-only',
    )
      .then((result) => {
        if (cancelled) return;
        const rules = result.data?.dqRules || [];
        setRule(rules.find((item) => item.ruleCode === ruleCode) || null);
        if (result.error) setError(result.error.message);
      })
      .catch((err: any) => { if (!cancelled) setError(err.message || 'Could not load the rule.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ruleCode]);

  // The top bar carries the trail; the page has no second one.
  useSurfaceNav([
    { label: 'Master Data', href: '/' },
    { label: 'Admin' },
    { label: 'DQ Rules', href: LIST_HREF },
    { label: creating ? 'New rule' : rule?.ruleName || ruleCode || 'Rule' },
  ]);

  usePublishViewContext(live ? {
    activity: creating ? 'creating' as const : 'editing' as const,
    kind: 'dq-rule',
    label: live.ruleName || live.ruleCode || 'Data quality rule',
    id: rule?.id,
    domainCode: live.domainCode || undefined,
    summary: live.ruleDescription || undefined,
    snapshot: { ...live, domainCode: live.domainCode || null, attributeCode: live.attributeCode || null },
  } : null);

  const save = async (data: DqRuleFormData) => {
    setSaving(true);
    setError(null);
    try {
      const shared = {
        ruleName: data.ruleName,
        domainCode: data.domainCode || null,
        attributeCode: data.attributeCode,
        ruleType: data.ruleType,
        severity: data.severity,
        ruleExpression: data.ruleExpression,
        ruleDescription: data.ruleDescription || null,
      };
      const result = creating
        ? await graphqlMutation<{ createDQRule: Payload }, any>(CREATE_DQ_RULE_MUTATION, { input: { ...shared, ruleCode: data.ruleCode.trim() } })
        : await graphqlMutation<{ updateDQRule: Payload }, any>(UPDATE_DQ_RULE_MUTATION, { input: { ...shared, id: rule?.id, isActive: data.isActive } });
      const payload = creating ? (result.data as any)?.createDQRule : (result.data as any)?.updateDQRule;
      const message = result.error?.message || payload?.errors?.[0]?.message;
      if (message || !payload?.rule) {
        setError(message || 'The rule was not saved.');
        return;
      }
      if (creating) router.push(`${LIST_HREF}/${encodeURIComponent(payload.rule.ruleCode)}`);
      else setRule(payload.rule);
    } catch (err: any) {
      setError(err.message || 'The rule was not saved.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="view-fade">
        <div style={{ textAlign: 'center', padding: '40px 0' }}><div className="loader">Loading rule...</div></div>
      </div>
    );
  }

  if (!creating && !rule) {
    return (
      <div className="view-fade">
        <div className="page-header">
          <div>
            <div className="page-title">Rule Not Found</div>
            <div className="page-meta">{error || `No data quality rule with code "${ruleCode}" exists.`}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view-fade">
      <DqRuleForm
        key={rule?.id || 'new'}
        initial={rule ? {
          ruleCode: rule.ruleCode,
          ruleName: rule.ruleName,
          domainCode: rule.domainCode || '',
          attributeCode: rule.attributeCode || '',
          ruleType: rule.ruleType,
          severity: rule.severity,
          ruleExpression: rule.ruleExpression,
          ruleDescription: rule.ruleDescription || '',
          isActive: rule.isActive,
        } : undefined}
        lockIdentity={!creating}
        onSubmit={save}
        onCancel={() => router.push(LIST_HREF)}
        onChange={setLive}
        submitting={saving}
        error={error}
        ribbonHeader={(
          <div>
            <div className="page-title">{creating ? 'New data quality rule' : rule!.ruleName}</div>
            <div className="page-meta">
              {creating ? 'Saved, then opened for review.' : <><span className="mono">{rule!.ruleCode}</span> · {rule!.ruleType} · {rule!.isActive ? 'Active' : 'Inactive'}</>}
            </div>
          </div>
        )}
      />
    </div>
  );
}
