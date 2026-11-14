'use client';

import { useParams } from 'next/navigation';
import { EntityCreatePage } from '@/components/forms/EntityCreatePage';

export default function NewEntityPage() {
  const params = useParams();
  const route = String(params.domain || '');
  return <EntityCreatePage route={route} />;
}
