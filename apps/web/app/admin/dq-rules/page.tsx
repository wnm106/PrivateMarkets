'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { graphqlQuery, DQ_RULES_QUERY } from '@/lib/graphql';

interface DQRule {
  id: string;
  name: string;
  description: string;
  type: 'Availability' | 'Tolerance' | 'Trajectory';
  scope: 'domain' | 'template' | 'attribute';
  scopeRef: string;
  scopeLabel: string;
  threshold: number;
  severity: 'high' | 'medium' | 'low';
  enabled: boolean;
  exceptionCount: number;
  lastEvaluated: string;
  createdAt: string;
  updatedAt: string;
}

export default function DQRulesPage() {
  const [filterType, setFilterType] = useState<string>('all');
  const [filterSeverity, setFilterSeverity] = useState<string>('all');
  const [filterEnabled, setFilterEnabled] = useState<string>('all');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingRule, setEditingRule] = useState<DQRule | null>(null);
  const [rules, setRules] = useState<DQRule[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRules = async () => {
      try {
        const result = await graphqlQuery<{ dqRules: DQRule[] }>(
          DQ_RULES_QUERY,
          {}
        );
        
        if (result.data?.dqRules) {
          setRules(result.data.dqRules);
        }
      } catch (error) {
        console.error('Error fetching DQ rules:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchRules();
  }, []);

  const filteredRules = rules.filter(rule => {
    if (filterType !== 'all' && rule.type !== filterType) return false;
    if (filterSeverity !== 'all' && rule.severity !== filterSeverity) return false;
    if (filterEnabled === 'enabled' && !rule.enabled) return false;
    if (filterEnabled === 'disabled' && rule.enabled) return false;
    return true;
  });

  const handleCreate = (data: any) => {
    console.log('Creating DQ rule:', data);
    setShowCreateForm(false);
  };

  const handleEdit = (data: any) => {
    console.log('Editing DQ rule:', data);
    setEditingRule(null);
  };

  return (
    <div className="view-fade">
      {/* Breadcrumb */}
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Data Quality Rules</span>
      </div>

      {/* Page Header */}
      <div className="page-header">
        <div>
          <div className="page-title">Data Quality Rules</div>
          <div className="page-meta">
            {loading ? 'Loading...' : `${rules.length} rules defined · ${rules.filter(r => r.enabled).length} active · ${rules.reduce((sum, r) => sum + r.exceptionCount, 0)} total exceptions`}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn">Export</button>
          <button className="btn btn-primary" onClick={() => setShowCreateForm(true)}>+ New Rule</button>
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div className="loader">Loading DQ rules...</div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="filter-bar">
        <div className="filter-label">Filter</div>
        <select
          className="select"
          style={{ padding: '5px 30px 5px 11px', fontSize: '11px' }}
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
        >
          <option value="all">All Types</option>
          <option value="Availability">Availability</option>
          <option value="Tolerance">Tolerance</option>
          <option value="Trajectory">Trajectory</option>
        </select>
        <select
          className="select"
          style={{ padding: '5px 30px 5px 11px', fontSize: '11px' }}
          value={filterSeverity}
          onChange={(e) => setFilterSeverity(e.target.value)}
        >
          <option value="all">All Severities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select
          className="select"
          style={{ padding: '5px 30px 5px 11px', fontSize: '11px' }}
          value={filterEnabled}
          onChange={(e) => setFilterEnabled(e.target.value)}
        >
          <option value="all">All Status</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
        <div className="filter-count">
          Showing <strong>{filteredRules.length}</strong> of {rules.length}
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div className="loader">Loading DQ rules...</div>
        </div>
      )}

      {!loading && (
        <>
          {/* Rules Table */}
          <div className="data-table">
        <div style={{
          display: 'grid',
          gridTemplateColumns: '100px 1.6fr 120px 110px 90px 80px 90px 100px',
          gap: '14px',
          padding: '12px 18px',
          background: 'var(--bg)',
          borderBottom: '1px solid var(--line)',
          fontSize: '10px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '1.2px',
          color: 'var(--ink-3)',
        }}>
          <div>ID</div>
          <div>Name</div>
          <div>Type</div>
          <div>Scope</div>
          <div style={{ textAlign: 'center' }}>Threshold</div>
          <div style={{ textAlign: 'center' }}>Severity</div>
          <div style={{ textAlign: 'center' }}>Exceptions</div>
          <div style={{ textAlign: 'center' }}>Status</div>
        </div>
        {filteredRules.map(rule => (
          <div
            key={rule.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '100px 1.6fr 120px 110px 90px 80px 90px 100px',
              gap: '14px',
              padding: '14px 18px',
              borderBottom: '1px solid var(--line)',
              fontSize: '12px',
              alignItems: 'center',
              cursor: 'pointer',
              transition: 'background 0.1s',
              opacity: rule.enabled ? 1 : 0.6,
            }}
            onClick={() => setEditingRule(rule)}
            onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg)')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <div className="mono" style={{ color: 'var(--accent)', fontWeight: 500, fontSize: '11px' }}>
              {rule.id}
            </div>
            <div>
              <div style={{ color: 'var(--ink)', fontWeight: 500, marginBottom: '2px' }}>
                {rule.name}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--ink-3)', lineHeight: 1.4 }}>
                {rule.description}
              </div>
            </div>
            <div>
              <span style={{
                fontSize: '10px',
                padding: '3px 8px',
                background: rule.type === 'Availability' ? '#e8eef2' : rule.type === 'Tolerance' ? '#fde9d7' : '#f3eafd',
                color: rule.type === 'Availability' ? 'var(--accent-2)' : rule.type === 'Tolerance' ? '#c2410c' : '#6d28d9',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}>
                {rule.type}
              </span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
              <div style={{ textTransform: 'capitalize' }}>{rule.scope}</div>
              <div className="mono" style={{ fontSize: '10px', color: 'var(--ink-3)' }}>{rule.scopeLabel}</div>
            </div>
            <div style={{ textAlign: 'center', fontFamily: 'var(--font-ibm-plex-mono), monospace', fontWeight: 500 }}>
              {rule.threshold}{rule.type === 'Tolerance' ? '%' : ''}
            </div>
            <div style={{ textAlign: 'center' }}>
              <span style={{
                display: 'inline-block',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: rule.severity === 'high' ? 'var(--red)' : rule.severity === 'medium' ? 'var(--amber)' : 'var(--ink-4)',
                marginRight: '6px',
              }}></span>
              <span style={{ textTransform: 'capitalize', fontSize: '11px', fontWeight: 500 }}>
                {rule.severity}
              </span>
            </div>
            <div style={{ textAlign: 'center' }}>
              {rule.exceptionCount > 0 ? (
                <span style={{
                  display: 'inline-block',
                  padding: '2px 9px',
                  background: '#fdecec',
                  color: 'var(--red)',
                  fontWeight: 600,
                  fontSize: '11px',
                  fontFamily: 'var(--font-ibm-plex-mono), monospace',
                }}>
                  {rule.exceptionCount}
                </span>
              ) : (
                <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓</span>
              )}
            </div>
            <div style={{ textAlign: 'center' }}>
              {rule.enabled ? (
                <span style={{
                  fontSize: '10px',
                  padding: '3px 8px',
                  background: '#e1f1e7',
                  color: 'var(--green)',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}>
                  Active
                </span>
              ) : (
                <span style={{
                  fontSize: '10px',
                  padding: '3px 8px',
                  background: 'var(--bg-alt)',
                  color: 'var(--ink-3)',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}>
                  Disabled
                </span>
              )}
            </div>
          </div>
        ))}

        {/* Empty State */}
        {filteredRules.length === 0 && !loading && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--ink-3)' }}>
            <div style={{ fontSize: '24px', marginBottom: '8px' }}>No DQ rules found</div>
            <div style={{ fontSize: '14px', maxWidth: '400px', margin: '0 auto' }}>
              Create your first data quality rule to monitor and maintain data standards
            </div>
            <div style={{ marginTop: '16px' }}>
              <button className="btn btn-primary" onClick={() => setShowCreateForm(true)}>
                + Create Rule
              </button>
            </div>
          </div>
        )}
          </div>
        </>
      )}

      {/* Create/Edit Modal */}
      {(showCreateForm || editingRule) && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
        }}>
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            padding: '24px',
            maxWidth: '700px',
            width: '90%',
            maxHeight: '80vh',
            overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div>
                <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--accent)', fontWeight: 600, marginBottom: '4px' }}>
                  {showCreateForm ? 'Create' : 'Edit'}
                </div>
                <div style={{ fontFamily: 'var(--font-ibm-plex-serif), serif', fontSize: '18px', fontWeight: 600 }}>
                  Data Quality Rule
                </div>
              </div>
              <button
                className="btn btn-sm"
                onClick={() => { setShowCreateForm(false); setEditingRule(null); }}
              >
                ✕ Close
              </button>
            </div>

            <div className="form-grid">
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Rule Name *</label>
                <input
                  className="text-input"
                  defaultValue={editingRule?.name || ''}
                  placeholder="Descriptive rule name"
                />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Description</label>
                <textarea
                  className="text-input"
                  defaultValue={editingRule?.description || ''}
                  placeholder="What this rule checks"
                  rows={2}
                  style={{ resize: 'vertical' }}
                />
              </div>
              <div className="field">
                <label>Rule Type *</label>
                <select className="select" defaultValue={editingRule?.type || 'Availability'}>
                  <option value="Availability">Availability</option>
                  <option value="Tolerance">Tolerance</option>
                  <option value="Trajectory">Trajectory</option>
                </select>
              </div>
              <div className="field">
                <label>Apply To *</label>
                <select className="select" defaultValue={editingRule?.scope || 'domain'}>
                  <option value="domain">Domain</option>
                  <option value="template">Template</option>
                  <option value="attribute">Attribute</option>
                </select>
              </div>
              <div className="field">
                <label>Scope Reference</label>
                <input
                  className="text-input"
                  defaultValue={editingRule?.scopeRef || ''}
                  placeholder="e.g., securities, LOAN, ATTR-001"
                />
              </div>
              <div className="field">
                <label>Threshold</label>
                <input
                  className="text-input mono"
                  type="number"
                  defaultValue={editingRule?.threshold || 100}
                />
              </div>
              <div className="field">
                <label>Severity *</label>
                <select className="select" defaultValue={editingRule?.severity || 'medium'}>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
              <div className="field">
                <label>Enabled</label>
                <select className="select" defaultValue={editingRule?.enabled ? 'true' : 'false'}>
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </div>
            </div>

            {editingRule && (
              <div style={{ marginTop: '18px', padding: '14px', background: 'var(--bg)', border: '1px solid var(--line)' }}>
                <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '8px' }}>
                  Rule Statistics
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', fontSize: '12px' }}>
                  <div>
                    <div style={{ color: 'var(--ink-3)', fontSize: '10px', marginBottom: '2px' }}>Exceptions</div>
                    <div className="mono" style={{ fontWeight: 600, color: editingRule.exceptionCount > 0 ? 'var(--red)' : 'var(--green)' }}>
                      {editingRule.exceptionCount}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--ink-3)', fontSize: '10px', marginBottom: '2px' }}>Last Evaluated</div>
                    <div className="mono" style={{ fontWeight: 600 }}>{editingRule.lastEvaluated}</div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--ink-3)', fontSize: '10px', marginBottom: '2px' }}>Created</div>
                    <div className="mono" style={{ fontWeight: 600 }}>{editingRule.createdAt}</div>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '20px' }}>
              <button className="btn" onClick={() => { setShowCreateForm(false); setEditingRule(null); }}>Cancel</button>
              <button className="btn" onClick={() => console.log('Test rule')}>Test Rule</button>
              <button className="btn btn-primary" onClick={() => {
                if (showCreateForm) handleCreate({});
                else handleEdit({});
              }}>
                {showCreateForm ? 'Create Rule' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
