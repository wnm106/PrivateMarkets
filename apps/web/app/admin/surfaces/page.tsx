'use client';

import { Suspense } from 'react';
import { SurfaceQualificationStudio } from '@/components/surfaces/SurfaceQualificationStudio';

export default function SurfaceQualificationPage() {
  return (
    <Suspense fallback={<div className="view-fade" style={{ color: 'var(--ink-3)', padding: '24px 0' }}>Loading surface qualification…</div>}>
      <SurfaceQualificationStudio />
    </Suspense>
  );
}
