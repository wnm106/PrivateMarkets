'use client';

import { useCallback, useEffect, useState } from 'react';
import { graphqlClient, ME_QUERY, ENTITY_ACCESS_QUERY } from '@/lib/graphql';
import { usePublishTab } from '@/lib/view-context';
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

/** Whether the signed-in person may set who can open records. Null until known. */
export function useCanManageEntityAccess(): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    graphqlClient.query(ME_QUERY, {}).toPromise().then((me) => {
      if (!cancelled) setAllowed(Boolean(me.data?.me?.canManageEntityAccess));
    }).catch(() => {
      if (!cancelled) setAllowed(false);
    });
    return () => { cancelled = true; };
  }, []);
  return allowed;
}

/**
 * Shown on an entity page to administrators, on its Access tab. Assigning a role closes the
 * entity, and every child under it, to everyone else in the client.
 */
export function EntityAccessPanel({ entityId, publishAs }: { entityId: string; /** Publishes the panel to the assistant as this tab. */ publishAs?: string }) {
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

  usePublishTab(publishAs || 'access', publishAs ? {
    label: 'Access',
    purpose: 'Who can open this record. Assigning a role closes the record, and every child under it, to everyone else in the client.',
    howToRead: 'restricted false means everyone in the client can open it. Each grant gives a role or a person READ or WRITE access; includeChildren means the grant covers the records under this one.',
    data: !record ? null : {
      restricted: record.restricted,
      grants: record.grants.map((grant) => ({
        grantee: grant.granteeLabel || grant.granteeType,
        granteeType: grant.granteeType,
        accessLevel: grant.accessLevel,
        includeChildren: grant.includeChildren,
      })),
    },
  } : null);

  if (!allowed || !record) return null;

  return (
    <div className={publishAs ? 'field-section entity-access-tab' : 'rail-card'}>
      <div className={publishAs ? 'field-section-head' : 'rail-head'}>
        {publishAs ? <div className="field-section-name">Who can open this</div> : 'Who can open this'}
      </div>
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
