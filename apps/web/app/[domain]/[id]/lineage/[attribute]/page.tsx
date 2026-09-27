'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { DomainKey } from '@/lib/mock-data'; // Only keeping DomainKey type
import { graphqlQuery, ENTITY_QUERY } from '@/lib/graphql';
import { sources } from '@/lib/data';

export default function AttributeLineagePage() {
  const params = useParams();
  const domain = params.domain as DomainKey;
  const id = params.id as string;
  const attributeCode = params.attribute as string;
  const domainConfig = getDomainConfig(domain);

  const [showOverride, setShowOverride] = useState(false);
  const [overrideValue, setOverrideValue] = useState('');
  const [overrideJustification, setOverrideJustification] = useState('');

  const handleOverride = () => {
    console.log('Override:', { value: overrideValue, justification: overrideJustification });
    setShowOverride(false);
  };

  return (
    <div className="view-fade">
      {/* Breadcrumb */}
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href={`/${domain}`} className="crumb-link">{domainConfig.name}</Link>
        <span className="sep">›</span>
        <Link href={`/${domain}/${id}`} className="crumb-link">{id}</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{attributeCode} Lineage</span>
      </div>

      {/* Page Header */}
      <div className="page-header">
        <div>
          <div className="page-title">{attributeCode} · Attribute Lineage</div>
          <div className="page-meta">
            {domainConfig.name} · {id} · Bi-temporal history and source values
          </div>
        </div>
        <div className="page-actions">
          <Link href={`/${domain}/${id}`}>
            <button className="btn">← Back to Entity</button>
          </Link>
          <button className="btn btn-primary" onClick={() => setShowOverride(true)}>
            Manual Override
          </button>
        </div>
      </div>

      {/* Timeline Visualization */}
      <div className="builder-card">
        <div className="builder-card-head">
          <div className="builder-step">
            <div className="step-number">T</div>
            <div className="step-title">Bi-Temporal Timeline</div>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
            Valid time (when fact was true) vs System time (when database learned)
          </span>
        </div>
        <div className="builder-body">
          <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', padding: '20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '20px', marginBottom: '20px' }}>
              <div>
                <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '8px' }}>
                  Valid Time Axis
                </div>
                <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
                  When the fact was true in the real world
                </div>
              </div>
              <div style={{ height: '60px', background: 'var(--surface)', border: '1px solid var(--line-strong)', position: 'relative' }}>
                <div style={{ position: 'absolute', left: '10%', top: '50%', transform: 'translateY(-50%)', fontSize: '10px', color: 'var(--ink-3)' }}>
                  2025-09
                </div>
                <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translateY(-50%)', fontSize: '10px', color: 'var(--ink-3)' }}>
                  2026-01
                </div>
                <div style={{ position: 'absolute', right: '10%', top: '50%', transform: 'translateY(-50%)', fontSize: '10px', color: 'var(--ink-3)' }}>
                  2026-05
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '20px' }}>
              <div>
                <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '8px' }}>
                  System Time Axis
                </div>
                <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
                  When the database learned about it
                </div>
              </div>
              <div style={{ height: '60px', background: 'var(--surface)', border: '1px solid var(--line-strong)', position: 'relative' }}>
                <div style={{ position: 'absolute', left: '15%', top: '50%', transform: 'translateY(-50%)', fontSize: '10px', color: 'var(--ink-3)' }}>
                  2025-09-01
                </div>
                <div style={{ position: 'absolute', left: '55%', top: '50%', transform: 'translateY(-50%)', fontSize: '10px', color: 'var(--ink-3)' }}>
                  2026-01-15
                </div>
                <div style={{ position: 'absolute', right: '15%', top: '50%', transform: 'translateY(-50%)', fontSize: '10px', color: 'var(--ink-3)' }}>
                  2026-05-15
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Source Values Timeline */}
      <div className="builder-card">
        <div className="builder-card-head">
          <div className="builder-step">
            <div className="step-number">S</div>
            <div className="step-title">Source Values & Golden Record</div>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
            All source values with timestamps and precedence rules
          </span>
        </div>
        <div className="builder-body">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--line)' }}>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.2px', color: 'var(--ink-3)', fontWeight: 600 }}>
                    Source
                  </th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.2px', color: 'var(--ink-3)', fontWeight: 600 }}>
                    Value
                  </th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.2px', color: 'var(--ink-3)', fontWeight: 600 }}>
                    Valid From
                  </th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.2px', color: 'var(--ink-3)', fontWeight: 600 }}>
                    System Time
                  </th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.2px', color: 'var(--ink-3)', fontWeight: 600 }}>
                    Rule Applied
                  </th>
                  <th style={{ padding: '12px', textAlign: 'center', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.2px', color: 'var(--ink-3)', fontWeight: 600 }}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {attributeLineage.map((entry) => {
                  const src = sources[entry.source];
                  return (
                    <tr
                      key={entry.id}
                      style={{
                        borderBottom: '1px solid var(--line)',
                        background: entry.isGolden ? '#f0f7f2' : 'transparent',
                      }}
                    >
                      <td style={{ padding: '12px' }}>
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
                      </td>
                      <td style={{ padding: '12px' }}>
                        <span className="mono" style={{ fontWeight: entry.isGolden ? 600 : 400, color: entry.isGolden ? 'var(--ink)' : 'var(--ink-2)' }}>
                          {entry.value}
                        </span>
                      </td>
                      <td style={{ padding: '12px', fontSize: '11px', color: 'var(--ink-3)' }} className="mono">
                        {entry.validFrom}
                        {entry.validTo && <span> → {entry.validTo}</span>}
                      </td>
                      <td style={{ padding: '12px', fontSize: '11px', color: 'var(--ink-3)' }} className="mono">
                        {entry.systemTime}
                      </td>
                      <td style={{ padding: '12px', fontSize: '11px', color: 'var(--ink-3)' }} className="mono">
                        {entry.ruleApplied}
                      </td>
                      <td style={{ padding: '12px', textAlign: 'center' }}>
                        {entry.isGolden && (
                          <span style={{ background: 'var(--green)', color: '#fff', padding: '3px 8px', fontSize: '9px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                            Golden
                          </span>
                        )}
                        {entry.superseded && (
                          <span style={{ background: 'var(--bg-alt)', color: 'var(--ink-3)', padding: '3px 8px', fontSize: '9px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                            Superseded
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Audit Trail */}
      <div className="builder-card">
        <div className="builder-card-head">
          <div className="builder-step">
            <div className="step-number">A</div>
            <div className="step-title">Audit Trail</div>
          </div>
        </div>
        <div className="builder-body">
          {[
            { who: 'Bill Reagan', initials: 'BR', action: 'Manual override', value: '600', timestamp: '2026-05-17 09:08', source: 'Manual Override' },
            { who: 'System', initials: 'SY', action: 'Precedence rule applied', value: '575', timestamp: '2026-05-15 22:00', source: 'RULE-SEC-018' },
            { who: 'System', initials: 'SY', action: 'Sync completed', value: '575', timestamp: '2026-05-15 22:00', source: 'WSO' },
            { who: 'System', initials: 'SY', action: 'Precedence rule applied', value: '550', timestamp: '2026-01-15 22:00', source: 'RULE-SEC-018' },
          ].map((entry, idx) => (
            <div key={idx} className="activity-item">
              <div className="act-avatar">{entry.initials}</div>
              <div style={{ flex: 1 }}>
                <div className="act-txt">
                  <strong>{entry.who}</strong> {entry.action} · <span className="mono">{entry.value}</span>
                </div>
                <div className="act-time">
                  {entry.timestamp} · {entry.source}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Override Modal */}
      {showOverride && (
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
            maxWidth: '500px',
            width: '90%',
          }}>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--accent)', fontWeight: 600, marginBottom: '8px' }}>
              Manual Override
            </div>
            <div style={{ fontFamily: 'var(--font-ibm-plex-serif), serif', fontSize: '18px', fontWeight: 600, marginBottom: '16px' }}>
              Override {attributeCode} Value
            </div>
            <div className="form-grid" style={{ marginBottom: '16px' }}>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>New Value *</label>
                <input
                  className="text-input mono"
                  value={overrideValue}
                  onChange={(e) => setOverrideValue(e.target.value)}
                  placeholder="Enter override value"
                />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Justification (required for audit) *</label>
                <textarea
                  className="text-input"
                  value={overrideJustification}
                  onChange={(e) => setOverrideJustification(e.target.value)}
                  placeholder="Explain why this override is necessary..."
                  rows={4}
                  style={{ resize: 'vertical' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setShowOverride(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleOverride}>Apply Override</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
