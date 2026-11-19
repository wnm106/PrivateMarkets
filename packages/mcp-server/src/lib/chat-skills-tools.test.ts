import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './tool-registry';
import { SKILLS } from './chat-skills';
import { registerDomainTools } from '../tools/domain-tools';
import { registerLineageTools } from '../tools/lineage-tools';
import { registerOverrideTools } from '../tools/override-tools';
import { registerDQTools } from '../tools/dq-tools';
import { registerDQRuleTools } from '../tools/dq-rule-tools';
import { registerComplianceTools } from '../tools/compliance-tools';
import { registerWorkflowTools } from '../tools/workflow-tools';
import { registerListTools } from '../tools/list-tools';
import { registerReportingTools } from '../tools/reporting-tools';

function registry() {
  const r = new ToolRegistry({} as any);
  registerDomainTools(r);
  registerLineageTools(r);
  registerOverrideTools(r);
  registerDQTools(r);
  registerDQRuleTools(r);
  registerComplianceTools(r);
  registerWorkflowTools(r);
  registerListTools(r);
  registerReportingTools(r);
  return r;
}

describe('every tool a skill names can actually be called', () => {
  const r = registry();
  for (const skill of SKILLS) {
    it(`${skill.id}: its tools exist and are offered in ${skill.toolContext}`, () => {
      const offered = new Set(r.listTools(skill.toolContext).map((tool) => tool.name));
      const all = new Set(r.listTools().map((tool) => tool.name));
      const named = [
        ...skill.discovery.flat(),
        ...skill.previewTools,
        ...skill.writeTools,
      ];
      for (const name of named) {
        expect(all.has(name), `${name} is named by ${skill.id} but is not a registered tool`).toBe(true);
        expect(offered.has(name), `${name} is not offered to ${skill.id} in the ${skill.toolContext} profile`).toBe(true);
      }
      for (const group of skill.discovery) {
        expect(group.some((name) => offered.has(name)), `${skill.id} can never satisfy discovery ${group.join(' or ')}`).toBe(true);
      }
    });
  }
});
