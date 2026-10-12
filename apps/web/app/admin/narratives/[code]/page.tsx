'use client';

import { useParams } from 'next/navigation';
import { ReportDesignerLoader } from '@/components/reporting/ReportDesignerLoader';

export default function NarrativeDesignerPage() {
  const params = useParams();
  return <ReportDesignerLoader kind="narrative" code={decodeURIComponent(params.code as string)} />;
}
