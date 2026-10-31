'use client';

import { useParams } from 'next/navigation';
import { RecordWorkspace } from '@/components/experiences/RecordWorkspace';

export default function ExperiencePage() {
  const params = useParams();
  const code = String(params.code || '');
  const id = String(params.id || '');
  if (!code || !id) return null;
  return <RecordWorkspace experienceCode={code} entityId={id} />;
}
