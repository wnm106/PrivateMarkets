'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { AppGrid } from '@/components/grid/AppGrid';
import { usePublishViewContext } from '@/lib/view-context';
import Link from 'next/link';
import { graphqlQuery, DOMAIN_TEMPLATES_QUERY, DOMAIN_TYPES_QUERY } from '@/lib/graphql';

interface Template {
  id: string;
  code: string;
  name: string;
  domain: string;
  description: string;
  statementKind?: string;
  attributes: Array<{
    attributeId: string;
    attributeCode: string;
    attributeName: string;
    required: boolean;
    displaySection: string;
    sortOrder: number;
  }>;
  entityCount: number;
  createdAt: string;
  updatedAt: string;
}

// GraphQL response shape from DOMAIN_TEMPLATES_QUERY
interface GraphQLTemplate {
  id: string;
  templateCode: string;
  templateName: string;
  domainCode: string;
  description?: string;
  isActive: boolean;
  attributes: Array<{
    attributeId: string;
    attribute: {
      attributeCode: string;
      attributeName: string;
      dataType: string;
    };
    isRequired: boolean;
    precedenceRank: number;
    displayOrder: number;
    displayLabel?: string;
    sectionName?: string | null;
  }>;
  applicabilityRules?: { statementKind?: string; entityCode?: string | null };
}

interface DomainConfig {
  key: string;
  name: string;
  color: string;
  count: number;
}

export default function TemplatesPage() {
  const [filterDomain, setFilterDomain] = useState<string>('all');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [domainConfigs, setDomainConfigs] = useState<DomainConfig[]>([]);
  const [loading, setLoading] = useState(true);

  usePublishViewContext(
    editingTemplate
      ? {
          activity: 'editing',
          kind: 'template',
          label: editingTemplate.name,
          id: editingTemplate.id,
          domainCode: editingTemplate.domain,
          summary: editingTemplate.description,
          snapshot: {
            code: editingTemplate.code,
            name: editingTemplate.name,
            domain: editingTemplate.domain,
            description: editingTemplate.description,
            attributes: editingTemplate.attributes.map((attribute) => attribute.attributeCode),
          },
        }
      : showCreateForm
        ? { activity: 'creating', kind: 'template', label: 'New template' }
        : filterDomain !== 'all'
          ? { activity: 'viewing', kind: 'templates', label: `${filterDomain} templates`, domainCode: filterDomain }
          : null
  );

  useEffect(() => {
    const fetchData = async () => {
      try {
        // Fetch templates
        const templatesResult = await graphqlQuery<{ domainTemplates: GraphQLTemplate[] }>(
          DOMAIN_TEMPLATES_QUERY,
          {}
        );
        
        if (templatesResult.data?.domainTemplates) {
          // Map GraphQL response to Template interface
          const mappedTemplates: Template[] = templatesResult.data.domainTemplates.map(gqlTpl => ({
            id: gqlTpl.id,
            code: gqlTpl.templateCode,
            name: gqlTpl.templateName,
            domain: gqlTpl.domainCode.toLowerCase(),
            description: gqlTpl.description || '',
            statementKind: gqlTpl.applicabilityRules?.statementKind,
            attributes: gqlTpl.attributes.map(attr => ({
              attributeId: attr.attributeId,
              attributeCode: attr.attribute.attributeCode,
              attributeName: attr.attribute.attributeName,
              required: attr.isRequired,
              displaySection: attr.sectionName || 'General',
              sortOrder: attr.displayOrder,
            })),
            entityCount: 0, // GraphQL doesn't return this, default to 0
            createdAt: '',
            updatedAt: '',
          }));
          setTemplates(mappedTemplates);
        }

        // Fetch domain types for domain configs
        const domainsResult = await graphqlQuery<{ domainTypes: Array<{ domainCode: string; domainName: string; count?: number }> }>(
          DOMAIN_TYPES_QUERY,
          {}
        );
        
        if (domainsResult.data?.domainTypes) {
          const configs = domainsResult.data.domainTypes.map(dt => ({
            key: dt.domainCode.toLowerCase(),
            name: dt.domainName,
            color: getDomainColor(dt.domainCode),
            count: dt.count || 0
          }));
          setDomainConfigs(configs);
        }
      } catch (error) {
        console.error('Error fetching templates or domain types:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  const filteredTemplates = templates.filter(tpl => {
    if (filterDomain !== 'all' && tpl.domain !== filterDomain) return false;
    return true;
  });

  const getDomainColor = (domainCode: string) => {
    const colors: Record<string, string> = {
      FUND: '#1b3a4b',
      ISSUER: '#6d28d9',
      SECURITY: '#c2410c',
      DEAL: '#047857',
      INVESTOR: '#be185d',
      POSITION: '#475569',
    };
    return colors[domainCode] || '#64748b';
  };

  const handleCreate = (data: any) => {
    console.log('Creating template:', data);
    setShowCreateForm(false);
  };

  const handleEdit = (data: any) => {
    console.log('Editing template:', data);
    setEditingTemplate(null);
  };

  return (
    <div className="view-fade">
      {/* Breadcrumb */}
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Template Management</span>
      </div>

      {/* Page Header */}
      <div className="page-header">
        <div>
          <div className="page-title">Template Management</div>
          <div className="page-meta">
            {loading ? 'Loading...' : `${templates.length} templates across ${domainConfigs.length} domains`} · Define entity structures
          </div>
        </div>
        <div className="page-actions">
          <Link href="/admin/templates/studio"><button className="btn btn-primary">Build from statements</button></Link>
          <button className="btn" onClick={() => setShowCreateForm(true)}>+ New Template</button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="filter-bar">
        <div className="filter-label">Filter</div>
        <select
          className="select"
          style={{ padding: '5px 30px 5px 11px', fontSize: '11px' }}
          value={filterDomain}
          onChange={(e) => setFilterDomain(e.target.value)}
          disabled={loading}
        >
          <option value="all">All Domains</option>
          {domainConfigs.map(domain => (
            <option key={domain.key} value={domain.key}>
              {domain.name}
            </option>
          ))}
        </select>
        <div className="filter-count">
          Showing <strong>{loading ? '0' : filteredTemplates.length}</strong> of {loading ? '0' : templates.length}
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div className="loader">Loading templates...</div>
        </div>
      )}

      {!loading && (
        <>
          {/* Templates Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px', marginBottom: '18px' }}>
            {filteredTemplates.map(tpl => {
              const domainConfig = domainConfigs.find(d => d.key === tpl.domain);
              return (
                <div
                  key={tpl.id}
                  className="entity-card"
                  style={{ '--card-accent': domainConfig?.color || 'var(--accent)' } as React.CSSProperties}
                  onClick={() => setEditingTemplate(tpl)}
                >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-ibm-plex-serif), serif', fontSize: '18px', fontWeight: 600, color: 'var(--ink)', marginBottom: '4px' }}>
                    {tpl.name}
                  </div>
                  <div className="mono" style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 500 }}>
                    {tpl.code}
                  </div>
                </div>
                <span style={{
                  fontSize: '10px',
                  padding: '3px 8px',
                  background: 'var(--bg)',
                  color: 'var(--ink-2)',
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  border: '1px solid var(--line)',
                }}>
                  {tpl.statementKind ? `${tpl.statementKind} · ` : ''}{tpl.domain}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--ink-3)', lineHeight: 1.5, marginBottom: '14px', minHeight: '34px' }}>
                {tpl.description}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', margin: '0 0 14px 0', fontSize: '11px' }}>
                <div>
                  <div style={{ color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.7px', fontSize: '9px', marginBottom: '3px' }}>
                    Attributes
                  </div>
                  <div className="mono" style={{ color: 'var(--ink)', fontWeight: 600 }}>
                    {tpl.attributes.length}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.7px', fontSize: '9px', marginBottom: '3px' }}>
                    Entities
                  </div>
                  <div className="mono" style={{ color: 'var(--ink)', fontWeight: 600 }}>
                    {(tpl.entityCount || 0).toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.7px', fontSize: '9px', marginBottom: '3px' }}>
                    Updated
                  </div>
                  <div style={{ color: 'var(--ink-2)', fontSize: '11px' }}>
                    {tpl.updatedAt}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setEditingTemplate(tpl); }}>Edit</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Empty State */}
      {filteredTemplates.length === 0 && !loading && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--ink-3)' }}>
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>No templates found</div>
          <div style={{ fontSize: '14px', maxWidth: '400px', margin: '0 auto' }}>
            Create your first template to define the structure for your entities
          </div>
          <div style={{ marginTop: '16px' }}>
            <button className="btn btn-primary" onClick={() => setShowCreateForm(true)}>
              + Create Template
            </button>
          </div>
        </div>
      )}

      </>
    )}

      {/* Template-Attribute Matrix */}
      <div className="section-title">
        <h2>Template-Attribute Matrix</h2>
        <span className="hint">Which attributes belong to which templates</span>
      </div>
      <TemplateMatrix templates={filteredTemplates} />

      {/* Create/Edit Modal */}
      {(showCreateForm || editingTemplate) && (
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
                  Template
                </div>
              </div>
              <button
                className="btn btn-sm"
                onClick={() => { setShowCreateForm(false); setEditingTemplate(null); }}
              >
                ✕ Close
              </button>
            </div>

            <div className="form-grid">
              <div className="field">
                <label>Template Code *</label>
                <input
                  className="text-input mono"
                  defaultValue={editingTemplate?.code || ''}
                  placeholder="TEMPLATE_CODE"
                  disabled={!!editingTemplate}
                />
              </div>
              <div className="field">
                <label>Template Name *</label>
                <input
                  className="text-input"
                  defaultValue={editingTemplate?.name || ''}
                  placeholder="Display name"
                />
              </div>
              <div className="field">
                <label>Domain *</label>
                <select className="select" defaultValue={editingTemplate?.domain || 'securities'}>
                  <option value="funds">Funds</option>
                  <option value="issuers">Issuers</option>
                  <option value="securities">Securities</option>
                  <option value="deals">Deals</option>
                  <option value="investors">Investors</option>
                  <option value="positions">Positions</option>
                </select>
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Description</label>
                <textarea
                  className="text-input"
                  defaultValue={editingTemplate?.description || ''}
                  placeholder="Brief description"
                  rows={2}
                  style={{ resize: 'vertical' }}
                />
              </div>
            </div>

            {editingTemplate && (
              <div style={{ marginTop: '18px' }}>
                <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--ink-3)', fontWeight: 600, marginBottom: '10px' }}>
                  Assigned Attributes ({editingTemplate.attributes.length})
                </div>
                <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', padding: '14px' }}>
                  {editingTemplate.attributes.map(tplAttr => (
                    <div key={tplAttr.attributeId} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '8px 10px',
                      background: 'var(--surface)',
                      border: '1px solid var(--line)',
                      marginBottom: '6px',
                    }}>
                      <span style={{
                        width: '20px',
                        height: '20px',
                        background: tplAttr.required ? 'var(--green)' : 'var(--accent-2)',
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '9px',
                        fontWeight: 700,
                      }}>
                        {tplAttr.sortOrder}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500, color: 'var(--ink)', fontSize: '12px' }}>
                          {tplAttr.attributeName}
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--ink-3)' }}>
                          <span className="mono">{tplAttr.attributeCode}</span> · {tplAttr.displaySection}
                          {tplAttr.required && <span style={{ color: 'var(--green)', marginLeft: '8px' }}>Required</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '20px' }}>
              <button className="btn" onClick={() => { setShowCreateForm(false); setEditingTemplate(null); }}>Cancel</button>
              <button className="btn btn-primary" onClick={() => {
                if (showCreateForm) handleCreate({});
                else handleEdit({});
              }}>
                {showCreateForm ? 'Create Template' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


function TemplateMatrix({ templates }: { templates: Template[] }) {
  const attrCodes = useMemo(
    () => Array.from(new Set(templates.flatMap((template) => template.attributes.map((attribute) => attribute.attributeCode)))),
    [templates],
  );
  const rows = useMemo(() => attrCodes.map((attributeCode) => ({ attributeCode })), [attrCodes]);
  const columns = useMemo<ColDef[]>(() => [
    {
      field: 'attributeCode',
      headerName: 'Attribute',
      pinned: 'left',
      minWidth: 200,
      cellClass: 'mono',
    },
    ...templates.map((template) => ({
      colId: template.id,
      headerName: template.code,
      width: 120,
      sortable: false,
      filter: false,
      cellStyle: { textAlign: 'center' as const },
      cellRenderer: (params: any) => {
        const match = template.attributes.find((attribute) => attribute.attributeCode === params.data.attributeCode);
        if (!match) return <span style={{ color: 'var(--ink-4)' }}>—</span>;
        return (
          <span style={{
            display: 'inline-block',
            width: '24px',
            height: '24px',
            background: match.required ? 'var(--green)' : 'var(--accent-2)',
            color: '#fff',
            borderRadius: '50%',
            lineHeight: '24px',
            fontSize: '10px',
            fontWeight: 600,
          }}>
            {match.required ? 'R' : '✓'}
          </span>
        );
      },
    })),
  ], [templates]);
  return (
    <AppGrid
      rows={rows}
      columns={columns}
      getRowId={(row) => row.attributeCode}
      autoHeight={rows.length < 40}
      height={rows.length < 40 ? undefined : '70vh'}
      emptyMessage="No attributes on these templates."
    />
  );
}
