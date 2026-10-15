'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';

const SAMPLE_HTML = `<div class="statement-toolbar">{{control financialType}} {{control viewGrain}} {{control statementBasis}}</div>
<table>
  <thead>
    <tr><th></th>{{#each periods}}<th>{{period.label}}</th>{{/each}}</tr>
  </thead>
  <tbody>
    <tr><td>Revenue</td>{{#each periods}}<td>{{REVENUE}}</td>{{/each}}</tr>
    <tr data-role="total"><td>Cash</td>{{#each periods}}<td>{{CASH}}</td>{{/each}}</tr>
  </tbody>
</table>
<section data-show-when="statementBasis=AUDIT"><p>Audited figures are annual.</p></section>`;

const LAYOUTS_QUERY = `
  query DisplayLayouts {
    displayLayouts { id layoutCode layoutName domainCode timeMode seriesAxis relationshipCode htmlTemplate defaultViewGrain seriesWindow isActive }
  }
`;

const UPSERT_LAYOUT = `
  mutation UpsertDisplayLayout($input: UpsertDisplayLayoutInput!) {
    upsertDisplayLayout(input: $input) { success layout { id layoutCode } errors { message } }
  }
`;

const UPSERT_BINDING = `
  mutation UpsertEntityTemplateBinding($input: UpsertEntityTemplateBindingInput!) {
    upsertEntityTemplateBinding(input: $input) { success id errors { message } }
  }
`;

interface LayoutRow {
  id: string;
  layoutCode: string;
  layoutName: string;
  domainCode: string;
  timeMode: string;
  seriesAxis: string;
  relationshipCode?: string | null;
}

export default function DisplayLayoutsPage() {
  const [layouts, setLayouts] = useState<LayoutRow[]>([]);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({
    layoutCode: '',
    layoutName: '',
    domainCode: 'ISSUER',
    ownerDomainCode: 'ISSUER',
    relationshipCode: '',
    timeMode: 'SERIES',
    seriesAxis: 'VALID_TIME',
    defaultViewGrain: 'QUARTERLY',
    seriesWindow: '8',
    htmlTemplate: SAMPLE_HTML,
  });
  const [binding, setBinding] = useState({ ownerEntityId: '', relationshipCode: '', layoutId: '' });

  const load = () => {
    graphqlQuery<{ displayLayouts: LayoutRow[] }, Record<string, never>>(LAYOUTS_QUERY, {}).then((result) => {
      setLayouts(result.data?.displayLayouts ?? []);
      if (result.error) setMessage(result.error.message);
    });
  };

  useEffect(() => { load(); }, []);

  const saveLayout = async () => {
    setMessage('');
    const result = await graphqlMutation<{ upsertDisplayLayout: { success: boolean; errors: Array<{ message: string }> } }, { input: Record<string, unknown> }>(
      UPSERT_LAYOUT,
      {
        input: {
          ...form,
          seriesWindow: Number(form.seriesWindow) || 8,
          allowedViewGrains: ['MONTHLY', 'QUARTERLY', 'ANNUAL'],
          parameters: [],
          isActive: true,
        },
      },
    );
    const error = result.error?.message || result.data?.upsertDisplayLayout?.errors?.[0]?.message;
    setMessage(error || 'Layout saved. An empty parameter list uses Monthly, LTM, and Audit.');
    load();
  };

  const saveBinding = async () => {
    setMessage('');
    const result = await graphqlMutation<{ upsertEntityTemplateBinding: { success: boolean; errors: Array<{ message: string }> } }, { input: Record<string, string> }>(
      UPSERT_BINDING,
      { input: binding },
    );
    const error = result.error?.message || result.data?.upsertEntityTemplateBinding?.errors?.[0]?.message;
    setMessage(error || 'Binding saved. The owner entity now uses this layout.');
    load();
  };

  return (
    <div className="view-fade" style={{ padding: 24 }}>
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Display layouts</span>
      </div>
      <h1 style={{ fontSize: 22, margin: '12px 0' }}>Display layouts</h1>
      <p style={{ color: 'var(--ink-3)', maxWidth: 720 }}>
        Place attribute slots in HTML. A series layout repeats each slot across fiscal period ends.
        Bind the layout to an issuer, with a relationship code, when the statement belongs to that issuer and the values live on child entities.
      </p>

      <div className="field-section" style={{ marginTop: 16 }}>
        <div className="field-section-head"><div className="field-section-name">Layouts</div></div>
        {layouts.length === 0 && <div style={{ padding: 16, color: 'var(--ink-3)' }}>No layouts yet.</div>}
        {layouts.map((layout) => (
          <div key={layout.id} style={{ padding: '10px 20px', borderTop: '1px solid var(--line)' }}>
            <strong>{layout.layoutName}</strong>
            <span style={{ color: 'var(--ink-3)' }}> · {layout.layoutCode} · {layout.domainCode} · {layout.timeMode}</span>
          </div>
        ))}
      </div>

      <div className="field-section">
        <div className="field-section-head"><div className="field-section-name">New layout</div></div>
        <div style={{ display: 'grid', gap: 10, padding: 16, maxWidth: 760 }}>
          <input className="text-input" placeholder="Layout code" value={form.layoutCode} onChange={(event) => setForm({ ...form, layoutCode: event.target.value })} />
          <input className="text-input" placeholder="Layout name" value={form.layoutName} onChange={(event) => setForm({ ...form, layoutName: event.target.value })} />
          <input className="text-input" placeholder="Domain code" value={form.domainCode} onChange={(event) => setForm({ ...form, domainCode: event.target.value })} />
          <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            Time mode
            <select className="text-input" value={form.timeMode} onChange={(event) => setForm({ ...form, timeMode: event.target.value })}>
              <option value="SERIES">Series</option>
              <option value="POINT">Point in time</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            Series axis
            <select className="text-input" value={form.seriesAxis} onChange={(event) => setForm({ ...form, seriesAxis: event.target.value })}>
              <option value="VALID_TIME">Valid time on this entity</option>
              <option value="CHILD_ENTITIES">One column per child entity</option>
            </select>
          </label>
          <input className="text-input" placeholder="Relationship code for child columns" value={form.relationshipCode} onChange={(event) => setForm({ ...form, relationshipCode: event.target.value })} />
          <textarea className="text-input" rows={14} value={form.htmlTemplate} onChange={(event) => setForm({ ...form, htmlTemplate: event.target.value })} />
          <button className="btn" type="button" onClick={saveLayout}>Save layout</button>
        </div>
      </div>

      <div className="field-section">
        <div className="field-section-head"><div className="field-section-name">Bind to an entity</div></div>
        <div style={{ display: 'grid', gap: 10, padding: 16, maxWidth: 760 }}>
          <input className="text-input" placeholder="Owner entity id" value={binding.ownerEntityId} onChange={(event) => setBinding({ ...binding, ownerEntityId: event.target.value })} />
          <input className="text-input" placeholder="Relationship code, blank for this entity" value={binding.relationshipCode} onChange={(event) => setBinding({ ...binding, relationshipCode: event.target.value })} />
          <select className="text-input" value={binding.layoutId} onChange={(event) => setBinding({ ...binding, layoutId: event.target.value })}>
            <option value="">Choose a layout</option>
            {layouts.map((layout) => <option key={layout.id} value={layout.id}>{layout.layoutName}</option>)}
          </select>
          <button className="btn" type="button" onClick={saveBinding}>Save binding</button>
        </div>
      </div>
      {message && <p style={{ color: 'var(--ink-2)' }}>{message}</p>}
    </div>
  );
}
