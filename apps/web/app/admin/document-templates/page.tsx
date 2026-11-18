'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import {
  DOCUMENT_FIELDS, TEMPLATE_FIELDS, TYPE_FIELDS, bodyRow, cell, danger, field, fieldLabel, formBox, formRow, headRow, hint, mono,
  sectionHead, sectionTitle, shortDate, splitList, table,
  type DocumentRow, type DocumentTypeRow, type TemplateRow, type TemplateSection, type TemplateTopic,
} from '@/components/documents/shared';

const PAGE_QUERY = `query { documentTypes { ${TYPE_FIELDS} } }`;
const TYPE_QUERY = `
  query($typeId: ID) {
    documentTemplates(typeId: $typeId) { ${TEMPLATE_FIELDS} }
    documents(typeId: $typeId, first: 200) { ${DOCUMENT_FIELDS} }
  }
`;
const SAVE_TYPE = `mutation($input: SaveDocumentTypeInput!) { saveDocumentType(input: $input) { type { id } errors { message } } }`;
const TEMPLATE_RESULT = `template { ${TEMPLATE_FIELDS} } errors { message }`;
const SAVE_TEMPLATE = `mutation($input: SaveDocumentTemplateInput!) { saveDocumentTemplate(input: $input) { ${TEMPLATE_RESULT} } }`;
const GENERATE_TEMPLATE = `mutation($typeId: ID!, $documentIds: [ID!]!, $baseTemplateId: ID) { generateDocumentTemplate(typeId: $typeId, documentIds: $documentIds, baseTemplateId: $baseTemplateId) { ${TEMPLATE_RESULT} } }`;
const PUBLISH_TEMPLATE = `mutation($id: ID!) { publishDocumentTemplate(id: $id) { template { ${TEMPLATE_FIELDS} } tagged failed routes errors { message } } }`;
const DELETE_TEMPLATE = `mutation($id: ID!) { deleteDocumentTemplate(id: $id) { success errors { message } } }`;

type TemplateResult = { template: TemplateRow | null; errors: Array<{ message: string }> };

const STATUS_TEXT: Record<TemplateRow['status'], string> = { DRAFT: 'Draft', PUBLISHED: 'Published', RETIRED: 'Replaced' };

function codeFrom(title: string, taken: Set<string>): string {
  const base = title.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'SECTION';
  let code = base;
  for (let n = 2; taken.has(code); n += 1) code = `${base}_${n}`;
  return code;
}

/** Only the fields the API takes. What was read from it carries a type name that it does not take back. */
function sectionInput(section: TemplateSection) {
  const { code, title, parentCode, aliases, tags, guidance, required, order, seenIn } = section;
  return { code, title, parentCode: parentCode || null, aliases, tags, guidance, required, order, seenIn };
}

function topicInput(topic: TemplateTopic) {
  return { code: topic.code, title: topic.title, description: topic.description };
}

/** Top sections in order, each followed by its children, renumbered. */
function arrange(sections: TemplateSection[]): TemplateSection[] {
  const out: TemplateSection[] = [];
  const tops = sections.filter((section) => !section.parentCode);
  for (const top of tops) {
    out.push(top);
    out.push(...sections.filter((section) => section.parentCode === top.code));
  }
  return out.map((section, index) => ({ ...section, order: index + 1 }));
}

export default function DocumentTemplatesPage() {
  const [types, setTypes] = useState<DocumentTypeRow[]>([]);
  const [typeId, setTypeId] = useState('');
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [sections, setSections] = useState<TemplateSection[]>([]);
  const [dirty, setDirty] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [topics, setTopics] = useState<TemplateTopic[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [typeDraft, setTypeDraft] = useState<{ typeName: string; description: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');

  usePublishViewContext({ activity: 'viewing', kind: 'document-templates', label: 'Document templates', summary: 'Document types and the sections each is expected to have' });

  const loadTypes = useCallback(async () => {
    const response = await graphqlQuery<{ documentTypes: DocumentTypeRow[] }, Record<string, never>>(PAGE_QUERY, {}, 'network-only');
    if (response.aborted) return;
    if (response.error) setMessage(response.error.message);
    else if (response.data) {
      setTypes(response.data.documentTypes);
      setTypeId((current) => current || response.data!.documentTypes.find((type) => type.documentCount > 0)?.id || response.data!.documentTypes[0]?.id || '');
    }
    setLoading(false);
  }, []);

  const loadType = useCallback(async (keep?: string) => {
    if (!typeId) return;
    const response = await graphqlQuery<{ documentTemplates: TemplateRow[]; documents: DocumentRow[] }, { typeId: string }>(TYPE_QUERY, { typeId }, 'network-only');
    if (response.aborted) return;
    if (response.error) {
      setMessage(response.error.message);
      return;
    }
    const rows = response.data?.documentTemplates || [];
    setTemplates(rows);
    setDocuments(response.data?.documents || []);
    // Open the draft if there is one, else what is published.
    const chosen = rows.find((row) => row.id === keep) || rows.find((row) => row.status === 'DRAFT') || rows.find((row) => row.status === 'PUBLISHED') || rows[0];
    setTemplateId(chosen?.id || '');
    setSections(chosen ? arrange(chosen.sections) : []);
    setTopics(chosen ? chosen.topics : []);
    setDirty(false);
    setOpen(null);
  }, [typeId]);

  useEffect(() => {
    loadTypes();
  }, [loadTypes]);

  useEffect(() => {
    setPicked([]);
    loadType();
  }, [loadType]);

  const template = templates.find((row) => row.id === templateId) || null;
  const editable = template?.status === 'DRAFT';
  const type = types.find((row) => row.id === typeId) || null;
  const readDocuments = useMemo(() => documents.filter((document) => document.chunkCount > 0), [documents]);
  const sourceCount = template ? Math.max(template.sourceDocumentIds.length, 1) : 1;

  const choose = (row: TemplateRow) => {
    if (dirty && !window.confirm('Leave this draft without saving your changes?')) return;
    setTemplateId(row.id);
    setSections(arrange(row.sections));
    setTopics(row.topics);
    setDirty(false);
    setOpen(null);
  };

  const change = (code: string, patch: Partial<TemplateSection>) => {
    setSections((current) => current.map((section) => (section.code === code ? { ...section, ...patch } : section)));
    setDirty(true);
  };

  const move = (code: string, by: -1 | 1) => {
    setSections((current) => {
      const section = current.find((row) => row.code === code)!;
      const siblings = current.filter((row) => (row.parentCode || null) === (section.parentCode || null));
      const at = siblings.findIndex((row) => row.code === code);
      const other = siblings[at + by];
      if (!other) return current;
      const swapped = current.map((row) => (row.code === code ? other : row.code === other.code ? section : row));
      return arrange(swapped);
    });
    setDirty(true);
  };

  const remove = (code: string) => {
    setSections((current) => arrange(current.filter((section) => section.code !== code && section.parentCode !== code)));
    setDirty(true);
  };

  // Folds one section into another: its title and other wordings become wordings of the target.
  const merge = (code: string, into: string) => {
    setSections((current) => {
      const from = current.find((section) => section.code === code)!;
      return arrange(current
        .filter((section) => section.code !== code)
        .map((section) => {
          if (section.parentCode === code) return { ...section, parentCode: into };
          if (section.code !== into) return section;
          const aliases = [...new Set([...section.aliases, from.title, ...from.aliases])].filter((alias) => alias !== section.title);
          return { ...section, aliases, tags: [...new Set([...section.tags, ...from.tags])], seenIn: Math.max(section.seenIn, from.seenIn) };
        }));
    });
    setDirty(true);
  };

  const add = (parentCode: string | null) => {
    const title = window.prompt(parentCode ? 'Name of the section to add under this one' : 'Name of the section to add');
    if (!title || !title.trim()) return;
    setSections((current) => {
      const code = codeFrom(title, new Set(current.map((section) => section.code)));
      return arrange([...current, { code, title: title.trim(), parentCode, aliases: [], tags: [], guidance: '', required: false, order: current.length + 1, seenIn: 0 }]);
    });
    setDirty(true);
  };

  const finish = (result: TemplateResult | undefined, error: any, done: string): TemplateRow | null => {
    const problem = error?.message || result?.errors[0]?.message;
    setMessage(problem || '');
    setNotice(problem ? '' : done);
    return problem ? null : result?.template || null;
  };

  const save = async (): Promise<boolean> => {
    if (!template) return false;
    setWorking(true);
    const { data, error } = await graphqlMutation<{ saveDocumentTemplate: TemplateResult }>(SAVE_TEMPLATE, {
      input: { id: template.id, sections: sections.map(sectionInput), topics: topics.filter((topic) => topic.title.trim()).map(topicInput), notes: template.notes },
    });
    setWorking(false);
    const saved = finish(data?.saveDocumentTemplate, error, 'Draft saved.');
    if (saved) await loadType(saved.id);
    return Boolean(saved);
  };

  const generate = async (baseTemplateId: string | null) => {
    if (picked.length === 0) return setMessage('Tick the documents to draw sections from.');
    if (dirty && !(await save())) return;
    setWorking(true);
    const { data, error } = await graphqlMutation<{ generateDocumentTemplate: TemplateResult }>(GENERATE_TEMPLATE, { typeId, documentIds: picked, baseTemplateId });
    setWorking(false);
    const made = finish(data?.generateDocumentTemplate, error, baseTemplateId ? 'Sections the draft lacked were added.' : 'A draft was drawn from the documents. Refine it, then publish.');
    if (made) {
      setPicked([]);
      await loadType(made.id);
    }
  };

  const draftFromPublished = async () => {
    if (!template) return;
    setWorking(true);
    const { data, error } = await graphqlMutation<{ saveDocumentTemplate: TemplateResult }>(SAVE_TEMPLATE, {
      input: { typeId, sections: template.sections.map(sectionInput), topics: template.topics.map(topicInput), notes: template.notes, sourceDocumentIds: template.sourceDocumentIds },
    });
    setWorking(false);
    const made = finish(data?.saveDocumentTemplate, error, 'A new draft was started from the published template.');
    if (made) await loadType(made.id);
  };

  const publish = async () => {
    if (!template) return;
    if (dirty && !(await save())) return;
    if (!window.confirm('Publish this template? Every document of this type is tagged against it. Sections chosen by hand are kept where they still exist.')) return;
    setWorking(true);
    const { data, error } = await graphqlMutation<{ publishDocumentTemplate: TemplateResult & { tagged: number; failed: number } }>(PUBLISH_TEMPLATE, { id: template.id });
    setWorking(false);
    const result = data?.publishDocumentTemplate;
    const published = finish(result, error, result ? `Published. ${result.tagged} documents tagged${result.failed ? `, ${result.failed} could not be` : ''}.` : '');
    if (published) {
      await loadType(published.id);
      loadTypes();
    }
  };

  const discard = async () => {
    if (!template || !window.confirm('Delete this draft?')) return;
    const { data, error } = await graphqlMutation<{ deleteDocumentTemplate: { errors: Array<{ message: string }> } }>(DELETE_TEMPLATE, { id: template.id });
    const problem = error?.message || data?.deleteDocumentTemplate.errors[0]?.message;
    setMessage(problem || '');
    if (!problem) {
      setNotice('Draft deleted.');
      loadType();
    }
  };

  const saveType = async () => {
    if (!typeDraft) return;
    const { data, error } = await graphqlMutation<{ saveDocumentType: { type: { id: string } | null; errors: Array<{ message: string }> } }>(SAVE_TYPE, {
      input: { typeName: typeDraft.typeName, description: typeDraft.description || null },
    });
    const problem = error?.message || data?.saveDocumentType.errors[0]?.message;
    setMessage(problem || '');
    if (!problem) {
      setTypeDraft(null);
      await loadTypes();
      if (data?.saveDocumentType.type) setTypeId(data.saveDocumentType.type.id);
    }
  };

  const draft = templates.find((row) => row.status === 'DRAFT') || null;
  const tops = sections.filter((section) => !section.parentCode);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/documents" className="crumb-link">Documents</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Types and templates</span>
      </div>
      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
          <div>
            <div className="page-title">Document types and templates</div>
            <div className="page-meta">
              A template lists the sections a kind of document is expected to have. Draw one from documents you have added, refine it, and publish it. Every document of that type is then tagged section by section.
            </div>
          </div>
        </div>
      </div>

      {message && <div role="alert" style={{ ...danger, margin: '12px 0' }}>{message}</div>}
      {notice && <div role="status" style={{ color: 'var(--ink-2)', margin: '12px 0' }}>{notice}</div>}
      {loading && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Loading…</div>}

      <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap', margin: '16px 0' }}>
        <label style={{ ...field, minWidth: 280 }}>
          <span style={fieldLabel}>Document type</span>
          <select className="text-input" value={typeId}
            onChange={(event) => {
              if (dirty && !window.confirm('Leave this draft without saving your changes?')) return;
              setTypeId(event.target.value);
            }}>
            {types.map((row) => (
              <option key={row.id} value={row.id}>
                {row.typeName} ({row.documentCount} {row.documentCount === 1 ? 'document' : 'documents'}{row.publishedTemplateVersion ? `, template v${row.publishedTemplateVersion}` : ''})
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn" onClick={() => setTypeDraft({ typeName: '', description: '' })}>New type</button>
      </div>
      {type?.description && <div style={hint}>{type.description}</div>}

      {typeDraft && (
        <form onSubmit={(event) => { event.preventDefault(); saveType(); }} style={formBox}>
          <div style={{ fontWeight: 600 }}>New document type</div>
          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Name</span>
              <input className="text-input" autoFocus value={typeDraft.typeName} placeholder="Intercreditor agreement"
                onChange={(event) => setTypeDraft({ ...typeDraft, typeName: event.target.value })} />
            </label>
            <label style={field}>
              <span style={fieldLabel}>What it is (optional)</span>
              <input className="text-input" value={typeDraft.description} onChange={(event) => setTypeDraft({ ...typeDraft, description: event.target.value })} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary">Add type</button>
            <button type="button" className="btn" onClick={() => setTypeDraft(null)}>Cancel</button>
          </div>
        </form>
      )}

      <div style={sectionHead}>
        <h2 style={sectionTitle}>Documents of this type</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {draft
            ? <button type="button" className="btn" disabled={working || picked.length === 0} onClick={() => generate(draft.id)}>Add their sections to the draft</button>
            : <button type="button" className="btn btn-primary" disabled={working || picked.length === 0} onClick={() => generate(null)}>Draw a template from the ticked documents</button>}
        </div>
      </div>
      {readDocuments.length === 0 ? (
        <div style={hint}>
          No document of this type has been read yet. <Link href="/documents" className="crumb-link">Add one</Link>, then draw a template from it. You can also start an empty draft and write the sections yourself.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          {readDocuments.map((document) => (
            <label key={document.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={picked.includes(document.id)}
                onChange={(event) => setPicked(event.target.checked ? [...picked, document.id] : picked.filter((id) => id !== document.id))} />
              <Link href={`/documents/${document.id}`} className="crumb-link">{document.title}</Link>
              <span style={hint}>
                {document.templateVersion ? `tagged with v${document.templateVersion}` : 'not tagged'}
                {template?.sourceDocumentIds.includes(document.id) ? ' · a source of the open template' : ''}
              </span>
            </label>
          ))}
        </div>
      )}

      <div style={sectionHead}>
        <h2 style={sectionTitle}>Template</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {templates.map((row) => (
            <button key={row.id} type="button" className="btn btn-sm" aria-pressed={row.id === templateId} onClick={() => choose(row)}
              style={row.id === templateId ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}>
              v{row.version} · {STATUS_TEXT[row.status]}
            </button>
          ))}
          {!draft && templates.length === 0 && (
            <button type="button" className="btn btn-sm" disabled={working} onClick={async () => {
              setWorking(true);
              const { data, error } = await graphqlMutation<{ saveDocumentTemplate: TemplateResult }>(SAVE_TEMPLATE, { input: { typeId, sections: [] } });
              setWorking(false);
              const made = finish(data?.saveDocumentTemplate, error, 'An empty draft was started.');
              if (made) await loadType(made.id);
            }}>Start an empty draft</button>
          )}
        </div>
      </div>

      {template && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={hint}>
              Version {template.version}, {STATUS_TEXT[template.status].toLowerCase()}
              {template.publishedAt ? ` ${shortDate(template.publishedAt)}` : ''}. {sections.length} sections, drawn from {template.sourceDocumentIds.length} {template.sourceDocumentIds.length === 1 ? 'document' : 'documents'}.
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {editable && <button type="button" className="btn" onClick={() => add(null)}>Add a section</button>}
              {editable && <button type="button" className="btn" disabled={working || !dirty} onClick={save}>Save draft</button>}
              {editable && <button type="button" className="btn btn-primary" disabled={working || sections.length === 0} onClick={publish}>Publish</button>}
              {editable && <button type="button" className="btn" disabled={working} onClick={discard}>Delete draft</button>}
              {template.status === 'PUBLISHED' && !draft && <button type="button" className="btn" disabled={working} onClick={draftFromPublished}>Start a new draft from this</button>}
            </span>
          </div>
          {!editable && <div style={{ ...hint, marginBottom: 8 }}>A published template is not changed. Start a new draft to refine it; documents keep this version until the draft is published.</div>}

          <div style={{ margin: '4px 0 18px', maxWidth: 980 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>Topics</span>
              <span style={hint}>
                The subjects these documents cover, wherever they appear. Tables and lists are filed under them, and a search question is matched to the closest one, so say plainly what belongs under each.
              </span>
            </div>
            {topics.length === 0 && <div style={hint}>No topics yet.</div>}
            <div style={{ display: 'grid', gap: 6 }}>
              {topics.map((topic, index) => (
                <div key={topic.code || `new-${index}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 240px) minmax(0, 1fr) auto', gap: 8, alignItems: 'center' }}>
                  {editable
                    ? <input className="text-input" value={topic.title} aria-label="Topic name" placeholder="Lenders"
                        onChange={(event) => { setTopics(topics.map((other, at) => (at === index ? { ...other, title: event.target.value } : other))); setDirty(true); }} />
                    : <span style={{ fontWeight: 500, fontSize: 13 }}>{topic.title}</span>}
                  {editable
                    ? <input className="text-input" value={topic.description} aria-label={`What belongs under ${topic.title || 'this topic'}`} placeholder="Who the lenders are and how much each has committed."
                        onChange={(event) => { setTopics(topics.map((other, at) => (at === index ? { ...other, description: event.target.value } : other))); setDirty(true); }} />
                    : <span style={{ fontSize: 13 }}>{topic.description || <span style={hint}>No description</span>}</span>}
                  {editable
                    ? <button type="button" className="btn btn-sm" onClick={() => { setTopics(topics.filter((_, at) => at !== index)); setDirty(true); }}>Remove</button>
                    : <span />}
                </div>
              ))}
            </div>
            {editable && (
              <button type="button" className="btn btn-sm" style={{ marginTop: 8 }}
                onClick={() => { setTopics([...topics, { code: '', title: '', description: '' }]); setDirty(true); }}>
                Add a topic
              </button>
            )}
          </div>

          {sections.length === 0 && <div style={hint}>This draft has no sections. Add one, or tick documents above and add their sections.</div>}
          {sections.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={table}>
                <thead>
                  <tr style={headRow}>
                    <th style={cell}>Section</th>
                    <th style={cell}>Other wordings that mean it</th>
                    <th style={cell}>Tags on its passages</th>
                    <th style={cell}>Expected</th>
                    <th style={cell}>Seen in</th>
                    <th style={cell} />
                  </tr>
                </thead>
                <tbody>
                  {sections.map((section) => {
                    const child = Boolean(section.parentCode);
                    const targets = sections.filter((other) => other.code !== section.code && Boolean(other.parentCode) === child);
                    return (
                      <FragmentRow key={section.code}>
                        <tr style={bodyRow}>
                          <td style={{ ...cell, paddingLeft: child ? 28 : 8, minWidth: 260 }}>
                            {editable
                              ? <input className="text-input" style={{ fontWeight: child ? 400 : 600 }} value={section.title} aria-label="Section title"
                                  onChange={(event) => change(section.code, { title: event.target.value })} />
                              : <span style={{ fontWeight: child ? 400 : 600 }}>{section.title}</span>}
                            <div style={{ ...hint, ...mono, fontSize: 11 }}>{section.code}</div>
                          </td>
                          <td style={{ ...cell, minWidth: 220 }}>
                            {editable
                              ? <input className="text-input" value={section.aliases.join(', ')} aria-label={`Other wordings for ${section.title}`} placeholder="Separated by commas"
                                  onChange={(event) => change(section.code, { aliases: splitList(event.target.value) })} />
                              : section.aliases.join(', ') || <span style={hint}>None</span>}
                          </td>
                          <td style={{ ...cell, minWidth: 160 }}>
                            {editable
                              ? <input className="text-input" value={section.tags.join(', ')} aria-label={`Tags for ${section.title}`} placeholder="covenant, leverage"
                                  onChange={(event) => change(section.code, { tags: splitList(event.target.value).map((tag) => tag.toLowerCase()) })} />
                              : section.tags.join(', ') || <span style={hint}>None</span>}
                          </td>
                          <td style={cell}>
                            <input type="checkbox" checked={section.required} disabled={!editable} aria-label={`${section.title} is expected in every document`}
                              onChange={(event) => change(section.code, { required: event.target.checked })} />
                          </td>
                          <td style={{ ...cell, whiteSpace: 'nowrap' }}>{section.seenIn > 0 ? `${section.seenIn} of ${Math.max(sourceCount, section.seenIn)}` : <span style={hint}>Added by hand</span>}</td>
                          <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
                            <button type="button" className="btn btn-sm" onClick={() => setOpen(open === section.code ? null : section.code)}>{open === section.code ? 'Less' : 'More'}</button>
                          </td>
                        </tr>
                        {open === section.code && (
                          <tr>
                            <td colSpan={6} style={{ ...cell, paddingLeft: child ? 28 : 8, paddingBottom: 14 }}>
                              <label style={{ ...field, maxWidth: 720 }}>
                                <span style={fieldLabel}>What belongs in this section, for someone tagging by hand</span>
                                <textarea className="text-input" rows={2} value={section.guidance} disabled={!editable}
                                  onChange={(event) => change(section.code, { guidance: event.target.value })} />
                              </label>
                              {editable && (
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
                                  <button type="button" className="btn btn-sm" onClick={() => move(section.code, -1)}>Move up</button>
                                  <button type="button" className="btn btn-sm" onClick={() => move(section.code, 1)}>Move down</button>
                                  {!child && <button type="button" className="btn btn-sm" onClick={() => add(section.code)}>Add a section under it</button>}
                                  <select className="text-input" style={{ width: 240, fontSize: 12 }} value="" aria-label={`Merge ${section.title} into another section`}
                                    onChange={(event) => { if (event.target.value) merge(section.code, event.target.value); }}>
                                    <option value="">Merge into…</option>
                                    {targets.map((other) => <option key={other.code} value={other.code}>{other.title}</option>)}
                                  </select>
                                  <button type="button" className="btn btn-sm" onClick={() => {
                                    const children = sections.filter((other) => other.parentCode === section.code).length;
                                    if (window.confirm(children > 0 ? `Remove "${section.title}" and the ${children} sections under it?` : `Remove "${section.title}"?`)) remove(section.code);
                                  }}>Remove</button>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </FragmentRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {editable && tops.length > 0 && dirty && <div style={{ ...hint, marginTop: 8 }}>You have changes that are not saved.</div>}
        </>
      )}
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
