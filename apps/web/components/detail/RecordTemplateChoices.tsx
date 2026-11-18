'use client';

import { useCallback, useEffect, useState } from 'react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';

interface Choice {
  id: string;
  templateId: string;
  templateName: string;
  validFrom: string | null;
  validTo: string | null;
}

interface Slot {
  relationshipCode: string | null;
  relationshipName: string | null;
  domainCode: string;
  domainName: string;
  templates: Array<{ id: string; templateName: string }>;
  choices: Choice[];
}

interface Effective {
  templateName: string | null;
  source: string;
  fromEntityName: string | null;
}

const QUERY = `
  query RecordTemplates($entityId: ID!, $entityIds: [ID!]!, $asOfDate: Date) {
    templateChoiceSlots(entityId: $entityId) {
      relationshipCode
      relationshipName
      domainCode
      domainName
      templates { id templateName }
      choices { id templateId templateName validFrom validTo }
    }
    effectiveTemplates(entityIds: $entityIds, asOfDate: $asOfDate) {
      templateName
      source
      fromEntityName
    }
  }
`;

const SAVE = `
  mutation SetEntityTemplateChoice($input: SetEntityTemplateChoiceInput!) {
    setEntityTemplateChoice(input: $input) {
      success
      errors { message }
    }
  }
`;

function longDay(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

/** The choice with no end date is the one in force from now on. */
function currentChoice(slot: Slot): Choice | null {
  return slot.choices.find((choice) => !choice.validTo) || null;
}

function history(slot: Slot): string {
  if (slot.choices.length < 2) return '';
  return slot.choices.map((choice) => {
    if (choice.validFrom && choice.validTo) return `${choice.templateName} from ${longDay(choice.validFrom)} to ${longDay(choice.validTo)}`;
    if (choice.validTo) return `${choice.templateName} until ${longDay(choice.validTo)}`;
    if (choice.validFrom) return `${choice.templateName} from ${longDay(choice.validFrom)}`;
    return choice.templateName;
  }).join('; ');
}

function ownSummary(effective: Effective | null): string {
  if (!effective?.templateName) return 'No template.';
  if (effective.source === 'OVERRIDE') return `Uses ${effective.templateName}, set on this record.`;
  if (effective.source === 'INHERITED') return `Uses ${effective.templateName}, chosen on ${effective.fromEntityName || 'the linked record'}.`;
  if (effective.fromEntityName) return `Uses ${effective.templateName}. ${effective.fromEntityName} has not chosen a template.`;
  return `Uses ${effective.templateName}.`;
}

/**
 * Template choices on a record. An issuer picks the template its statement
 * periods use; a statement period shows where its template came from and can
 * be set apart. Renders nothing when no relationship passes a template along.
 */
export function RecordTemplateChoices({ entityId, asOfDate }: { entityId: string; asOfDate?: string }) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [effective, setEffective] = useState<Effective | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [from, setFrom] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await graphqlQuery<{ templateChoiceSlots: Slot[]; effectiveTemplates: Effective[] }, {
      entityId: string;
      entityIds: string[];
      asOfDate?: string | null;
    }>(QUERY, { entityId, entityIds: [entityId], asOfDate: asOfDate || null }, 'network-only');
    if (result.error) {
      setSlots([]);
      return;
    }
    const next = result.data?.templateChoiceSlots || [];
    setSlots(next);
    setEffective(result.data?.effectiveTemplates?.[0] || null);
    setPicked(Object.fromEntries(next.map((slot) => [slot.relationshipCode || '', currentChoice(slot)?.templateId || ''])));
    setFrom({});
  }, [asOfDate, entityId]);

  useEffect(() => { void load(); }, [load]);

  if (slots.length === 0) return null;

  const save = async (slot: Slot) => {
    const key = slot.relationshipCode || '';
    setSaving(key);
    setError(null);
    const result = await graphqlMutation<{
      setEntityTemplateChoice: { success: boolean; errors: Array<{ message: string }> };
    }, { input: { entityId: string; relationshipCode: string | null; templateId: string | null; effectiveFrom: string | null } }>(SAVE, {
      input: {
        entityId,
        relationshipCode: slot.relationshipCode,
        templateId: picked[key] || null,
        effectiveFrom: picked[key] ? from[key] || null : null,
      },
    });
    setSaving(null);
    const failure = result.error?.message || result.data?.setEntityTemplateChoice?.errors?.[0]?.message;
    if (failure) {
      setError(failure);
      return;
    }
    await load();
  };

  return (
    <section className="field-section" aria-label="Templates" style={{ marginBottom: '16px' }}>
      <div className="field-section-head">
        <div className="field-section-name">Templates</div>
      </div>
      <div style={{ padding: '12px 20px', display: 'grid', gap: '14px' }}>
        {slots.map((slot) => {
          const key = slot.relationshipCode || '';
          const own = slot.relationshipCode == null;
          const current = currentChoice(slot)?.templateId || '';
          const changed = (picked[key] || '') !== current || !!from[key];
          const past = history(slot);
          return (
            <div key={key || 'own'} style={{ display: 'grid', gap: '6px' }}>
              <div style={{ fontSize: '13px', fontWeight: 500 }}>
                {own ? 'This record' : `${slot.domainName} records linked to this one`}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
                {own
                  ? ownSummary(effective)
                  : `Every ${slot.domainName.toLowerCase()} linked through ${slot.relationshipName || slot.relationshipCode} uses the template chosen here.`}
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  className="select"
                  aria-label={own ? 'Template for this record' : `Template for ${slot.domainName} records`}
                  value={picked[key] || ''}
                  onChange={(event) => setPicked((prev) => ({ ...prev, [key]: event.target.value }))}
                  style={{ minWidth: '240px' }}
                >
                  <option value="">{own ? 'Follow the linked record' : 'No choice: each record keeps its own'}</option>
                  {slot.templates.map((template) => (
                    <option key={template.id} value={template.id}>{template.templateName}</option>
                  ))}
                </select>
                {!own && picked[key] && (
                  <label style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', color: 'var(--ink-3)' }}>
                    From
                    <input
                      type="date"
                      className="text-input"
                      value={from[key] || ''}
                      onChange={(event) => setFrom((prev) => ({ ...prev, [key]: event.target.value }))}
                      title="Leave blank to apply the template to every period"
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!changed || saving === key}
                  onClick={() => { void save(slot); }}
                >
                  {saving === key ? 'Saving…' : 'Apply'}
                </button>
              </div>
              {!own && picked[key] && (
                <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
                  Leave the date blank to apply the template to every period. With a date, earlier periods keep what they had.
                </div>
              )}
              {past && <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{past}.</div>}
            </div>
          );
        })}
        {error && <div className="xp-error">{error}</div>}
      </div>
    </section>
  );
}
