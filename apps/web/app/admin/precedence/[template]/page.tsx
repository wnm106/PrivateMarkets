'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { graphqlQuery, DOMAIN_TEMPLATES_QUERY, DOMAIN_TYPES_QUERY } from '@/lib/graphql';
import { sources } from '@/lib/data';
import { PrecedenceRuleForm } from '@/components/forms/PrecedenceRuleForm';

export default function TemplatePrecedencePage() {
  const params = useParams();
  const router = useRouter();
  const templateCode = params.template as string;
  const template = getTemplateByCode(templateCode);
  const domainConfig = domainConfigs.find(d => d.templates.includes(templateCode));

  const [showCreateForm, setShowCreateForm] = useState(false);

  // Mock precedence rules for this template
  const templateRules = [
    {
      id: 'RULE-001',
      field: 'Spread (bps)',
      cond: 'WHEN Instrument Type IN (Term Loan B, Unitranche, Revolver)',
      chain: ['wso', 'manual', 'bloomberg'] as const,
      note: 'Loan products primary from WSO',
      enabled: true,
      executionCount: 1247,
      lastExecuted: '2026-05-21 06:00',
    },
    {
      id: 'RULE-002',
      field: 'Maturity Date',
      cond: 'ALWAYS (no conditions)',
      chain: ['wso', 'bloomberg', 'manual'] as const,
      note: 'WSO authoritative for loan paper',
      enabled: true,
      executionCount: 1423,
      lastExecuted: '2026-05-21 06:00',
    },
    {
      id: 'RULE-003',
      field: 'Reference Rate',
      cond: 'WHEN Instrument Type IN (Term Loan B, Unitranche)',
      chain: ['wso', 'bloomberg'] as const,
      note: 'WSO primary for reference rate on loans',
      enabled: true,
      executionCount: 982,
      lastExecuted: '2026-05-21 06:00',
    },
    {
      id: 'RULE-004',
      field: 'CUSIP / Loan-X',
      cond: 'ALWAYS',
      chain: ['wso', 'bloomberg'] as const,
      note: 'WSO authoritative for loan identifiers',
      enabled: false,
      executionCount: 0,
      lastExecuted: '2026-04-15 06:00',
    },
  ];

  const handleCreateRule = (data: any) => {
    console.log('Creating rule:', data);
    setShowCreateForm(false);
  };

  if (!template) {
    return (
      <div className="view-fade">
        <div className="crumbs">
          <Link href="/" className="crumb-link">Home</Link>
          <span className="sep">›</span>
          <span className="crumb-current">Template Not Found</span>
        </div>
        <div className="page-header">
          <div>
            <div className="page-title">Template Not Found</div>
            <div className="page-meta">The template "{templateCode}" does not exist.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view-fade">
      {/* Breadcrumb */}
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/admin/templates" className="crumb-link">Templates</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{template.code} Precedence</span>
      </div>

      {/* Page Header */}
      <div className="page-header">
        <div>
          <div className="page-title">{template.name} · Precedence Rules</div>
          <div className="page-meta">
            {templateRules.filter(r => r.enabled).length} active rules · {template.domain} domain · {template.entityCount.toLocaleString()} entities affected
          </div>
        </div>
        <div className="page-actions">
          <Link href="/admin/templates">
            <button className="btn">← Back to Templates</button>
          </Link>
          <button className="btn">Test Rules</button>
          <button className="btn btn-primary" onClick={() => setShowCreateForm(true)}>+ New Rule</button>
        </div>
      </div>

      {/* Template Info */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', padding: '18px 22px', marginBottom: '18px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '20px' }}>
          <div>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '6px' }}>
              Template Code
            </div>
            <div className="mono" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--accent)' }}>
              {template.code}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '6px' }}>
              Domain
            </div>
            <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--ink)', textTransform: 'capitalize' }}>
              {template.domain}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '6px' }}>
              Attributes
            </div>
            <div className="mono" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ink)' }}>
              {template.attributes.length}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '6px' }}>
              Entities
            </div>
            <div className="mono" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ink)' }}>
              {template.entityCount.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* Rule Cards */}
      {showCreateForm ? (
        <div>
          <PrecedenceRuleForm
            templateCode={templateCode}
            onSubmit={handleCreateRule}
            onCancel={() => setShowCreateForm(false)}
          />
          <div className="builder-footer">
            <div className="left"></div>
            <div className="right">
              <button className="btn" onClick={() => setShowCreateForm(false)}>Cancel</button>
              <button className="btn" onClick={() => console.log('Save draft')}>Save as Draft</button>
              <button className="btn btn-primary" onClick={() => handleCreateRule({})}>Activate Rule</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {templateRules.map((rule) => (
            <div key={rule.id} className="rule-card" style={{ opacity: rule.enabled ? 1 : 0.6 }}>
              <div className="rule-head">
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span className="rule-field-name">{rule.field}</span>
                  <span className="mono" style={{ fontSize: '10px', color: 'var(--ink-4)' }}>{rule.id}</span>
                  {!rule.enabled && (
                    <span style={{ fontSize: '9px', padding: '2px 7px', background: 'var(--bg-alt)', color: 'var(--ink-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.7px' }}>
                      Disabled
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button className="btn btn-sm">
                    {rule.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn btn-sm">Edit</button>
                  <button className="btn btn-sm">Test</button>
                </div>
              </div>
              <div className="rule-cond">
                {rule.cond.split(/(WHEN|IN|IS NOT NULL|ALWAYS|AND)/g).map((part, i) => {
                  if (['WHEN', 'IN', 'IS NOT NULL', 'ALWAYS', 'AND'].includes(part)) {
                    return <span key={i} className="kw">{part}</span>;
                  }
                  return <span key={i}>{part}</span>;
                })}
              </div>
              <div className="rule-chain">
                <div className="rule-chain-lbl">Precedence:</div>
                {rule.chain.map((srcKey, i) => {
                  const src = sources[srcKey];
                  return (
                    <span key={srcKey}>
                      <span
                        className="src-badge"
                        style={{
                          color: src.hex,
                          borderColor: `${src.hex}40`,
                          background: `${src.hex}0a`,
                        }}
                      >
                        <span className="dot" style={{ background: src.hex }}></span>
                        {src.name}
                      </span>
                      {i < rule.chain.length - 1 && <span className="arrow">→</span>}
                    </span>
                  );
                })}
                <div className="rule-note">{rule.note}</div>
              </div>
              <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--line)', display: 'flex', gap: '20px', fontSize: '11px', color: 'var(--ink-3)' }}>
                <span>Executions: <strong className="mono" style={{ color: 'var(--ink)' }}>{rule.executionCount.toLocaleString()}</strong></span>
                <span>Last executed: <strong className="mono" style={{ color: 'var(--ink-2)' }}>{rule.lastExecuted}</strong></span>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
