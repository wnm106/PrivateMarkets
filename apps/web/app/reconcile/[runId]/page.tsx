'use client';

import { useParams } from 'next/navigation';
import { ReconciliationReview } from '@/components/reconcile/ReconciliationReview';

export default function ReconcileRunPage() {
  const params = useParams<{ runId: string }>();
  return <ReconciliationReview runId={params.runId} />;
}
