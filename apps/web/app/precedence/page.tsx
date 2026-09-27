'use client';

import Link from 'next/link';
import { precedenceRules, sources } from '@/lib/data';

export default function PrecedencePage() {
  return (
    <div className="view-fade">
      {/* Breadcrumb */}
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Precedence Rules</span>
      </div>

      {/* Page Header */}
      <div className="page-header">
        <div>
          <div className="page-title">Source Precedence Rules</div>
          <div className="page-meta">
            42 rules active across 5 entity domains · Last edited 4h ago by Bill Reagan
          </div>
        </div>
        <div className="page-actions">
          <button className="btn">Test Rule</button>
          <button className="btn btn-primary">+ New Rule</button>
        </div>
      </div>

      {/* Rule Tabs */}
      <div className="rule-tabs">
        <button className="rule-tab active">Securities (24)</button>
        <button className="rule-tab">Issuers (8)</button>
        <button className="rule-tab">Funds (4)</button>
        <button className="rule-tab">Deals (3)</button>
        <button className="rule-tab">Investors (3)</button>
      </div>

      {/* Rule Cards */}
      {precedenceRules.map((rule, idx) => (
        <div key={idx} className="rule-card">
          <div className="rule-head">
            <div>
              <span className="rule-field-name">{rule.field}</span>
              {rule.standardized && <span className="std-pill">⊟ Standardized</span>}
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button className="btn btn-sm">Edit</button>
              <button className="btn btn-sm">Test</button>
            </div>
          </div>
          <div className="rule-cond">
            {rule.cond.split(/(WHEN|IN|IS NOT NULL|ALWAYS|AND)/g).map((part, i) => {
              if (['WHEN', 'IN', 'IS NOT NULL', 'ALWAYS', 'AND'].includes(part)) {
                return (
                  <span key={i} className="kw">
                    {part}
                  </span>
                );
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
        </div>
      ))}
    </div>
  );
}
