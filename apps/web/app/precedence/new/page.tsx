'use client';

import Link from 'next/link';
import { sources } from '@/lib/data';

export default function RuleBuilderPage() {
  return (
    <div className="view-fade">
      {/* Breadcrumb */}
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/precedence" className="crumb-link">Precedence Rules</Link>
        <span className="sep">›</span>
        <span className="crumb-current">New Rule</span>
      </div>

      {/* Page Header */}
      <div className="page-header">
        <div>
          <div className="page-title">Build Precedence Rule</div>
          <div className="page-meta">
            Define a field, the conditions under which this rule applies, and the source priority chain.
          </div>
        </div>
        <div className="page-actions">
          <Link href="/precedence">
            <button className="btn">Cancel</button>
          </Link>
          <button className="btn">Save as Draft</button>
          <button className="btn btn-primary">Activate Rule</button>
        </div>
      </div>

      <div className="builder-layout">
        <div>
          {/* Step 1: Scope */}
          <div className="builder-card">
            <div className="builder-card-head">
              <div className="builder-step">
                <div className="step-number">1</div>
                <div className="step-title">Rule Scope</div>
              </div>
              <span className="rec-time">Define what this rule targets</span>
            </div>
            <div className="builder-body">
              <div className="form-grid">
                <div className="field">
                  <label>Entity Domain</label>
                  <select className="select">
                    <option>Securities</option>
                    <option>Issuers</option>
                    <option>Funds</option>
                    <option>Deals</option>
                    <option>Investors</option>
                  </select>
                </div>
                <div className="field">
                  <label>Field</label>
                  <select className="select">
                    <option>Spread (bps)</option>
                    <option>Maturity Date</option>
                    <option>Notional</option>
                    <option>Reference Rate</option>
                    <option>Issuer Name</option>
                  </select>
                </div>
                <div className="field">
                  <label>Rule Name</label>
                  <input className="text-input" value="Spread — Loan Products (WSO Primary)" />
                </div>
                <div className="field">
                  <label>Priority Tier</label>
                  <select className="select">
                    <option>Field-specific (overrides domain default)</option>
                    <option>Domain default</option>
                    <option>Fallback only</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Step 2: Conditions */}
          <div className="builder-card">
            <div className="builder-card-head">
              <div className="builder-step">
                <div className="step-number">2</div>
                <div className="step-title">When This Rule Applies</div>
              </div>
              <span className="rec-time">Build the condition tree</span>
            </div>
            <div className="builder-body">
              <div className="cond-group">
                <div className="cond-group-head">
                  <span className="cond-group-label">IF ALL (AND)</span>
                  <button className="btn btn-sm" style={{ padding: '4px 10px' }}>
                    Change to ANY
                  </button>
                </div>
                <div className="cond-row">
                  <select className="select">
                    <option>Instrument Type</option>
                    <option>Currency</option>
                    <option>Seniority</option>
                  </select>
                  <select className="select">
                    <option>is one of</option>
                    <option>equals</option>
                    <option>is not</option>
                  </select>
                  <input className="text-input" value="Term Loan B, Unitranche, Revolver, DDTL, Second Lien" />
                  <button className="cond-remove">✕</button>
                </div>
                <div className="cond-row">
                  <select className="select">
                    <option>Asset Class</option>
                    <option>Instrument Type</option>
                  </select>
                  <select className="select">
                    <option>equals</option>
                    <option>is one of</option>
                  </select>
                  <input className="text-input" value="Private Credit" />
                  <button className="cond-remove">✕</button>
                </div>
                <button className="add-cond">+ Add condition</button>
              </div>

              <div className="group-joiner">
                <span>OR</span>
              </div>

              <div className="cond-group" style={{ opacity: 0.6 }}>
                <div className="cond-group-head">
                  <span className="cond-group-label">IF ALL (AND)</span>
                  <button className="btn btn-sm" style={{ padding: '4px 10px' }}>
                    + Add
                  </button>
                </div>
                <button className="add-cond">+ Add condition</button>
              </div>

              <button className="add-cond" style={{ marginTop: '12px' }}>
                + Add condition group
              </button>
            </div>
          </div>

          {/* Step 3: Precedence Chain */}
          <div className="builder-card">
            <div className="builder-card-head">
              <div className="builder-step">
                <div className="step-number">3</div>
                <div className="step-title">Source Precedence Chain</div>
              </div>
              <span className="rec-time">Drag to reorder · top wins</span>
            </div>
            <div className="builder-body">
              <div className="precedence-builder">
                <div className="prec-source-item">
                  <span className="drag-handle">⋮⋮</span>
                  <div className="prec-rank">1</div>
                  <div className="prec-source-name">
                    <span
                      className="src-badge"
                      style={{
                        color: sources.wso.hex,
                        borderColor: `${sources.wso.hex}40`,
                        background: `${sources.wso.hex}0a`,
                      }}
                    >
                      <span className="dot" style={{ background: sources.wso.hex }}></span>
                      {sources.wso.name}
                    </span>
                    <span style={{ color: 'var(--ink)', fontWeight: 500 }}>WSO</span>
                  </div>
                  <div className="prec-condition">if value present</div>
                  <button className="cond-remove">✕</button>
                </div>
                <div className="prec-source-item">
                  <span className="drag-handle">⋮⋮</span>
                  <div className="prec-rank">2</div>
                  <div className="prec-source-name">
                    <span
                      className="src-badge"
                      style={{
                        color: sources.manual.hex,
                        borderColor: `${sources.manual.hex}40`,
                        background: `${sources.manual.hex}0a`,
                      }}
                    >
                      <span className="dot" style={{ background: sources.manual.hex }}></span>
                      {sources.manual.name}
                    </span>
                    <span style={{ color: 'var(--ink)', fontWeight: 500 }}>Manual Override</span>
                  </div>
                  <div className="prec-condition">if override exists</div>
                  <button className="cond-remove">✕</button>
                </div>
                <div className="prec-source-item">
                  <span className="drag-handle">⋮⋮</span>
                  <div className="prec-rank">3</div>
                  <div className="prec-source-name">
                    <span
                      className="src-badge"
                      style={{
                        color: sources.bloomberg.hex,
                        borderColor: `${sources.bloomberg.hex}40`,
                        background: `${sources.bloomberg.hex}0a`,
                      }}
                    >
                      <span className="dot" style={{ background: sources.bloomberg.hex }}></span>
                      {sources.bloomberg.name}
                    </span>
                    <span style={{ color: 'var(--ink)', fontWeight: 500 }}>Bloomberg</span>
                  </div>
                  <div className="prec-condition">fallback</div>
                  <button className="cond-remove">✕</button>
                </div>
              </div>
              <button className="add-cond" style={{ marginTop: '12px' }}>
                + Add source to chain
              </button>

              <div
                style={{
                  marginTop: '18px',
                  padding: '14px',
                  background: 'var(--bg)',
                  borderLeft: '3px solid var(--accent-2)',
                }}
              >
                <div
                  style={{
                    fontSize: '10px',
                    textTransform: 'uppercase',
                    letterSpacing: '1.5px',
                    color: 'var(--accent-2)',
                    fontWeight: 700,
                    marginBottom: '6px',
                  }}
                >
                  Tie-Breaking Rule
                </div>
                <div style={{ fontSize: '12px', color: 'var(--ink-2)', marginBottom: '8px' }}>
                  When two sources both have a value at the same priority, choose by:
                </div>
                <select className="select" style={{ width: '280px' }}>
                  <option>Most recently updated (timestamp)</option>
                  <option>Highest source reliability score</option>
                  <option>Always flag as conflict</option>
                </select>
              </div>
            </div>
          </div>

          {/* Step 4: Normalization */}
          <div className="builder-card">
            <div className="builder-card-head">
              <div className="builder-step">
                <div className="step-number">4</div>
                <div className="step-title">Normalization (Optional)</div>
              </div>
              <span className="rec-time">For standardized list values</span>
            </div>
            <div className="builder-body">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px 14px',
                  background: 'var(--bg)',
                  marginBottom: '14px',
                }}
              >
                <input type="checkbox" id="std" style={{ width: '16px', height: '16px' }} />
                <label htmlFor="std" style={{ fontSize: '12px', color: 'var(--ink-2)', cursor: 'pointer' }}>
                  Map incoming values to a standardized list before applying precedence
                </label>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label>Target value list</label>
                  <select className="select" disabled style={{ opacity: 0.5 }}>
                    <option>— (Not applicable to numeric)</option>
                  </select>
                </div>
                <div className="field">
                  <label>On unmapped value</label>
                  <select className="select" disabled style={{ opacity: 0.5 }}>
                    <option>Flag as exception</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Rail: Live Preview */}
        <div className="preview-card">
          <div className="preview-eyebrow">Live Preview</div>
          <div className="preview-title">Generated Rule</div>
          <div className="pseudo-code">
            <span className="cmt">// Spread — Loan Products (WSO Primary)</span>
            <br />
            <span className="kw">RULE</span> <span className="src">spread_loan_primary</span>
            <br />
            <span className="kw">ON</span> Securities.spread_bps
            <br />
            <br />
            <span className="kw">WHEN</span>
            <br />
            <span className="ind">
              Instrument Type <span className="kw">IN</span> (<span className="val">'TLB', 'Unitranche',</span>
            </span>
            <br />
            <span className="ind">
              <span className="val">'Revolver', 'DDTL', '2L'</span>)
            </span>
            <br />
            <span className="ind">
              <span className="kw">AND</span> Asset Class = <span className="val">'Private Credit'</span>
            </span>
            <br />
            <br />
            <span className="kw">PRECEDENCE</span>
            <br />
            <span className="ind">
              1. <span className="src">wso</span> <span className="cmt">// if value present</span>
            </span>
            <br />
            <span className="ind">
              2. <span className="src">manual</span> <span className="cmt">// if override exists</span>
            </span>
            <br />
            <span className="ind">
              3. <span className="src">bloomberg</span> <span className="cmt">// fallback</span>
            </span>
            <br />
            <br />
            <span className="kw">TIE_BREAK</span> most_recent_timestamp
          </div>

          <div className="test-block">
            <div className="test-head">Test Against Real Records</div>
            <div className="test-result">
              <div className="res-rec">SEC-00413 · Northstar Health TLB</div>
              <div className="res-val">450 bps</div>
              <div className="res-src">from WSO · matches rule conditions ✓</div>
            </div>
            <div className="test-result">
              <div className="res-rec">SEC-00414 · BlueRiver Unitranche</div>
              <div className="res-val">575 bps</div>
              <div className="res-src">from WSO · matches rule conditions ✓</div>
            </div>
            <div className="test-result" style={{ background: '#fef9f9', borderLeftColor: 'var(--red)' }}>
              <div className="res-rec">SEC-00412 · Acme Industrial Notes</div>
              <div className="res-val" style={{ color: 'var(--ink-3)' }}>— Rule does not apply</div>
              <div className="res-src">Bond type — handled by RULE-SEC-019</div>
            </div>
            <button className="btn btn-sm" style={{ width: '100%', marginTop: '10px' }}>
              Test on full dataset
            </button>
          </div>
        </div>
      </div>

      <div className="builder-footer">
        <div className="left">
          This rule will affect <strong style={{ color: 'var(--ink)' }}>412 records</strong> on activation · Spread field will use WSO as primary
        </div>
        <div className="right">
          <Link href="/precedence">
            <button className="btn">Cancel</button>
          </Link>
          <button className="btn">Save as Draft</button>
          <button className="btn btn-primary">Activate Rule</button>
        </div>
      </div>
    </div>
  );
}
