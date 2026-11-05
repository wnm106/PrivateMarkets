'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { FundRecWorkspace } from '@/components/fund-rec/FundRecWorkspace';

export default function FundRecFundPage() {
  const params = useParams<{ fundId: string }>();
  const search = useSearchParams();
  return <FundRecWorkspace fundId={params.fundId} initialTab={search.get('tab')} />;
}
