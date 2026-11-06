'use client';

import { useCallback, useEffect, useState } from 'react';
import { graphqlClient, ME_QUERY, ENTITY_ACCESS_QUERY } from '@/lib/graphql';
import { EntityRoleAccess, type AccessGrant } from './EntityRoleAccess';

interface AccessRecord {
  entityId: string;
  clientId: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  restricted: boolean;
  grants: AccessGrant[];
}

/**
 * Shown on an entity page to administrators. Assigning a role closes the
 * entity, and every child under it, to everyone else in the client.
 */
export function EntityAccessPanel({ entityId }: { entityId: string }) {
  const [allowed, setAllowed] = useState(false);
  const [record, setRecord] = useState<AccessRecord | null>(null);

  const load = useCallback(async () => {
    const me = await graphqlClient.query(ME_QUERY, {}, { requestPolicy: 'network-only' }).toPromise();
    if (!me.data?.me?.canManageEntityAccess) {
      setAllowed(false);
      setRecord(null);
      return;
    }
    setAllowed(true);
    const result = await graphqlClient.query(ENTITY_ACCESS_QUERY, { entityId }, { requestPolicy: 'network-only' }).toPromise();
    setRecord(result.data?.entityAccess ?? null);
  }, [entityId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!allowed || !record) return null;

  return (
    <div className="rail-card">
      <div className="rail-head">Who can open this</div>
      <EntityRoleAccess
        compact
        clientId={record.clientId}
        entityId={record.entityId}
        entityName={record.entityName}
        domainCode={record.domainCode}
        restricted={record.restricted}
        grants={record.grants}
        onChanged={load}
      />
    </div>
  );
}
