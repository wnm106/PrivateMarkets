import type { SkillId } from '@tapestrai/mcp-server/src/lib/chat-skills';

/** Skills shown under Admin → Skills. Names match the published skill catalog. */
export const SKILL_NAV: Array<{ id: SkillId; name: string; href: string }> = [
  { id: 'design-dashboard', name: 'Dashboard', href: '/admin/skills/design-dashboard' },
  { id: 'design-narrative', name: 'Narrative', href: '/admin/skills/design-narrative' },
  { id: 'create-entity', name: 'Entity', href: '/admin/skills/create-entity' },
  { id: 'add-field', name: 'Field', href: '/admin/skills/add-field' },
  { id: 'create-compliance-rule', name: 'Compliance rule', href: '/admin/skills/create-compliance-rule' },
  { id: 'change-compliance-rule', name: 'Change a compliance rule', href: '/admin/skills/change-compliance-rule' },
  { id: 'start-workflow', name: 'Workflow run', href: '/admin/skills/start-workflow' },
  { id: 'create-relationship-type', name: 'Relationship type', href: '/admin/skills/create-relationship-type' },
  { id: 'create-dq-rule', name: 'Data quality rule', href: '/admin/skills/create-dq-rule' },
  { id: 'manual-override', name: 'Manual override', href: '/admin/skills/manual-override' },
];

export function skillNavById(id: string) {
  return SKILL_NAV.find((skill) => skill.id === id) ?? null;
}
