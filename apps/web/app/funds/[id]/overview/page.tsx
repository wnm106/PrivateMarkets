'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FundSurface } from '@/components/funds/FundSurface';

export default function FundOverviewPage() {
  const params = useParams<{ id: string }>();

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/funds" className="crumb-link">Funds</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Fund surface</span>
      </div>
      <FundSurface fundId={params.id} />
    </div>
  );
}
