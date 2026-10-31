import type { SkillId } from '@tapestrai/mcp-server/src/lib/chat-skills';

/** Skills shown under Admin → Skills. Names match the published skill catalog. */
export const SKILL_NAV: Array<{ id: SkillId; name: string; href: string }> = [
  { id: 'design-dashboard', name: 'Dashboard', href: '/admin/skills/design-dashboard' },
  { id: 'design-narrative', name: 'Narrative', href: '/admin/skills/design-narrative' },
  { id: 'create-entity', name: 'Entity', href: '/admin/skills/create-entity' },
];

export function skillNavById(id: string) {
  return SKILL_NAV.find((skill) => skill.id === id) ?? null;
}
