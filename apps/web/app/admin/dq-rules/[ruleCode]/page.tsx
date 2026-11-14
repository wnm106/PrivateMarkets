'use client';

import { useParams } from 'next/navigation';
import { DqRuleEditorPage } from '@/components/quality/DqRuleEditorPage';

export default function DqRuleDetailPage() {
  const params = useParams();
  return <DqRuleEditorPage ruleCode={decodeURIComponent(params.ruleCode as string)} />;
}
