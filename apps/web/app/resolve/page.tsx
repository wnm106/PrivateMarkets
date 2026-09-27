'use client';

import { useState } from 'react';
import Link from 'next/link';
import { sources } from '@/lib/data';

export default function ResolvePage() {
  const [selectedCandidate, setSelectedCandidate] = useState<string | null>('manual');

  return (
    <div className="view-fade">
      {/* Breadcrumb */}
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/securities" className="crumb-link">Securities</Link>
        <span className="sep">›</span>
        <Link href="/securities/SEC-00414" className="crumb-link">SEC-00414</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Resolve Conflicts</span>
      </div>

      {/* Resolve Header */}
      <div className="resolve-header">
        <div className="resolve-eyebrow">⚠ Conflict Resolution Workflow</div>
        <div className="resolve-title">BlueRiver Energy Unitranche 2030 · 3 conflicts</div>
        <div className="resolve-sub">
          Review each disputed field, choose the authoritative value, and the system will write a resolution that survives subsequent source syncs.
        </div>
        <div className="resolve-progress">
          <div className="progress-step done"></div>
          <div className="progress-step active"></div>
          <div className="progress-step"></div>
          <span className="progress-label">Field 2 of 3 · Spread (bps)</span>
        </div>
      </div>

      {/* Resolve Layout */}
      <div className="resolve-layout">
        <div>
          {/* Conflict 1: Issuer Name (resolved) */}
          <div className="conflict-card">
            <div className="conflict-card-head">
              <div className="left">
                <div className="conflict-num-large">01</div>
                <div>
                  <div className="conflict-field-name">Issuer Name</div>
                  <div className="conflict-rule-applied">
                    RULE-ISS-042 · Manual override when set, else SPCIQ → Bloomberg → WSO
                  </div>
                </div>
              </div>
              <span className="severity-pill med">Medium · Normalization</span>
            </div>
            <div className="candidates-grid">
              <div className="candidate winner">
                <div className="candidate-head">
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
                  <span className="candidate-flag winner">✓ Resolved</span>
                </div>
                <div className="candidate-value">BlueRiver Energy LLC</div>
                <div className="candidate-meta">
                  <span className="k">Set by</span>
                  <span className="v">B. Reagan</span>
                  <span className="k">Set on</span>
                  <span className="v">2026-05-19 14:22</span>
                  <span className="k">Confidence</span>
                  <span className="v">100%</span>
                </div>
                <div className="candidate-radio">
                  <span className="radio-dot"></span>Selected — manual override
                </div>
              </div>
              <div className="candidate">
                <div className="candidate-head">
                  <span
                    className="src-badge"
                    style={{
                      color: sources.spciq.hex,
                      borderColor: `${sources.spciq.hex}40`,
                      background: `${sources.spciq.hex}0a`,
                    }}
                  >
                    <span className="dot" style={{ background: sources.spciq.hex }}></span>
                    {sources.spciq.name}
                  </span>
                  <span className="candidate-flag stale">Alt</span>
                </div>
                <div className="candidate-value muted">BlueRiver Energy, LLC</div>
                <div className="candidate-meta">
                  <span className="k">Last sync</span>
                  <span className="v">2026-05-20 06:14</span>
                  <span className="k">Source ID</span>
                  <span className="v">SP-IQ-489211</span>
                  <span className="k">Reliability</span>
                  <span className="v">93%</span>
                </div>
              </div>
              <div className="candidate">
                <div className="candidate-head">
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
                  <span className="candidate-flag stale">Alt</span>
                </div>
                <div className="candidate-value muted">Blue River Energy LLC</div>
                <div className="candidate-meta">
                  <span className="k">Last sync</span>
                  <span className="v">2026-05-20 06:14</span>
                  <span className="k">Source ID</span>
                  <span className="v">BBG-LX1284AB7</span>
                  <span className="k">Reliability</span>
                  <span className="v">97%</span>
                </div>
              </div>
              <div className="candidate">
                <div className="candidate-head">
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
                  <span className="candidate-flag stale">Alt</span>
                </div>
                <div className="candidate-value muted">BlueRiver Energy, LLC.</div>
                <div className="candidate-meta">
                  <span className="k">Last sync</span>
                  <span className="v">2026-05-20 22:00</span>
                  <span className="k">Source ID</span>
                  <span className="v">WSO-FAC-44871</span>
                  <span className="k">Reliability</span>
                  <span className="v">94%</span>
                </div>
              </div>
            </div>
          </div>

          {/* Conflict 2: Spread (active) */}
          <div className="conflict-card" style={{ borderColor: 'var(--accent)', boxShadow: '0 0 0 2px #fef6ec' }}>
            <div
              className="conflict-card-head"
              style={{ background: '#fef6ec', borderBottomColor: '#f4d4a3' }}
            >
              <div className="left">
                <div className="conflict-num-large" style={{ color: 'var(--accent)' }}>
                  02
                </div>
                <div>
                  <div className="conflict-field-name">Spread (bps)</div>
                  <div className="conflict-rule-applied">
                    RULE-SEC-018 · WSO (loans) → Manual → Bloomberg
                  </div>
                </div>
              </div>
              <span className="severity-pill high">High · Material Difference</span>
            </div>
            <div className="candidates-grid">
              <div
                className={`candidate ${selectedCandidate === 'manual' ? 'selected' : ''}`}
                onClick={() => setSelectedCandidate('manual')}
              >
                <div className="candidate-head">
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
                  <span className="candidate-flag selected">Selected</span>
                </div>
                <div className="candidate-value">600</div>
                <div className="candidate-meta">
                  <span className="k">Set by</span>
                  <span className="v">B. Reagan</span>
                  <span className="k">Set on</span>
                  <span className="v">2026-05-17 09:08</span>
                  <span className="k">Note</span>
                  <span className="v">Per amendment #3</span>
                </div>
                <div className="candidate-radio">
                  <span className="radio-dot"></span>Keep manual override
                </div>
              </div>
              <div
                className={`candidate ${selectedCandidate === 'wso' ? 'selected' : ''}`}
                onClick={() => setSelectedCandidate('wso')}
              >
                <div className="candidate-head">
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
                  <span className="candidate-flag stale">Per Rule</span>
                </div>
                <div className="candidate-value">575</div>
                <div className="candidate-meta">
                  <span className="k">Last sync</span>
                  <span className="v">2026-05-20 22:00</span>
                  <span className="k">Updated</span>
                  <span className="v">2026-05-15</span>
                  <span className="k">Reliability</span>
                  <span className="v">94%</span>
                </div>
                <div className="candidate-radio">
                  <span className="radio-dot"></span>Accept rule outcome
                </div>
              </div>
              <div className="candidate">
                <div className="candidate-head">
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
                  <span className="candidate-flag stale">Alt</span>
                </div>
                <div className="candidate-value muted">— Not covered</div>
                <div className="candidate-meta">
                  <span className="k">Status</span>
                  <span className="v">N/A for loan</span>
                  <span className="k">Last sync</span>
                  <span className="v">2026-05-20 06:14</span>
                </div>
              </div>
              <div
                className={`candidate ${selectedCandidate === 'custom' ? 'selected' : ''}`}
                onClick={() => setSelectedCandidate('custom')}
              >
                <div className="candidate-head">
                  <span
                    className="src-badge"
                    style={{
                      color: 'var(--ink-3)',
                      borderColor: 'var(--line)',
                      background: 'var(--bg)',
                    }}
                  >
                    <span className="dot" style={{ background: 'var(--ink-3)' }}></span>
                    Custom
                  </span>
                  <span className="candidate-flag stale">Manual entry</span>
                </div>
                <div className="candidate-value muted" style={{ fontSize: '14px', fontStyle: 'italic' }}>
                  Enter custom value below
                </div>
                <div className="candidate-meta">
                  <span className="k">Use when</span>
                  <span className="v">None correct</span>
                </div>
                <div className="candidate-radio">
                  <span className="radio-dot"></span>Custom value
                </div>
              </div>
            </div>
            <div className="custom-value-section">
              <div className="custom-value-head">Custom Value (when "Custom" selected)</div>
              <div className="custom-value-row">
                <input className="custom-input" placeholder="Enter value…" value="" />
                <select className="select" style={{ fontSize: '12px' }}>
                  <option>Reason: Source error</option>
                  <option>Reason: Per amendment</option>
                  <option>Reason: Manual confirmation</option>
                  <option>Reason: Other</option>
                </select>
              </div>
            </div>
            <div className="resolve-actions-bar">
              <div className="left">
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>●</span> Override will
                persist through next sync ·{' '}
                <a style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}>
                  Set expiration
                </a>
              </div>
              <div className="right">
                <button className="btn btn-sm">Defer</button>
                <button className="btn btn-sm btn-primary">Apply & Next →</button>
              </div>
            </div>
          </div>

          {/* Conflict 3: Maturity Date (pending) */}
          <div className="conflict-card">
            <div className="conflict-card-head">
              <div className="left">
                <div className="conflict-num-large">03</div>
                <div>
                  <div className="conflict-field-name">Maturity Date</div>
                  <div className="conflict-rule-applied">
                    RULE-SEC-021 · WSO → Bloomberg → Manual
                  </div>
                </div>
              </div>
              <span className="severity-pill med">Medium · Stale Source</span>
            </div>
            <div className="candidates-grid">
              <div className="candidate">
                <div className="candidate-head">
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
                  <span className="candidate-flag stale">Per Rule</span>
                </div>
                <div className="candidate-value">2030-09-15</div>
                <div className="candidate-meta">
                  <span className="k">Last sync</span>
                  <span className="v">2026-05-20 22:00</span>
                  <span className="k">Updated</span>
                  <span className="v">2026-04-02</span>
                </div>
                <div className="candidate-radio">
                  <span className="radio-dot"></span>Accept rule outcome
                </div>
              </div>
              <div className="candidate">
                <div className="candidate-head">
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
                  <span className="candidate-flag stale">Stale 30d</span>
                </div>
                <div className="candidate-value muted">2030-09-30</div>
                <div className="candidate-meta">
                  <span className="k">Last sync</span>
                  <span className="v">2026-05-20 06:14</span>
                  <span className="k">Updated</span>
                  <span className="v">2026-03-15</span>
                </div>
                <div className="candidate-radio">
                  <span className="radio-dot"></span>Override with Bloomberg
                </div>
              </div>
              <div className="candidate">
                <div className="candidate-head">
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
                  <span className="candidate-flag stale">Not set</span>
                </div>
                <div className="candidate-value muted">—</div>
                <div className="candidate-meta">
                  <span className="k">Status</span>
                  <span className="v">No override</span>
                </div>
              </div>
              <div className="candidate">
                <div className="candidate-head">
                  <span
                    className="src-badge"
                    style={{
                      color: 'var(--ink-3)',
                      borderColor: 'var(--line)',
                      background: 'var(--bg)',
                    }}
                  >
                    <span className="dot" style={{ background: 'var(--ink-3)' }}></span>
                    Custom
                  </span>
                  <span className="candidate-flag stale">Manual entry</span>
                </div>
                <div className="candidate-value muted" style={{ fontSize: '14px', fontStyle: 'italic' }}>
                  Enter custom value
                </div>
                <div className="candidate-meta">
                  <span className="k">Use when</span>
                  <span className="v">None correct</span>
                </div>
                <div className="candidate-radio">
                  <span className="radio-dot"></span>Custom value
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Summary Rail */}
        <div className="resolve-summary-card">
          <div className="summary-head">Resolution Summary</div>
          <div className="summary-row">
            <span className="l">Record</span>
            <span className="r">SEC-00414</span>
          </div>
          <div className="summary-row">
            <span className="l">Conflicts open</span>
            <span className="r" style={{ color: 'var(--red)' }}>
              3
            </span>
          </div>
          <div className="summary-row">
            <span className="l">Resolved this session</span>
            <span className="r" style={{ color: 'var(--green)' }}>
              1
            </span>
          </div>
          <div className="summary-row">
            <span className="l">Manual overrides set</span>
            <span className="r">1</span>
          </div>
          <div className="summary-row">
            <span className="l">Estimated time</span>
            <span className="r">~3 min</span>
          </div>

          <div className="summary-impact">
            <div className="l">Quality Impact After Apply</div>
            <div className="d">
              78 → 95<span style={{ fontSize: '14px', color: 'var(--green)' }}> ▲ 17</span>
            </div>
            <div className="x">Record will move out of "Has Conflicts" filter</div>
          </div>

          <div className="audit-note">
            <label>Resolution note (required for audit)</label>
            <textarea placeholder="e.g. Confirmed spread of 600bps against amendment #3 dated 2026-05-15…"></textarea>
          </div>

          <Link href="/securities/SEC-00414">
            <button className="summary-cta">Apply All Resolutions</button>
          </Link>
          <Link href="/securities/SEC-00414">
            <button className="summary-secondary">Save Draft & Exit</button>
          </Link>
        </div>
      </div>
    </div>
  );
}
