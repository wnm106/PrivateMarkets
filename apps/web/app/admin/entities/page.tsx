'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  graphqlClient,
  DOMAIN_TYPES_QUERY,
  ATTRIBUTE_REGISTER_QUERY,
  DOMAIN_TEMPLATES_QUERY,
  CREATE_DOMAIN_TYPE_MUTATION,
} from '@/lib/graphql';

interface DomainType {
  id: string;
  domainCode: string;
  domainName: string;
  description?: string;
  isActive: boolean;
}

interface Attribute {
  id: string;
  referenceDomainCode?: string;
}

interface Template {
  id: string;
  domainCode: string;
}

// Top-level entity type directory. Entities are the top level of navigation --
// drilling into one (via /admin/entities/[domainCode]) is where relationship
// types, identifiers, attributes, and templates for that specific entity type
// are actually managed. Nothing entity-type-specific lives here anymore.
export default function EntityManagementPage() {
  const [domainTypes, setDomainTypes] = useState<DomainType[]>([]);
  const [attributes, setAttributes] = useState<Attribute[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showCreateDomainModal, setShowCreateDomainModal] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const domainsResult = await graphqlClient.query(DOMAIN_TYPES_QUERY, {}).toPromise();
      setDomainTypes(domainsResult.data?.domainTypes || []);

      const attrsResult = await graphqlClient.query(ATTRIBUTE_REGISTER_QUERY, {}).toPromise();
      setAttributes(attrsResult.data?.attributeRegister || []);

      const templatesResult = await graphqlClient.query(DOMAIN_TEMPLATES_QUERY, {}).toPromise();
      setTemplates(templatesResult.data?.domainTemplates || []);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDomain = async (data: any) => {
    try {
      await graphqlClient.mutation(CREATE_DOMAIN_TYPE_MUTATION, { input: data }).toPromise();
      setShowCreateDomainModal(false);
      loadData();
    } catch (error) {
      console.error('Error creating domain:', error);
    }
  };

  const getDomainColor = (domainCode: string) => {
    const colors: Record<string, string> = {
      FUND: '#1b3a4b',
      ISSUER: '#6d28d9',
      SECURITY: '#c2410c',
      DEAL: '#047857',
      INVESTOR: '#be185d',
      POSITION: '#0369a1'
    };
    return colors[domainCode] || '#6b7280';
  };

  if (loading) {
    return (
      <div className="view-fade">
        <div className="page-header">
          <div className="page-title">Entity Management</div>
        </div>
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--ink-3)' }}>
          Loading entity types...
        </div>
      </div>
    );
  }

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/admin" className="crumb-link">Admin</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Entity Management</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
          <div>
            <div className="page-title">Entity Types</div>
            <div className="page-meta">
              Select an entity type to manage its attributes, templates, relationship types, and identifiers
            </div>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setShowCreateDomainModal(true)}>
            + Entity Type
          </button>
        </div>
      </div>

      {/* Entity Types Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
        {domainTypes.map(domain => {
          const domainAttrs = attributes.filter(a =>
            !a.referenceDomainCode || a.referenceDomainCode === domain.domainCode
          );
          const domainTemplates = templates.filter(t => t.domainCode === domain.domainCode);

          return (
            <Link
              key={domain.id}
              href={`/admin/entities/${domain.domainCode}`}
              className="entity-card"
              style={{
                cursor: 'pointer',
                display: 'block',
                textDecoration: 'none',
                color: 'inherit',
                '--card-accent': getDomainColor(domain.domainCode)
              } as React.CSSProperties}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '12px' }}>
                <div>
                  <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '4px' }}>
                    {domain.domainName}
                  </div>
                  <div className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
                    {domain.domainCode}
                  </div>
                </div>
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '6px',
                    background: getDomainColor(domain.domainCode),
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white',
                    fontWeight: 600,
                    fontSize: '14px'
                  }}
                >
                  {domain.domainCode[0]}
                </div>
              </div>

              {domain.description && (
                <div style={{ fontSize: '13px', color: 'var(--ink-2)', marginBottom: '12px' }}>
                  {domain.description}
                </div>
              )}

              <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: 'var(--ink-3)' }}>
                <span>{domainAttrs.length} attributes</span>
                <span>{domainTemplates.length} templates</span>
              </div>
            </Link>
          );
        })}
      </div>

      {domainTypes.length === 0 && (
        <div className="alert alert-info">
          No entity types defined yet. Click "+ Entity Type" to create your first entity type (e.g., Fund, Security, Borrower).
        </div>
      )}

      {/* Create Domain Modal */}
      {showCreateDomainModal && (
        <CreateDomainModal
          onClose={() => setShowCreateDomainModal(false)}
          onSubmit={handleCreateDomain}
        />
      )}
    </div>
  );
}

// Create Domain Modal
function CreateDomainModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (data: any) => void }) {
  const [formData, setFormData] = useState({
    domainCode: '',
    domainName: '',
    description: ''
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <div
      className="overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg)',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '500px',
          border: '1px solid var(--line)'
        }}
        onClick={e => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <div style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--line)'
          }}>
            <div style={{ fontSize: '18px', fontWeight: 600 }}>
              Create Entity Type
            </div>
          </div>

          <div style={{ padding: '24px' }}>
            <div style={{ display: 'grid', gap: '16px' }}>
              <div className="field">
                <label>Domain Code *</label>
                <input
                  type="text"
                  className="text-input"
                  value={formData.domainCode}
                  onChange={e => setFormData(prev => ({ ...prev, domainCode: e.target.value.toUpperCase() }))}
                  placeholder="e.g., FUND, SECURITY, BORROWER"
                  required
                />
                <div style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: '4px' }}>
                  Unique identifier (uppercase)
                </div>
              </div>
              <div className="field">
                <label>Domain Name *</label>
                <input
                  type="text"
                  className="text-input"
                  value={formData.domainName}
                  onChange={e => setFormData(prev => ({ ...prev, domainName: e.target.value }))}
                  placeholder="e.g., Fund, Security, Borrower"
                  required
                />
              </div>
              <div className="field">
                <label>Description</label>
                <textarea
                  className="text-input"
                  value={formData.description}
                  onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="What is this entity type?"
                  rows={3}
                />
              </div>
            </div>
          </div>

          <div style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px'
          }}>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}
