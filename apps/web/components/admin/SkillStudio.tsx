'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SkillId } from '@tapestrai/mcp-server/src/lib/chat-skills';
import { usePublishViewContext } from '@/lib/view-context';
import {
  LOAD_LABEL,
  STUDIO_SECTIONS,
  assembledContext,
  contextAtPhase,
  cyclePhase,
  isTextArtifact,
  loadSkillStudio,
  nextStudioId,
  phaseName,
  publishedRecord,
  roleForFilename,
  saveSkillStudio,
  sectionTone,
  tokenCount,
  type ArtifactRole,
  type SkillDocument,
  type SkillGate,
  type SkillLoad,
  type SkillStudioRecord,
  type StudioSection,
} from '@/lib/skill-studio';

const ROLES: ArtifactRole[] = ['Template', 'Schema', 'Constraints', 'Output format', 'Example', 'Query', 'Reference'];

function clone(document: SkillDocument): SkillDocument {
  return structuredClone(document);
}

export function SkillStudio({ skillId, name }: { skillId: SkillId; name: string }) {
  const [record, setRecord] = useState<SkillStudioRecord | null>(null);
  const [section, setSection] = useState<StudioSection>('purpose');
  const [refId, setRefId] = useState<string | null>(null);
  const [exampleId, setExampleId] = useState<string | null>(null);
  const [simPhase, setSimPhase] = useState<string>('');
  const [showTest, setShowTest] = useState(false);
  const [message, setMessage] = useState('');
  const skipSave = useRef(true);

  useEffect(() => {
    skipSave.current = true;
    const loaded = loadSkillStudio(skillId);
    setRecord(loaded);
    setSection('purpose');
    setRefId(loaded.document.refs[0]?.id ?? null);
    setExampleId(loaded.document.examples[0]?.id ?? null);
    setSimPhase(loaded.document.phases.find((phase) => phase.gate === 'validate')?.id || loaded.document.phases[0]?.id || '');
    setShowTest(false);
    setMessage('');
  }, [skillId]);

  useEffect(() => {
    if (!record) return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    saveSkillStudio(skillId, record);
  }, [record, skillId]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 2500);
    return () => window.clearTimeout(timer);
  }, [message]);

  usePublishViewContext({
    activity: 'editing',
    kind: 'skill',
    label: name,
    id: skillId,
    summary: record?.document.skill.trigger,
  });

  const document = record?.document;
  const context = useMemo(() => (document ? contextAtPhase(document, simPhase) : null), [document, simPhase]);
  const assembled = useMemo(
    () => (document ? assembledContext(skillId, document, simPhase) : ''),
    [document, simPhase, skillId],
  );

  function edit(mutator: (draft: SkillDocument) => void) {
    setRecord((current) => {
      if (!current) return current;
      const draft = clone(current.document);
      mutator(draft);
      return { ...current, dirty: true, document: draft };
    });
  }

  function saveVersion() {
    setRecord((current) => {
      if (!current) return current;
      return { ...current, version: current.version + 1, dirty: false };
    });
    setMessage(`Saved as v${(record?.version ?? 0) + 1}`);
  }

  function resetPublished() {
    const next = publishedRecord(skillId);
    next.dirty = true;
    next.version = record?.version ?? 1;
    setRecord(next);
    setRefId(next.document.refs[0]?.id ?? null);
    setExampleId(next.document.examples[0]?.id ?? null);
    setMessage('Restored the published skill. Save version to keep it.');
  }

  if (!record || !document || !context) {
    return <div className="page-meta">Loading skill…</div>;
  }

  const currentRef = document.refs.find((ref) => ref.id === refId) ?? null;
  const currentExample = document.examples.find((example) => example.id === exampleId) ?? document.examples[0] ?? null;
  const meta = STUDIO_SECTIONS.find((item) => item.id === section) ?? STUDIO_SECTIONS[0];

  return (
    <div className="skill-studio">
      <aside className="skill-studio-nav">
        <div className="skill-studio-id">
          <div className="skill-studio-kicker">Skill</div>
          <div className="skill-studio-name">{skillId}</div>
          <div className="skill-studio-ver">
            v{record.version} · {record.dirty ? 'draft · unsaved changes' : 'saved'}
          </div>
        </div>
        <nav>
          {STUDIO_SECTIONS.map((item) => {
            const tone = sectionTone(document, item.id);
            return (
              <button
                key={item.id}
                type="button"
                className={`skill-studio-sec ${section === item.id ? 'on' : ''}`}
                onClick={() => setSection(item.id)}
              >
                <span>{item.label}</span>
                <span className={`skill-dot ${tone.tone}`}>{tone.mark}</span>
              </button>
            );
          })}
        </nav>
        <div className="skill-studio-legend">
          <span className="skill-dot ok">●</span> complete
          <span className="skill-dot warn">●</span> needs attention
        </div>
        <Link href="/admin/skills" className="skill-studio-back">All skills</Link>
      </aside>

      <main className="skill-studio-main">
        <header className="skill-studio-head">
          <div>
            <h1>{meta.title}</h1>
            <p>{meta.sub}</p>
          </div>
          <div className="skill-studio-actions">
            {message && <span className="skill-studio-msg">{message}</span>}
            <button type="button" className="btn" onClick={() => setShowTest((open) => !open)}>
              {showTest ? 'Hide context' : 'Test in chat'}
            </button>
            <button type="button" className="btn" onClick={resetPublished}>Reset to published</button>
            <button type="button" className="btn btn-primary" onClick={saveVersion}>Save version</button>
          </div>
        </header>

        {section === 'purpose' && (
          <div className="skill-card skill-stack">
            <label className="skill-lbl">Trigger: when to start
              <textarea className="skill-in" value={document.skill.trigger} onChange={(event) => edit((draft) => { draft.skill.trigger = event.target.value; })} />
            </label>
            <label className="skill-lbl">Do not activate for
              <textarea className="skill-in" value={document.skill.notTrigger} onChange={(event) => edit((draft) => { draft.skill.notTrigger = event.target.value; })} />
            </label>
            <label className="skill-lbl">Outcome: what exists when done
              <textarea className="skill-in" value={document.skill.outcome} onChange={(event) => edit((draft) => { draft.skill.outcome = event.target.value; })} />
            </label>
            <label className="skill-lbl">Definition of done
              <textarea className="skill-in" value={document.skill.done} onChange={(event) => edit((draft) => { draft.skill.done = event.target.value; })} />
            </label>
          </div>
        )}

        {section === 'inputs' && (
          <div className="skill-stack">
            {document.slots.map((slot) => (
              <div key={slot.id} className="skill-card skill-stack">
                <div className="skill-line">
                  <label className="skill-lbl" style={{ flex: 1 }}>Slot
                    <input className="skill-in" value={slot.name} onChange={(event) => edit((draft) => { const row = draft.slots.find((item) => item.id === slot.id); if (row) row.name = event.target.value; })} />
                  </label>
                  <button type="button" className={`btn ${slot.required ? 'skill-on' : ''}`} onClick={() => edit((draft) => { const row = draft.slots.find((item) => item.id === slot.id); if (row) row.required = !row.required; })}>
                    {slot.required ? 'Required' : 'Optional'}
                  </button>
                  <button type="button" className="btn" onClick={() => edit((draft) => { draft.slots = draft.slots.filter((item) => item.id !== slot.id); })}>Remove</button>
                </div>
                <div className="skill-g2">
                  <label className="skill-lbl">How to ask
                    <input className="skill-in" value={slot.ask} onChange={(event) => edit((draft) => { const row = draft.slots.find((item) => item.id === slot.id); if (row) row.ask = event.target.value; })} />
                  </label>
                  <label className="skill-lbl">A clear answer is
                    <input className="skill-in" value={slot.passes} onChange={(event) => edit((draft) => { const row = draft.slots.find((item) => item.id === slot.id); if (row) row.passes = event.target.value; })} />
                  </label>
                </div>
              </div>
            ))}
            <div>
              <button type="button" className="btn" onClick={() => edit((draft) => { draft.slots.push({ id: nextStudioId(draft), name: 'New slot', required: true, ask: '', passes: '' }); })}>Add slot</button>
            </div>
          </div>
        )}

        {section === 'procedure' && (
          <div className="skill-stack">
            {document.phases.map((phase, index) => {
              const refs = document.refs.filter((ref) => ref.load === 'phase' && ref.phase === phase.id).map((ref) => ref.name).join(', ') || 'none';
              const tools = document.tools.filter((tool) => tool.enabled && tool.phase === phase.id).map((tool) => tool.name).join(', ') || 'none';
              return (
                <div key={phase.id} className="skill-card skill-stack">
                  <div className="skill-line">
                    <span className="skill-num">{index + 1}</span>
                    <label className="skill-lbl" style={{ flex: 1 }}>Phase
                      <input className="skill-in" value={phase.name} onChange={(event) => edit((draft) => { const row = draft.phases.find((item) => item.id === phase.id); if (row) row.name = event.target.value; })} />
                    </label>
                    <label className="skill-lbl" style={{ width: 200 }}>Gate
                      <select className="skill-in" value={phase.gate} onChange={(event) => edit((draft) => { const row = draft.phases.find((item) => item.id === phase.id); if (row) row.gate = event.target.value as SkillGate; })}>
                        <option value="none">No gate</option>
                        <option value="confirm">User confirms</option>
                        <option value="validate">Validation passes</option>
                      </select>
                    </label>
                    <button type="button" className="btn" disabled={index === 0} onClick={() => edit((draft) => { const row = draft.phases[index]; draft.phases[index] = draft.phases[index - 1]; draft.phases[index - 1] = row; })}>Up</button>
                    <button type="button" className="btn" disabled={index === document.phases.length - 1} onClick={() => edit((draft) => { const row = draft.phases[index]; draft.phases[index] = draft.phases[index + 1]; draft.phases[index + 1] = row; })}>Down</button>
                    <button type="button" className="btn" onClick={() => edit((draft) => {
                      draft.phases = draft.phases.filter((item) => item.id !== phase.id);
                      for (const item of [...draft.refs, ...draft.tools]) {
                        if (item.phase === phase.id) item.phase = 'any';
                      }
                      if (simPhase === phase.id) setSimPhase(draft.phases[0]?.id || '');
                    })}>Remove</button>
                  </div>
                  <div className="skill-loads">Loads: {refs} · Tools: {tools}</div>
                </div>
              );
            })}
            <div>
              <button type="button" className="btn" onClick={() => edit((draft) => { draft.phases.push({ id: nextStudioId(draft), name: 'New phase', gate: 'none' }); })}>Add phase</button>
            </div>
          </div>
        )}

        {section === 'tools' && (
          <div className="skill-stack">
            {document.tools.map((tool) => (
              <div key={tool.id} className="skill-card skill-line">
                <label className="skill-lbl" style={{ width: 220 }}>Tool
                  <input className="skill-in skill-mono" value={tool.name} onChange={(event) => edit((draft) => { const row = draft.tools.find((item) => item.id === tool.id); if (row) row.name = event.target.value; })} />
                </label>
                <div className="skill-lbl" style={{ width: 180 }}>Phase
                  <button type="button" className="btn" onClick={() => edit((draft) => { const row = draft.tools.find((item) => item.id === tool.id); if (row) row.phase = cyclePhase(draft, row.phase); })}>
                    {phaseName(document, tool.phase)} ▸
                  </button>
                </div>
                <label className="skill-lbl" style={{ flex: 1 }}>Rule
                  <input className="skill-in" value={tool.rule} onChange={(event) => edit((draft) => { const row = draft.tools.find((item) => item.id === tool.id); if (row) row.rule = event.target.value; })} />
                </label>
                <button type="button" className={`btn ${tool.enabled ? 'skill-on' : ''}`} onClick={() => edit((draft) => { const row = draft.tools.find((item) => item.id === tool.id); if (row) row.enabled = !row.enabled; })}>
                  {tool.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button type="button" className="btn" onClick={() => edit((draft) => { draft.tools = draft.tools.filter((item) => item.id !== tool.id); })}>Remove</button>
              </div>
            ))}
            <div>
              <button type="button" className="btn" onClick={() => edit((draft) => { draft.tools.push({ id: nextStudioId(draft), name: 'new_tool', phase: 'any', rule: '', enabled: true }); })}>Add tool</button>
            </div>
          </div>
        )}

        {section === 'references' && (
          <div className="skill-stack">
            <div className="skill-line">
              <label className="btn skill-upload">Upload file
                <input
                  type="file"
                  accept=".txt,.md,.markdown,.json,.html,.htm,.csv,.sql,.xml,.yaml,.yml,text/plain"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    if (!isTextArtifact(file)) {
                      setMessage('Upload a text file: markdown, JSON, HTML, CSV, SQL, or plain text.');
                      return;
                    }
                    const reader = new FileReader();
                    reader.onload = () => {
                      let nextId = '';
                      edit((draft) => {
                        nextId = nextStudioId(draft);
                        draft.refs.push({
                          id: nextId,
                          name: file.name,
                          role: roleForFilename(file.name),
                          load: 'request',
                          phase: 'any',
                          instruction: '',
                          content: String(reader.result ?? ''),
                        });
                      });
                      setRefId(nextId);
                    };
                    reader.readAsText(file);
                  }}
                />
              </label>
              <button type="button" className="btn" onClick={() => edit((draft) => {
                const id = nextStudioId(draft);
                draft.refs.push({ id, name: 'untitled.md', role: 'Reference', load: 'request', phase: 'any', instruction: '', content: '' });
                setRefId(id);
              })}>New artifact</button>
            </div>
            <div className="skill-table">
              <div className="skill-row skill-row-hd"><span>Artifact</span><span>Role</span><span>Loads</span><span>Tokens</span></div>
              {document.refs.map((ref) => (
                <button key={ref.id} type="button" className={`skill-row ${ref.id === currentRef?.id ? 'on' : ''}`} onClick={() => setRefId(ref.id)}>
                  <span className="skill-mono">{ref.name}</span>
                  <span>{ref.role}</span>
                  <span className={`skill-load ${ref.load}`}>{ref.load === 'phase' ? `At phase · ${phaseName(document, ref.phase)}` : LOAD_LABEL[ref.load]}</span>
                  <span className="skill-mono skill-tokens">{tokenCount(ref.content)}</span>
                </button>
              ))}
            </div>
            {currentRef && (
              <div className="skill-card skill-stack">
                <div className="skill-line">
                  <label className="skill-lbl" style={{ flex: 1 }}>Name
                    <input className="skill-in skill-mono" value={currentRef.name} onChange={(event) => edit((draft) => { const row = draft.refs.find((item) => item.id === currentRef.id); if (row) row.name = event.target.value; })} />
                  </label>
                  <button type="button" className="btn" onClick={() => edit((draft) => {
                    draft.refs = draft.refs.filter((item) => item.id !== currentRef.id);
                    setRefId(draft.refs[0]?.id ?? null);
                  })}>Delete</button>
                </div>
                <div className="skill-g3">
                  <label className="skill-lbl">Role
                    <select className="skill-in" value={currentRef.role} onChange={(event) => edit((draft) => { const row = draft.refs.find((item) => item.id === currentRef.id); if (row) row.role = event.target.value as ArtifactRole; })}>
                      {ROLES.map((role) => <option key={role}>{role}</option>)}
                    </select>
                  </label>
                  <label className="skill-lbl">Load rule
                    <select className="skill-in" value={currentRef.load} onChange={(event) => edit((draft) => { const row = draft.refs.find((item) => item.id === currentRef.id); if (row) row.load = event.target.value as SkillLoad; })}>
                      <option value="always">Always</option>
                      <option value="trigger">On trigger</option>
                      <option value="phase">At phase</option>
                      <option value="request">On request</option>
                    </select>
                  </label>
                  {currentRef.load === 'phase' && (
                    <div className="skill-lbl">Phase
                      <button type="button" className="btn" onClick={() => edit((draft) => { const row = draft.refs.find((item) => item.id === currentRef.id); if (row) row.phase = cyclePhase(draft, row.phase); })}>
                        {phaseName(document, currentRef.phase)} ▸
                      </button>
                    </div>
                  )}
                </div>
                <label className="skill-lbl">Agent instruction
                  <input className="skill-in" value={currentRef.instruction} onChange={(event) => edit((draft) => { const row = draft.refs.find((item) => item.id === currentRef.id); if (row) row.instruction = event.target.value; })} />
                </label>
                <label className="skill-lbl">Content · {tokenCount(currentRef.content)} tokens
                  <textarea className="skill-in skill-mono skill-content" value={currentRef.content} onChange={(event) => edit((draft) => { const row = draft.refs.find((item) => item.id === currentRef.id); if (row) row.content = event.target.value; })} />
                </label>
              </div>
            )}
          </div>
        )}

        {section === 'checks' && (
          <div className="skill-stack">
            {document.checks.map((check) => (
              <div key={check.id} className="skill-card skill-line">
                <div className="skill-lbl" style={{ width: 160 }}>Kind
                  <button type="button" className={`btn skill-kind ${check.kind}`} onClick={() => edit((draft) => { const row = draft.checks.find((item) => item.id === check.id); if (row) row.kind = row.kind === 'det' ? 'rub' : 'det'; })}>
                    {check.kind === 'det' ? 'Deterministic' : 'Rubric'}
                  </button>
                </div>
                <label className="skill-lbl" style={{ flex: 1 }}>Check
                  <input className="skill-in" value={check.text} onChange={(event) => edit((draft) => { const row = draft.checks.find((item) => item.id === check.id); if (row) row.text = event.target.value; })} />
                </label>
                <button type="button" className={`btn ${check.enabled ? 'skill-on' : ''}`} onClick={() => edit((draft) => { const row = draft.checks.find((item) => item.id === check.id); if (row) row.enabled = !row.enabled; })}>
                  {check.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button type="button" className="btn" onClick={() => edit((draft) => { draft.checks = draft.checks.filter((item) => item.id !== check.id); })}>Remove</button>
              </div>
            ))}
            <div className="skill-line">
              <button type="button" className="btn" onClick={() => edit((draft) => { draft.checks.push({ id: nextStudioId(draft), kind: 'det', text: 'New deterministic check', enabled: true }); })}>Add deterministic check</button>
              <button type="button" className="btn" onClick={() => edit((draft) => { draft.checks.push({ id: nextStudioId(draft), kind: 'rub', text: 'New rubric check', enabled: true }); })}>Add rubric check</button>
            </div>
          </div>
        )}

        {section === 'examples' && (
          <div className="skill-stack">
            <div className="skill-line">
              {document.examples.map((example) => (
                <button key={example.id} type="button" className={`btn ${currentExample?.id === example.id ? 'skill-tab-on' : ''}`} onClick={() => setExampleId(example.id)}>{example.title}</button>
              ))}
              <button type="button" className="btn" onClick={() => edit((draft) => {
                const id = nextStudioId(draft);
                draft.examples.push({ id, title: 'New example', body: '' });
                setExampleId(id);
              })}>Add example</button>
            </div>
            {currentExample && (
              <div className="skill-card skill-stack">
                <div className="skill-line">
                  <label className="skill-lbl" style={{ flex: 1 }}>Title
                    <input className="skill-in" value={currentExample.title} onChange={(event) => edit((draft) => { const row = draft.examples.find((item) => item.id === currentExample.id); if (row) row.title = event.target.value; })} />
                  </label>
                  <button type="button" className="btn" onClick={() => edit((draft) => {
                    draft.examples = draft.examples.filter((item) => item.id !== currentExample.id);
                    setExampleId(draft.examples[0]?.id ?? null);
                  })}>Delete</button>
                </div>
                <label className="skill-lbl">Transcript
                  <textarea className="skill-in skill-mono skill-content" value={currentExample.body} onChange={(event) => edit((draft) => { const row = draft.examples.find((item) => item.id === currentExample.id); if (row) row.body = event.target.value; })} />
                </label>
              </div>
            )}
          </div>
        )}
      </main>

      <aside className="skill-studio-context">
        <div>
          <div className="skill-studio-kicker">Context at phase</div>
          <div className="skill-studio-total">{context.loaded.toLocaleString()} <span>tokens loaded</span></div>
        </div>
        <div className="skill-bar">
          {context.groups.filter((group) => group.inBar).map((group) => (
            <div key={group.label} style={{ flex: group.tokens, background: group.color }} />
          ))}
        </div>
        <div className="skill-groups">
          {context.groups.map((group) => (
            <div key={group.label}>
              <div className="skill-group-hd">
                <b style={{ color: group.color }}>{group.label}</b>
                <span>{group.tokens.toLocaleString()}</span>
              </div>
              <div className="skill-group-files">{group.files}</div>
            </div>
          ))}
        </div>
        {context.warnings.map((warning) => (
          <div key={warning} className="skill-warn">{warning}</div>
        ))}
        {showTest && (
          <div>
            <div className="skill-studio-kicker">Assembled context</div>
            <pre className="skill-assembled">{assembled}</pre>
          </div>
        )}
        <div className="skill-sim">
          <div className="skill-studio-kicker">Simulate phase</div>
          <div className="skill-line">
            {document.phases.map((phase) => (
              <button key={phase.id} type="button" className={`btn ${simPhase === phase.id ? 'skill-tab-on' : ''}`} onClick={() => setSimPhase(phase.id)}>{phase.name}</button>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
