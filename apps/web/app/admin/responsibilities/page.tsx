'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import {
  coverageLabel,
  DELETE_RESPONSIBILITY,
  draftInput,
  draftProblem,
  emptyDraft,
  groupResponsibilities,
  holderLabel,
  RESPONSIBILITIES_QUERY,
  SAVE_RESPONSIBILITY,
  type Responsibility,
  type ResponsibilityChoices,
  type ResponsibilityDraft,
} from '@/lib/responsibilities';

/**
 * Who must act on a record or a domain. A responsibility grants no access. It
 * decides who a workflow review goes to when its step names nobody.
 */

interface EntityHit {
  id: string;
  entityName: string;
  domainCode: string;
  domainName: string;
}

interface DomainOption {
  domainCode: string;
  domainName: string;
  isActive: boolean;
}

interface MutationError {
  field: string | null;
  message: string;
  code: string;
}

const SEARCH_QUERY = `query ResponsibilityEntitySearch($query: String!) { searchEntities(query: $query, limit: 8) { id entityName domainCode domainName } }`;
const DOMAINS_QUERY = `query ResponsibilityDomains { domainTypes { domainCode domainName isActive } }`;

const NO_CHOICES: ResponsibilityChoices = { clientId: null, canManage: false, people: [], roles: [], activities: [] };

export default function ResponsibilitiesPage() {
  const [rows, setRows] = useState<Responsibility[]>([]);
  const [choices, setChoices] = useState<ResponsibilityChoices>(NO_CHOICES);
  const [domains, setDomains] = useState<DomainOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [mine, setMine] = useState(false);
  const [draft, setDraft] = useState<ResponsibilityDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<EntityHit[]>([]);

  usePublishViewContext({ activity: 'viewing', kind: 'responsibilities', label: 'Responsibilities', summary: 'Who is responsible for each record and domain' });

  const load = useCallback(async () => {
    const result = await graphqlQuery<{ responsibilities: Responsibility[]; responsibilityChoices: ResponsibilityChoices }, { mine: boolean }>(
      RESPONSIBILITIES_QUERY,
      { mine },
      'network-only',
    );
    if (result.error) setMessage(result.error.message || 'Responsibilities could not be loaded.');
    else {
      setRows(result.data?.responsibilities || []);
      setChoices(result.data?.responsibilityChoices || NO_CHOICES);
    }
    setLoading(false);
  }, [mine]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void graphqlQuery<{ domainTypes: DomainOption[] }>(DOMAINS_QUERY).then((result) => {
      setDomains((result.data?.domainTypes || []).filter((domain) => domain.isActive).sort((a, b) => a.domainName.localeCompare(b.domainName)));
    });
  }, []);

  // Record search for the form. A short wait keeps one request per pause in typing.
  useEffect(() => {
    const text = search.trim();
    if (text.length < 2) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void graphqlQuery<{ searchEntities: EntityHit[] }, { query: string }>(SEARCH_QUERY, { query: text }, 'network-only', controller.signal).then((result) => {
        if (!result.aborted) setHits(result.data?.searchEntities || []);
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [search]);

  const groups = useMemo(() => groupResponsibilities(rows), [rows]);
  const problem = draft ? draftProblem(draft) : null;

  function startDraft(patch: Partial<ResponsibilityDraft> = {}) {
    setMessage('');
    setSearch('');
    setHits([]);
    setDraft({ ...emptyDraft(), ...patch });
  }

  function patchDraft(patch: Partial<ResponsibilityDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  async function save() {
    if (!draft || problem) return;
    setSaving(true);
    setMessage('');
    const result = await graphqlMutation<{ saveResponsibility: { responsibility: Responsibility | null; errors: MutationError[] } }>(SAVE_RESPONSIBILITY, {
      input: draftInput(draft, choices.clientId),
    });
    setSaving(false);
    const errors = result.data?.saveResponsibility.errors || [];
    if (result.error || errors.length > 0) {
      setMessage(errors[0]?.message || result.error?.message || 'The responsibility could not be saved.');
      return;
    }
    setDraft(null);
    await load();
  }

  async function remove(row: Responsibility) {
    const subject = row.subjectType === 'DOMAIN' ? `every ${row.domainCode}` : row.entityName || 'this record';
    if (!window.confirm(`Remove ${holderLabel(row)} from ${subject}? Reviews already assigned stay as they are.`)) return;
    setMessage('');
    const result = await graphqlMutation<{ deleteResponsibility: { success: boolean; errors: MutationError[] } }>(DELETE_RESPONSIBILITY, { id: row.id });
    const errors = result.data?.deleteResponsibility.errors || [];
    if (result.error || errors.length > 0) setMessage(errors[0]?.message || result.error?.message || 'The responsibility could not be removed.');
    await load();
  }

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Responsibilities</span>
      </div>
      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
          <div>
            <div className="page-title">Responsibilities</div>
            <div className="page-meta">
              Who must act on a record or a domain. A workflow review that names nobody goes to the people responsible for the records it changes. The nearest
              assignment wins: the record, then the record above it, then the domain. This does not change who can see or edit anything.
            </div>
          </div>
        </div>
        {choices.canManage && (
          <button type="button" className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={() => startDraft()}>
            Assign someone
          </button>
        )}
      </div>

      {message && <div role="alert" style={{ color: 'var(--danger, #9b2c2c)', margin: '12px 0' }}>{message}</div>}

      {draft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          style={{ margin: '16px 0', padding: 16, border: '1px solid var(--line, #e5e5e5)', borderRadius: 8, display: 'grid', gap: 12, maxWidth: 760 }}
        >
          <div style={{ fontWeight: 600 }}>Assign someone</div>

          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Responsible for</span>
              <select className="text-input" value={draft.subjectType} onChange={(event) => patchDraft({ subjectType: event.target.value === 'DOMAIN' ? 'DOMAIN' : 'ENTITY' })}>
                <option value="ENTITY">One record</option>
                <option value="DOMAIN">Every record in a domain</option>
              </select>
            </label>

            {draft.subjectType === 'DOMAIN' ? (
              <label style={field}>
                <span style={fieldLabel}>Domain</span>
                <select className="text-input" value={draft.domainCode} onChange={(event) => patchDraft({ domainCode: event.target.value })}>
                  <option value="">Choose a domain</option>
                  {domains.map((domain) => (
                    <option key={domain.domainCode} value={domain.domainCode}>{domain.domainName}</option>
                  ))}
                </select>
              </label>
            ) : (
              <div style={field}>
                <label style={field}>
                  <span style={fieldLabel}>Record</span>
                  {draft.entityId ? (
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontWeight: 500 }}>{draft.entityName}</span>
                      <button type="button" className="btn" onClick={() => patchDraft({ entityId: '', entityName: '' })}>Change</button>
                    </span>
                  ) : (
                    <input className="text-input" placeholder="Search by name" value={search} onChange={(event) => setSearch(event.target.value)} />
                  )}
                </label>
                {!draft.entityId && hits.length > 0 && (
                  <div style={{ border: '1px solid var(--line, #e5e5e5)', borderRadius: 6, display: 'grid' }}>
                    {hits.map((hit) => (
                      <button
                        key={hit.id}
                        type="button"
                        className="btn"
                        style={{ textAlign: 'left', border: 'none', borderRadius: 0 }}
                        onClick={() => {
                          patchDraft({ entityId: hit.id, entityName: hit.entityName });
                          setSearch('');
                          setHits([]);
                        }}
                      >
                        {hit.entityName} <span style={hint}>· {hit.domainName}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Who</span>
              <select className="text-input" value={draft.holderKind} onChange={(event) => patchDraft({ holderKind: event.target.value === 'ROLE' ? 'ROLE' : 'PERSON' })}>
                <option value="PERSON">A person</option>
                <option value="ROLE">Anyone holding a role</option>
              </select>
            </label>
            {draft.holderKind === 'PERSON' ? (
              <label style={field}>
                <span style={fieldLabel}>Person</span>
                <select className="text-input" value={draft.userId} onChange={(event) => patchDraft({ userId: event.target.value })}>
                  <option value="">Choose a person</option>
                  {choices.people.map((person) => (
                    <option key={person.id} value={person.id}>{person.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label style={field}>
                <span style={fieldLabel}>Role</span>
                <select className="text-input" value={draft.roleCode} onChange={(event) => patchDraft({ roleCode: event.target.value })}>
                  <option value="">Choose a role</option>
                  {choices.roles.map((role) => (
                    <option key={role.code} value={role.code}>{role.name}</option>
                  ))}
                </select>
              </label>
            )}
            <label style={field}>
              <span style={fieldLabel}>For</span>
              <select className="text-input" value={draft.activityCode} onChange={(event) => patchDraft({ activityCode: event.target.value })}>
                <option value="">Every activity</option>
                {choices.activities.map((activity) => (
                  <option key={activity.code} value={activity.code}>{activity.name}</option>
                ))}
              </select>
            </label>
          </div>

          {draft.subjectType === 'ENTITY' && (
            <label style={check}>
              <input type="checkbox" checked={draft.includeChildren} onChange={(event) => patchDraft({ includeChildren: event.target.checked })} />
              <span>Also the records under it, such as a fund&rsquo;s positions.</span>
            </label>
          )}
          <label style={check}>
            <input type="checkbox" checked={draft.isBackup} onChange={(event) => patchDraft({ isBackup: event.target.checked })} />
            <span>A backup. Asked only when nobody else named here can act.</span>
          </label>
          <label style={field}>
            <span style={fieldLabel}>Note</span>
            <input className="text-input" value={draft.note} onChange={(event) => patchDraft({ note: event.target.value })} />
          </label>

          {problem && <div style={hint}>{problem}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={saving || Boolean(problem)}>{saving ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
          </div>
        </form>
      )}

      <label style={{ ...check, margin: '16px 0 8px' }}>
        <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />
        <span>Only mine</span>
      </label>

      {loading && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Loading responsibilities…</div>}
      {!loading && groups.length === 0 && (
        <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>
          {mine
            ? 'Nothing is assigned to you.'
            : 'Nobody is assigned yet. Until someone is, a review that names nobody is open to anyone who holds the review permission.'}
        </div>
      )}

      {groups.length > 0 && (
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={cell}>Responsible for</th>
              <th style={cell}>Who</th>
              <th style={cell}>Covers</th>
              <th style={cell}>Note</th>
              <th style={cell} />
            </tr>
          </thead>
          <tbody>
            {groups.map((group) =>
              group.rows.map((row, index) => (
                <tr key={row.id} style={index === 0 ? bodyRow : undefined}>
                  <td style={{ ...cell, fontWeight: 500 }}>
                    {index === 0 && (
                      <>
                        {group.title}
                        {group.detail && <div style={hint}>{group.detail}</div>}
                      </>
                    )}
                  </td>
                  <td style={cell}>
                    {holderLabel(row)}
                    {row.isBackup && <span style={hint}> · backup</span>}
                    {row.isMine && <span style={hint}> · you</span>}
                  </td>
                  <td style={cell}>{coverageLabel(row)}</td>
                  <td style={{ ...cell, color: 'var(--ink-3)' }}>{row.note || ''}</td>
                  <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {row.canManage && (
                      <>
                        {index === 0 && (
                          <>
                            <button
                              type="button"
                              className="btn"
                              onClick={() =>
                                startDraft(
                                  group.subjectType === 'DOMAIN'
                                    ? { subjectType: 'DOMAIN', domainCode: group.domainCode || '' }
                                    : { subjectType: 'ENTITY', entityId: group.entityId || '', entityName: group.title },
                                )
                              }
                            >
                              Add another
                            </button>{' '}
                          </>
                        )}
                        <button type="button" className="btn" onClick={() => remove(row)}>Remove</button>
                      </>
                    )}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

const cell: React.CSSProperties = { padding: '8px 8px', verticalAlign: 'top' };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const headRow: React.CSSProperties = { textAlign: 'left', color: 'var(--ink-3)', fontSize: 11, textTransform: 'uppercase' };
const bodyRow: React.CSSProperties = { borderTop: '1px solid var(--line, #e5e5e5)' };
const hint: React.CSSProperties = { color: 'var(--ink-3)', fontSize: 12 };
const formRow: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 };
const field: React.CSSProperties = { display: 'grid', gap: 4 };
const fieldLabel: React.CSSProperties = { fontSize: 12, color: 'var(--ink-2)' };
const check: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 };
