'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { SkillStudio } from '@/components/admin/SkillStudio';
import { skillNavById } from '@/lib/skill-catalog';
import type { SkillId } from '@tapestrai/mcp-server/src/lib/chat-skills';

export default function SkillEditorPage() {
  const params = useParams<{ skillId: string }>();
  const skill = skillNavById(params.skillId);

  if (!skill) {
    return (
      <div className="view-fade">
        <div className="crumbs">
          <Link href="/admin/skills" className="crumb-link">Skills</Link>
          <span className="sep">›</span>
          <span className="crumb-current">Unknown</span>
        </div>
        <h1 className="page-title">This skill is not published</h1>
        <p className="page-meta">Open one of the skills listed under Skills.</p>
      </div>
    );
  }

  return (
    <div className="view-fade skill-studio-page">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/admin/skills" className="crumb-link">Skills</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{skill.name}</span>
      </div>
      <SkillStudio skillId={skill.id as SkillId} name={skill.name} />
    </div>
  );
}
