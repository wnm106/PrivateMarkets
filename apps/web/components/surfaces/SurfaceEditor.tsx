'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FundRecord, SurfaceCatalog, SurfaceFact, SurfaceResolution, SurfaceTabWrite } from '@/lib/surfaces';

type Operator = 'is' | 'is_not';
type Logic = 'AND' | 'OR';

interface Condition {
  id: string;
  attribute: string;
  operator: Operator;
  value: string;
}

interface Layout {
  id: string;
  name: string;
  mode: 'rule' | 'records' | 'everyone';
  logic: Logic;
  conditions: Condition[];
  recordNames: string[];
}

interface Section {
  id: string;
  name: string;
  fluid: boolean;
  layouts: Layout[];
}

interface TabDraft {
  id: string;
  slotCode: string | null;
  name: string;
  appearance: 'always' | 'when';
  logic: Logic;
  conditions: Condition[];
  sections: Section[];
}

const ATTRIBUTES = [
  ['FUND_STRUCTURE', 'Fund structure'],
  ['ASSET_CLASS', 'Asset class'],
  ['SECTOR', 'Sector'],
  ['INDUSTRY', 'Industry'],
  ['LISTING_STATUS', 'Listing status'],
  ['ACCOUNTING_BASIS', 'Accounting basis'],
  ['DEAL_TYPE', 'Deal type'],
  ['TEMPLATE_CODE', 'Template'],
  ['ENTITY_NAME', 'Record name'],
];

const VALUES = ['PUBLIC_BDC', 'CLOSED_END', 'CREDIT', 'REAL_ESTATE', 'HEALTHCARE', 'MANUFACTURING', 'GAAP', 'FAIR_VALUE', 'LISTED', 'PRIVATE'];

let nextId = 1;
const uid = () => `c${nextId++}`;

function labelOf(code: string): string {
  return ATTRIBUTES.find((item) => item[0] === code)?.[1]
    || code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
}

function inWords(conditions: Condition[], logic: Logic): string {
  if (conditions.length === 0) return 'Add a condition.';
  const joiner = logic === 'OR' ? ' or ' : ' and ';
  return conditions.map((condition) => `${labelOf(condition.attribute)} ${condition.operator === 'is_not' ? 'is not' : 'is'} ${condition.value}`).join(joiner);
}

function fromRules(rules: SurfaceCatalog['experiences'][number]['applicabilityRules']): { logic: Logic; conditions: Condition[] } {
  const logic = rules?.logic === 'OR' ? 'OR' : 'AND';
  const conditions = (rules?.conditions || [])
    .filter((condition) => condition.attributeCode)
    .map((condition) => ({
      id: uid(),
      attribute: condition.attributeCode || 'FUND_STRUCTURE',
      operator: (condition.operator === 'not_equals' ? 'is_not' : 'is') as Operator,
      value: condition.value == null ? '' : String(condition.value),
    }));
  return { logic, conditions };
}

function interpretCodes(
  codes: string[],
  experienceByCode: Map<string, SurfaceCatalog['experiences'][number]>,
): { mode: Layout['mode']; logic: Logic; conditions: Condition[]; recordNames: string[] } {
  const parsed = codes
    .map((code) => experienceByCode.get(code))
    .filter((experience) => experience && !experience.isBaseline)
    .map((experience) => fromRules(experience!.applicabilityRules));
  const conditions = parsed.flatMap((item) => item.conditions);
  const recordNames = conditions.filter((condition) => condition.attribute === 'ENTITY_NAME').map((condition) => condition.value);
  const others = conditions.filter((condition) => condition.attribute !== 'ENTITY_NAME');
  if (recordNames.length > 0 && others.length === 0) {
    return { mode: 'records', logic: 'OR', conditions: [], recordNames };
  }
  if (conditions.length === 0) return { mode: 'everyone', logic: 'AND', conditions: [], recordNames: [] };
  return { mode: 'rule', logic: parsed[0]?.logic || 'AND', conditions, recordNames: [] };
}

function draftFromCatalog(catalog: SurfaceCatalog): TabDraft[] {
  const experienceByCode = new Map(catalog.experiences.map((experience) => [experience.experienceCode, experience]));
  return catalog.slots.map((slot) => {
    const variants = [...slot.variants].sort((left, right) => left.qualificationPriority - right.qualificationPriority);
    const requiredSets = variants.map((variant) => variant.requiredExperienceCodes.filter((code) => {
      const experience = experienceByCode.get(code);
      return experience && !experience.isBaseline;
    }));
    const shared = requiredSets[0]?.filter((code) => requiredSets.every((set) => set.includes(code))) || [];
    const gate = slot.optionality === 'when_qualified' ? interpretCodes(shared, experienceByCode) : null;
    const layouts: Layout[] = variants.map((variant) => {
      const extra = variant.requiredExperienceCodes.filter((code) => {
        const experience = experienceByCode.get(code);
        return experience && !experience.isBaseline && !(slot.optionality === 'when_qualified' && shared.includes(code));
      });
      const interpreted = interpretCodes(extra, experienceByCode);
      const components = catalog.components.filter((component) => component.slotCode === slot.slotCode && component.variantCode === variant.variantCode);
      return {
        id: variant.id,
        name: components.length === 1 ? components[0].componentName : variant.variantName,
        mode: interpreted.mode,
        logic: interpreted.logic,
        conditions: interpreted.conditions,
        recordNames: interpreted.recordNames,
      };
    });
    const filled = layouts.length > 0 ? layouts : [{ id: uid(), name: slot.slotName, mode: 'everyone' as const, logic: 'AND' as const, conditions: [], recordNames: [] }];
    const fluid = filled.length > 1 || filled.some((layout) => layout.mode !== 'everyone');
    return {
      id: slot.id,
      slotCode: slot.slotCode,
      name: slot.slotName,
      appearance: slot.optionality === 'when_qualified' ? 'when' : 'always',
      logic: gate?.logic || 'AND',
      conditions: gate?.mode === 'records'
        ? gate.recordNames.map((name) => ({ id: uid(), attribute: 'ENTITY_NAME', operator: 'is' as const, value: name }))
        : (gate?.conditions || []),
      sections: [{
        id: `${slot.id}-content`,
        name: fluid ? slot.slotName : (filled[0]?.name || slot.slotName),
        fluid,
        layouts: filled,
      }],
    };
  });
}

function payload(tabs: TabDraft[]): SurfaceTabWrite[] {
  return tabs.map((tab) => ({
    slotCode: tab.slotCode,
    name: tab.name.trim() || 'Tab',
    appearance: tab.appearance,
    logic: tab.logic,
    conditions: tab.appearance === 'when'
      ? tab.conditions.filter((condition) => condition.value).map((condition) => ({
        attribute: condition.attribute,
        operator: condition.operator,
        value: condition.value,
      }))
      : [],
    layouts: tab.sections.flatMap((section) => section.layouts).map((layout) => ({
      name: layout.name.trim() || tab.name,
      mode: layout.mode,
      logic: layout.logic,
      conditions: layout.mode === 'rule'
        ? layout.conditions.filter((condition) => condition.value).map((condition) => ({
          attribute: condition.attribute,
          operator: condition.operator,
          value: condition.value,
        }))
        : [],
      recordNames: layout.mode === 'records' ? layout.recordNames : [],
    })),
  }));
}

function matches(conditions: Condition[], logic: Logic, facts: Record<string, string>, recordName: string, mode: Layout['mode'], recordNames: string[]): boolean {
  if (mode === 'everyone') return true;
  if (mode === 'records') return recordNames.includes(recordName);
  if (conditions.length === 0) return false;
  const checks = conditions.map((condition) => {
    const actual = facts[condition.attribute] ?? '';
    return condition.operator === 'is_not' ? actual !== condition.value : actual === condition.value;
  });
  return logic === 'OR' ? checks.some(Boolean) : checks.every(Boolean);
}

function factsMap(facts: SurfaceFact[]): Record<string, string> {
  return Object.fromEntries(facts.map((fact) => [fact.key, fact.value]));
}

export function SurfaceEditor({
  catalog,
  funds,
  previewId,
  onPreview,
  resolution,
  onSave,
}: {
  catalog: SurfaceCatalog;
  funds: FundRecord[];
  previewId: string;
  onPreview: (id: string) => void;
  resolution: SurfaceResolution | null;
  onSave: (tabs: SurfaceTabWrite[]) => Promise<string | null>;
}) {
  const [tabs, setTabs] = useState<TabDraft[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const next = draftFromCatalog(catalog);
    setTabs(next);
    setSelectedId((current) => next.some((tab) => tab.id === current) ? current : (next[0]?.id || ''));
    setSaved(JSON.stringify(payload(next)));
    setSaveError(null);
  }, [catalog]);

  const selected = tabs.find((tab) => tab.id === selectedId) ?? tabs[0];
  const preview = funds.find((fund) => fund.id === previewId) || funds[0];
  const facts = useMemo(() => factsMap(resolution?.facts || []), [resolution]);
  const dirty = tabs.length > 0 && JSON.stringify(payload(tabs)) !== saved;

  const updateTab = (patch: Partial<TabDraft>) => {
    if (!selected) return;
    setTabs((current) => current.map((tab) => tab.id === selected.id ? { ...tab, ...patch } : tab));
  };

  const localRows = tabs.map((tab) => {
    const shown = tab.appearance === 'always' || matches(tab.conditions, tab.logic, facts, preview?.entityName || '', 'rule', []);
    const winning = tab.sections.flatMap((section) => section.layouts).find((layout) => matches(layout.conditions, layout.logic, facts, preview?.entityName || '', layout.mode, layout.recordNames));
    return {
      id: tab.id,
      name: tab.name,
      shown,
      detail: shown
        ? (winning?.name || tab.sections[0]?.layouts[0]?.name || 'Open')
        : `Needs: ${inWords(tab.conditions, tab.logic)}`,
    };
  });
  const previewRows = !dirty && resolution
    ? resolution.pages.map((page) => ({
      id: page.slotCode,
      name: page.slotName,
      shown: page.status === 'RENDERED',
      detail: page.status === 'RENDERED' ? (page.variantName || 'Open on the live page') : page.decision,
    }))
    : localRows;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    const message = await onSave(payload(tabs));
    setSaving(false);
    if (message) setSaveError(message);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <p className="se-words" style={{ margin: 0 }}>
          {dirty
            ? 'Unsaved. Live pages still use the last save.'
            : `Saved. Opening ${preview?.entityName || 'a record'} uses these rules.`}
        </p>
        <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={() => { void save(); }}>
          {saving ? 'Saving…' : 'Save to live pages'}
        </button>
      </div>
      {saveError && <div style={{ background: '#fdecec', color: '#b91c1c', padding: '12px 14px', marginBottom: 12, fontSize: 13 }}>{saveError}</div>}
      <div className="surface-editor">
      <style>{`
        .surface-editor { display: grid; grid-template-columns: 220px minmax(0, 1fr) 280px; gap: 14px; align-items: start; }
        @media (max-width: 1100px) { .surface-editor { grid-template-columns: 1fr; } }
        .se-card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
        .se-kicker { font-size: 11px; letter-spacing: 0.08em; font-weight: 600; color: var(--ink-3); margin: 0 0 10px; }
        .se-tab { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px; text-align: left; border: 0; border-left: 3px solid transparent; background: transparent; padding: 8px 10px; border-radius: 8px; cursor: pointer; color: var(--ink); font: inherit; }
        .se-tab.on { background: #e7f2f4; border-left-color: #0b5d73; }
        .se-badge { font-size: 10px; border-radius: 999px; padding: 2px 6px; background: var(--bg-alt); color: var(--ink-3); }
        .se-badge.when { background: #fef3c7; color: #92400e; }
        .se-name { width: 100%; border: 0; border-bottom: 1px solid transparent; background: transparent; font: inherit; font-size: 18px; font-weight: 600; color: var(--ink); padding: 2px 0; }
        .se-name:focus { outline: none; border-bottom-color: var(--line); }
        .se-step { font-size: 12px; font-weight: 700; letter-spacing: 0.04em; color: var(--ink-2); margin: 16px 0 8px; }
        .se-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
        .se-seg button { border: 0; background: var(--surface); padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; color: var(--ink-2); }
        .se-seg button.on { background: #0b5d73; color: #fff; }
        .se-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
        .se-row select, .se-select { border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 13px; }
        .se-words { font-size: 12px; color: var(--ink-3); margin: 4px 0 0; }
        .se-layout { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
        .se-layout-name { width: 100%; border: 0; background: transparent; font: inherit; font-size: 14px; font-weight: 600; color: var(--ink); }
        .se-pill { border: 1px solid var(--line); background: var(--bg); border-radius: 999px; padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer; color: var(--ink-2); }
        .se-pill.on { background: #0b5d73; color: #fff; border-color: #0b5d73; }
        .se-fluid { font-size: 11px; color: #0b5d73; background: #e7f2f4; border-radius: 999px; padding: 2px 8px; }
        .se-preview-item { padding: 8px 0; border-bottom: 1px solid var(--line); }
        .se-shown { color: #047857; font-size: 11px; font-weight: 600; }
        .se-hidden { color: var(--ink-3); font-size: 11px; font-weight: 600; }
      `}</style>

      <aside className="se-card">
        <p className="se-kicker">TABS</p>
        {tabs.map((tab) => (
          <button key={tab.id} type="button" className={`se-tab ${tab.id === selected?.id ? 'on' : ''}`} onClick={() => setSelectedId(tab.id)}>
            <span>{tab.name}</span>
            <span className={`se-badge ${tab.appearance === 'when' ? 'when' : ''}`}>{tab.appearance === 'when' ? 'conditional' : 'always'}</span>
          </button>
        ))}
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginTop: 10 }}
          onClick={() => {
            const tab: TabDraft = {
              id: uid(),
              slotCode: null,
              name: 'New tab',
              appearance: 'always',
              logic: 'AND',
              conditions: [],
              sections: [{ id: uid(), name: 'Section', fluid: false, layouts: [{ id: uid(), name: 'Layout', mode: 'everyone', logic: 'AND', conditions: [], recordNames: [] }] }],
            };
            setTabs((current) => [...current, tab]);
            setSelectedId(tab.id);
          }}
        >
          + Add tab
        </button>
      </aside>

      {selected && (
        <section className="se-card">
          <div className="se-row" style={{ justifyContent: 'space-between' }}>
            <input className="se-name" value={selected.name} aria-label="Tab name" onChange={(event) => updateTab({ name: event.target.value })} />
            <button type="button" className="btn btn-sm" onClick={() => setTabs((current) => current.filter((tab) => tab.id !== selected.id))}>Delete tab</button>
          </div>

          <p className="se-step">1 · WHEN DOES THIS TAB APPEAR?</p>
          <div className="se-seg">
            <button type="button" className={selected.appearance === 'always' ? 'on' : ''} onClick={() => updateTab({ appearance: 'always' })}>Always</button>
            <button type="button" className={selected.appearance === 'when' ? 'on' : ''} onClick={() => updateTab({ appearance: 'when' })}>Only when…</button>
          </div>
          {selected.appearance === 'when' && (
            <div style={{ marginTop: 12 }}>
              <div className="se-row">
                <span>Match</span>
                <select className="se-select" value={selected.logic} aria-label="Match logic" onChange={(event) => updateTab({ logic: event.target.value as Logic })}>
                  <option value="AND">all</option>
                  <option value="OR">any</option>
                </select>
                <span>of these:</span>
              </div>
              {selected.conditions.map((condition) => (
                <div className="se-row" key={condition.id}>
                  <select className="se-select" aria-label="Attribute" value={condition.attribute} onChange={(event) => updateTab({ conditions: selected.conditions.map((item) => item.id === condition.id ? { ...item, attribute: event.target.value } : item) })}>
                    {ATTRIBUTES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                  </select>
                  <select className="se-select" aria-label="Operator" value={condition.operator} onChange={(event) => updateTab({ conditions: selected.conditions.map((item) => item.id === condition.id ? { ...item, operator: event.target.value as Operator } : item) })}>
                    <option value="is">is</option>
                    <option value="is_not">is not</option>
                  </select>
                  <select className="se-select" aria-label="Value" value={condition.value} onChange={(event) => updateTab({ conditions: selected.conditions.map((item) => item.id === condition.id ? { ...item, value: event.target.value } : item) })}>
                    {!VALUES.includes(condition.value) && condition.value && <option value={condition.value}>{condition.value}</option>}
                    {VALUES.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                  <button type="button" className="btn btn-sm" aria-label="Remove condition" onClick={() => updateTab({ conditions: selected.conditions.filter((item) => item.id !== condition.id) })}>×</button>
                </div>
              ))}
              <button type="button" className="btn btn-sm" onClick={() => updateTab({ conditions: [...selected.conditions, { id: uid(), attribute: 'FUND_STRUCTURE', operator: 'is', value: 'PUBLIC_BDC' }] })}>+ Add condition</button>
              <p className="se-words">In words: {inWords(selected.conditions, selected.logic)}</p>
            </div>
          )}
          {selected.appearance === 'always' && <p className="se-words">This tab is on the surface for every record.</p>}

          <p className="se-step">2 · WHAT IS ON THIS TAB?</p>
          {selected.sections.map((section) => (
            <div className="se-layout" key={section.id}>
              <div className="se-row" style={{ justifyContent: 'space-between' }}>
                <input className="se-layout-name" aria-label="Section name" value={section.name} onChange={(event) => updateTab({ sections: selected.sections.map((item) => item.id === section.id ? { ...item, name: event.target.value } : item) })} />
                {section.fluid && <span className="se-fluid">fluid · {section.layouts.length} layouts</span>}
              </div>
              {section.layouts.map((layout) => (
                <div key={layout.id} style={{ marginTop: 10 }}>
                  <input className="se-layout-name" aria-label="Layout name" value={layout.name} onChange={(event) => updateTab({ sections: selected.sections.map((item) => item.id === section.id ? { ...item, layouts: item.layouts.map((entry) => entry.id === layout.id ? { ...entry, name: event.target.value } : entry) } : item) })} />
                  {layout.mode === 'everyone' ? (
                    <p className="se-words">Everyone else gets this layout.</p>
                  ) : (
                    <>
                      <div className="se-row">
                        <button type="button" className={`se-pill ${layout.mode === 'rule' ? 'on' : ''}`} onClick={() => updateTab({ sections: selected.sections.map((item) => item.id === section.id ? { ...item, layouts: item.layouts.map((entry) => entry.id === layout.id ? { ...entry, mode: 'rule' } : entry) } : item) })}>For records matching a rule</button>
                        <button type="button" className={`se-pill ${layout.mode === 'records' ? 'on' : ''}`} onClick={() => updateTab({ sections: selected.sections.map((item) => item.id === section.id ? { ...item, layouts: item.layouts.map((entry) => entry.id === layout.id ? { ...entry, mode: 'records' } : entry) } : item) })}>For specific records</button>
                      </div>
                      {layout.mode === 'rule' && <p className="se-words">In words: {inWords(layout.conditions, layout.logic)}</p>}
                      {layout.mode === 'records' && (
                        <div className="se-row">
                          {funds.slice(0, 8).map((fund) => (
                            <button
                              key={fund.id}
                              type="button"
                              className={`se-pill ${layout.recordNames.includes(fund.entityName) ? 'on' : ''}`}
                              onClick={() => {
                                const recordNames = layout.recordNames.includes(fund.entityName)
                                  ? layout.recordNames.filter((name) => name !== fund.entityName)
                                  : [...layout.recordNames, fund.entityName];
                                updateTab({ sections: selected.sections.map((item) => item.id === section.id ? { ...item, layouts: item.layouts.map((entry) => entry.id === layout.id ? { ...entry, recordNames } : entry) } : item) });
                              }}
                            >
                              {fund.entityName}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
              {!section.fluid && (
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginTop: 8 }}
                  onClick={() => updateTab({ sections: selected.sections.map((item) => item.id === section.id ? { ...item, fluid: true, layouts: [...item.layouts, { id: uid(), name: 'Another layout', mode: 'rule', logic: 'AND', conditions: [{ id: uid(), attribute: 'FUND_STRUCTURE', operator: 'is', value: 'PUBLIC_BDC' }], recordNames: [] }] } : item) })}
                >
                  Make this section fluid
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      <aside className="se-card">
        <p className="se-kicker">PREVIEW AS</p>
        <select className="se-select" style={{ width: '100%', marginBottom: 8 }} aria-label="Preview record" value={preview?.id || ''} onChange={(event) => onPreview(event.target.value)}>
          {funds.map((fund) => <option key={fund.id} value={fund.id}>{fund.entityName}</option>)}
        </select>
        {preview?.description && <p className="se-words">{preview.description}</p>}
        {previewRows.map((row) => (
          <div className="se-preview-item" key={row.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <strong style={{ fontSize: 13 }}>{row.name}</strong>
              <span className={row.shown ? 'se-shown' : 'se-hidden'}>{row.shown ? 'open' : 'disabled'}</span>
            </div>
            <div className="se-words">{row.detail}</div>
          </div>
        ))}
        </aside>
      </div>
    </div>
  );
}
