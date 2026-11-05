'use client';

import { useParams } from 'next/navigation';
import { AllocationBoard } from '@/components/allocation/AllocationBoard';

export default function DealAllocationPage() {
  const params = useParams<{ id: string }>();

  return (
    <div className="view-fade">
      <AllocationBoard dealId={params.id} />
    </div>
  );
}
