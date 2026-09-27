'use client';

import { useParams } from 'next/navigation';
import { EntityCreationWizard } from '@/components/wizards/EntityCreationWizard';
import { DomainKey } from '@/lib/mock-data'; // Keeping DomainKey type for typing
import { graphqlQuery, DOMAIN_TEMPLATES_QUERY, ATTRIBUTE_REGISTER_QUERY } from '@/lib/graphql';

export default function NewEntityPage() {
  const params = useParams();
  const domain = params.domain as DomainKey;

  return <EntityCreationWizard domain={domain} />;
}
