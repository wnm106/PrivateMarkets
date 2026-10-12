'use client';

import { useParams } from 'next/navigation';
import { ReportDesignerLoader } from '@/components/reporting/ReportDesignerLoader';

export default function DashboardDesignerPage() {
  const params = useParams();
  return <ReportDesignerLoader kind="dashboard" code={decodeURIComponent(params.code as string)} />;
}
