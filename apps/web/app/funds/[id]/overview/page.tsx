'use client';

import { useParams } from 'next/navigation';
import { FundSurface } from '@/components/funds/FundSurface';

export default function FundOverviewPage() {
  const params = useParams<{ id: string }>();

  return (
    <div className="view-fade">
      <FundSurface fundId={params.id} />
    </div>
  );
}
