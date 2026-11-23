import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './tool-registry';
import { registerDomainTools } from '../tools/domain-tools';
import { registerSpecialistTools } from '../tools/specialist-tools';
import { registerQueryTools } from '../tools/query-data';
import { registerNarrativeTools } from '../tools/narrative-tools';
import { registerExternalIdTools } from '../tools/external-id-tools';
import { registerOverrideTools } from '../tools/override-tools';

describe('tool effects', () => {
  const registry = new ToolRegistry();
  registerDomainTools(registry);
  registerSpecialistTools(registry);
  registerQueryTools(registry);
  registerNarrativeTools(registry);
  registerExternalIdTools(registry);
  registerOverrideTools(registry);

  it('reads a tool named like a read as a read', () => {
    expect(registry.effectOf('query_data')).toBe('read');
  });

  it('lets drafting and staging run, since they change no live record', () => {
    expect(registry.effectOf('start_load_session')).toBe('stage');
    expect(registry.effectOf('answer_load_session')).toBe('stage');
    expect(registry.effectOf('start_narrative_run')).toBe('stage');
  });

  it('holds every tool that changes live records, rules or settings, and anything unknown', () => {
    for (const name of ['create_entity', 'submit_manual_override', 'run_load_session', 'save_external_id', 'save_lesson', 'no_such_tool']) {
      expect(registry.effectOf(name), name).toBe('write');
    }
  });
});
