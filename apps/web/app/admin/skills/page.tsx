'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { SKILLS } from '@tapestrai/mcp-server/src/lib/chat-skills';
import { SKILL_NAV } from '@/lib/skill-catalog';
import { loadSkillStudio } from '@/lib/skill-studio';
import { usePublishViewContext } from '@/lib/view-context';
import { AppGrid, type ColDef } from '@/components/grid/AppGrid';

interface SkillRow {
  id: string;
  href: string;
  name: string;
  version: string;
  startsWhen: string;
  decisions: string;
}

export default function SkillsAdminPage() {
  const router = useRouter();
  const [versions, setVersions] = useState<Record<string, string>>({});

  usePublishViewContext({
    activity: 'viewing',
    kind: 'skill',
    label: 'Skills',
    summary: 'Authoring studio for assistant skills',
  });

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const skill of SKILL_NAV) {
      const record = loadSkillStudio(skill.id);
      next[skill.id] = record.dirty ? `v${record.version} · unsaved changes` : `v${record.version}`;
    }
    setVersions(next);
  }, []);

  const skillRows = useMemo<SkillRow[]>(() => SKILL_NAV.map((item) => {
    const skill = SKILLS.find((row) => row.id === item.id);
    return {
      id: item.id,
      href: item.href,
      name: item.name,
      version: versions[item.id] || '',
      startsWhen: skill?.startsWhen || '',
      decisions: skill ? `${skill.slots.length} decisions` : '',
    };
  }), [versions]);

  const columns = useMemo<ColDef<SkillRow>[]>(() => [
    { field: 'name', headerName: 'Skill', minWidth: 180, flex: 1 },
    { field: 'id', headerName: 'Code', minWidth: 160 },
    { field: 'version', headerName: 'Version', minWidth: 180 },
    { field: 'startsWhen', headerName: 'Starts when', minWidth: 240, flex: 1.6, autoHeight: true, wrapText: true },
    { field: 'decisions', headerName: 'Decisions', minWidth: 140 },
  ], []);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Skills</span>
      </div>
      <div className="page-header">
        <div className="page-title-block">
          <div>
            <div className="page-title">Skills</div>
            <div className="page-meta">Purpose, inputs, procedure, tools, references, checks, and examples for each assistant skill.</div>
          </div>
        </div>
      </div>
      <div className="data-table">
        <AppGrid
          rows={skillRows}
          columns={columns}
          getRowId={(row) => row.id}
          autoHeight={false}
          height="100%"
          autoRowHeight
          emptyMessage="No skills."
          onRowClicked={(row) => router.push(row.href)}
        />
      </div>
    </div>
  );
}
