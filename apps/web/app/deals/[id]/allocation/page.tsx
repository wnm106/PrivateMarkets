'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AllocationBoard } from '@/components/allocation/AllocationBoard';

export default function DealAllocationPage() {
  const params = useParams<{ id: string }>();
  const dealId = params.id;

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/deals" className="crumb-link">Deals</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Allocation</span>
      </div>
      <AllocationBoard dealId={dealId} />
    </div>
  );
}
