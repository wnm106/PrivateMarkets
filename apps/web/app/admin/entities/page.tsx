'use client';

import { useMemo, useState, useEffect } from 'react';
import Link from 'next/link';
import {
  graphqlClient,
  DOMAIN_CATALOG_QUERY,
  CREATE_DOMAIN_TYPE_MUTATION,
} from '@/lib/graphql';
import { SchemaScopeBadge, SchemaScopeField } from '@/components/admin/SchemaScopeField';
import { GroupField } from '@/components/admin/GroupField';

interface DomainGroup {
  id: string;
  groupCode: string;
  groupName: string;
  description?: string | null;
  color: string;
  displayOrder: number;
}

interface DomainType {
  id: string;
  domainCode: string;
  domainName: string;
  description?: string | null;
  isActive: boolean;
  clientId?: string | null;
  clientName?: string | null;
  isCore: boolean;
  displayOrder: number;
  parentDomainCode?: string | null;
  ownedAttributeCount: number;
  sharedAttributeCount: number;
  templateCount: number;
  group?: DomainGroup | null;
}

const UNGROUPED: DomainGroup = {
  id: 'ungrouped',
  groupCode: 'UNGROUPED',
  groupName: 'Other',
  description: 'Entity types that are not in a catalog group yet',
  color: '#6b7280',
  displayOrder: 9999,
};

export default function EntityManagementPage() {
  const [domainTypes, setDomainTypes] = useState<DomainType[]>([]);
  const [groups, setGroups] = useState<DomainGroup[]>([]);
  const [showCreateDomainModal, setShowCreateDomainModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [coreOnly, setCoreOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const result = await graphqlClient.query(DOMAIN_CATALOG_QUERY, {}, { requestPolicy: 'network-only' }).toPromise();
      setDomainTypes(result.data?.domainTypes || []);
      setGroups(result.data?.domainGroups || []);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDomain = async (data: any) => {
    try {
      const result = await graphqlClient.mutation(CREATE_DOMAIN_TYPE_MUTATION, { input: data }).toPromise();
      const errors = result.data?.createDomainType?.errors;
      if (errors && errors.length > 0) {
        window.alert(errors[0].message);
        return;
      }
      if (result.error) {
        window.alert(result.error.message);
        return;
      }
      setShowCreateDomainModal(false);
      loadData();
    } catch (error) {
      console.error('Error creating domain:', error);
    }
  };

  const needle = query.trim().toLowerCase();
  const byCode = useMemo(() => new Map(domainTypes.map((domain) => [domain.domainCode, domain])), [domainTypes]);

  const visibleCodes = useMemo(() => {
    const matches = (domain: DomainType) => {
      if (coreOnly && !domain.isCore) return false;
      if (!needle) return true;
      return `${domain.domainName} ${domain.domainCode} ${domain.description || ''}`.toLowerCase().includes(needle);
    };
    const shown = new Set(domainTypes.filter(matches).map((domain) => domain.domainCode));
    if (needle) {
      for (const code of [...shown]) {
        let parent = byCode.get(code)?.parentDomainCode;
        const guard = new Set<string>();
        while (parent && !guard.has(parent)) {
          const row = byCode.get(parent);
          if (!row || (coreOnly && !row.isCore)) break;
          guard.add(parent);
          shown.add(parent);
          parent = row.parentDomainCode;
        }
      }
    }
    return shown;
  }, [byCode, coreOnly, domainTypes, needle]);

  const bands = useMemo(() => {
    const ordered = [...groups].sort((a, b) => a.displayOrder - b.displayOrder);
    const known = new Set(ordered.map((group) => group.groupCode));
    const extras = domainTypes.some((domain) => !domain.group || !known.has(domain.group.groupCode));
    const list = extras ? [...ordered, UNGROUPED] : ordered;
    return list
      .map((group) => {
        const members = domainTypes.filter((domain) => {
          if (!visibleCodes.has(domain.domainCode)) return false;
          const code = domain.group?.groupCode;
          return group.groupCode === 'UNGROUPED' ? !code || !known.has(code) : code === group.groupCode;
        });
        return { group, members };
      })
      .filter((band) => band.members.length > 0);
  }, [domainTypes, groups, visibleCodes]);

  const visibleCount = domainTypes.filter((domain) => visibleCodes.has(domain.domainCode)).length;
  const allCollapsed = bands.length > 0 && bands.every((band) => collapsed.has(band.group.groupCode));

  const toggleAll = () => {
    setCollapsed(allCollapsed ? new Set() : new Set(bands.map((band) => band.group.groupCode)));
  };

  const toggleGroup = (code: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
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

      <div className="et-tools">
        <input
          className="text-input et-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, code or description"
          aria-label="Search entity types"
        />
        <button
          type="button"
          className="btn et-toggle"
          aria-pressed={coreOnly}
          onClick={() => setCoreOnly((current) => !current)}
        >
          Core entities only
        </button>
        <button type="button" className="btn" onClick={toggleAll} disabled={bands.length === 0}>
          {allCollapsed ? 'Expand all' : 'Collapse all'}
        </button>
        <span className="et-shown">
          {visibleCount} of {domainTypes.length} entity types
        </span>
      </div>

      {bands.map(({ group, members }) => {
        const open = !collapsed.has(group.groupCode);
        const roots = members
          .filter((domain) => {
            const parent = domain.parentDomainCode ? byCode.get(domain.parentDomainCode) : undefined;
            return !parent || !visibleCodes.has(parent.domainCode) || parent.group?.groupCode !== domain.group?.groupCode;
          })
          .sort((a, b) => a.displayOrder - b.displayOrder || a.domainName.localeCompare(b.domainName));
        return (
          <section className="et-group" key={group.groupCode}>
            <button
              type="button"
              className="et-group-head"
              aria-expanded={open}
              onClick={() => toggleGroup(group.groupCode)}
            >
              <Chevron open={open} />
              <span className="et-dot" style={{ background: group.color }} />
              <span className="et-group-name">{group.groupName}</span>
              <span className="et-group-count">{members.length} entity {members.length === 1 ? 'type' : 'types'}</span>
              {group.description && <span className="et-group-desc">{group.description}</span>}
            </button>
            {open && roots.map((domain) => (
              <DomainBranch
                key={domain.domainCode}
                domain={domain}
                members={members}
                depth={0}
              />
            ))}
          </section>
        );
      })}

      {domainTypes.length === 0 && (
        <div className="alert alert-info">
          No entity types defined yet. Click &quot;+ Entity Type&quot; to create your first entity type (e.g., Fund, Security, Borrower).
        </div>
      )}

      {domainTypes.length > 0 && bands.length === 0 && (
        <div className="alert alert-info">No entity types match this search.</div>
      )}

      {showCreateDomainModal && (
        <CreateDomainModal
          groups={groups}
          domains={domainTypes}
          onClose={() => setShowCreateDomainModal(false)}
          onSubmit={handleCreateDomain}
          onGroupCreated={(group) => setGroups((current) =>
            [...current.filter((item) => item.groupCode !== group.groupCode), group]
              .sort((a, b) => a.displayOrder - b.displayOrder)
          )}
        />
      )}
    </div>
  );
}

function DomainBranch({
  domain,
  members,
  depth,
}: {
  domain: DomainType;
  members: DomainType[];
  depth: number;
}) {
  const children = members
    .filter((item) => item.parentDomainCode === domain.domainCode)
    .sort((a, b) => a.displayOrder - b.displayOrder || a.domainName.localeCompare(b.domainName));
  return (
    <>
      <DomainRow domain={domain} depth={depth} />
      {children.map((child) => (
        <DomainBranch key={child.domainCode} domain={child} members={members} depth={depth + 1} />
      ))}
    </>
  );
}

function DomainRow({ domain, depth }: { domain: DomainType; depth: number }) {
  const color = domain.group?.color || '#6b7280';
  const letter = (domain.domainName.trim()[0] || domain.domainCode[0] || '?').toUpperCase();
  const templates = domain.templateCount;
  return (
    <Link
      href={`/admin/entities/${domain.domainCode}`}
      className="et-row"
      style={{ paddingLeft: 16 + depth * 28 }}
    >
      <span className="et-id">
        <span className="et-mark" style={{ background: color }}>{letter}</span>
        <span>
          <span className="et-name">{domain.domainName}</span>
          <span className="et-code">
            <span className="mono">{domain.domainCode}</span>
            {domain.clientId && (
              <SchemaScopeBadge clientId={domain.clientId} clientName={domain.clientName} />
            )}
          </span>
        </span>
      </span>
      <span className="et-desc">{domain.description}</span>
      <span className="et-attrs">
        {domain.ownedAttributeCount} own + {domain.sharedAttributeCount} global
      </span>
      {templates > 0 ? (
        <span className="et-templates">{templates} {templates === 1 ? 'template' : 'templates'}</span>
      ) : (
        <span className="et-templates"><span className="et-none">No templates</span></span>
      )}
    </Link>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`et-chevron ${open ? 'open' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function CreateDomainModal({
  groups,
  domains,
  onClose,
  onSubmit,
  onGroupCreated,
}: {
  groups: DomainGroup[];
  domains: DomainType[];
  onClose: () => void;
  onSubmit: (data: any) => void;
  onGroupCreated: (group: DomainGroup) => void;
}) {
  const [formData, setFormData] = useState({
    domainCode: '',
    domainName: '',
    description: '',
    clientId: null as string | null,
    groupCode: groups[0]?.groupCode || '',
    parentDomainCode: '',
    isCore: false,
  });

  const parents = domains.filter((domain) => domain.group?.groupCode === formData.groupCode);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      domainCode: formData.domainCode,
      domainName: formData.domainName,
      description: formData.description,
      clientId: formData.clientId,
      groupCode: formData.groupCode || null,
      parentDomainCode: formData.parentDomainCode || null,
      isCore: formData.isCore,
    });
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
              <GroupField
                groups={groups}
                value={formData.groupCode}
                required
                onChange={(groupCode) => setFormData((prev) => ({
                  ...prev,
                  groupCode,
                  parentDomainCode: '',
                }))}
                onCreated={onGroupCreated}
              />
              <div className="field">
                <label>Show under</label>
                <select
                  className="text-input"
                  value={formData.parentDomainCode}
                  onChange={(event) => setFormData((prev) => ({ ...prev, parentDomainCode: event.target.value }))}
                >
                  <option value="">Top of the group</option>
                  {parents.map((domain) => (
                    <option key={domain.domainCode} value={domain.domainCode}>{domain.domainName}</option>
                  ))}
                </select>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={formData.isCore}
                  onChange={(event) => setFormData((prev) => ({ ...prev, isCore: event.target.checked }))}
                />
                Core entity
              </label>
              <SchemaScopeField
                value={formData.clientId}
                onChange={(clientId) => setFormData(prev => ({ ...prev, clientId }))}
              />
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
