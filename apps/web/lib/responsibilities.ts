/**
 * Who must act on a record or a domain. The queries, and the pure helpers the
 * Responsibilities page uses to group and describe what it shows.
 */

export interface Responsibility {
  id: string;
  clientId: string;
  subjectType: 'ENTITY' | 'DOMAIN' | string;
  entityId: string | null;
  entityName: string | null;
  domainCode: string | null;
  includeChildren: boolean;
  activityCode: string | null;
  activityName: string | null;
  userId: string | null;
  userName: string | null;
  roleCode: string | null;
  roleName: string | null;
  isBackup: boolean;
  note: string | null;
  isMine: boolean;
  canManage: boolean;
  createdAt: string | null;
}

export interface ResponsibilityChoices {
  clientId: string | null;
  canManage: boolean;
  people: Array<{ id: string; name: string }>;
  roles: Array<{ code: string; name: string }>;
  activities: Array<{ code: string; name: string; description?: string | null }>;
}

export const RESPONSIBILITY_FIELDS = `
  id clientId subjectType entityId entityName domainCode includeChildren activityCode activityName
  userId userName roleCode roleName isBackup note isMine canManage createdAt
`;

export const RESPONSIBILITIES_QUERY = `
  query Responsibilities($entityId: ID, $domainCode: String, $mine: Boolean) {
    responsibilities(entityId: $entityId, domainCode: $domainCode, mine: $mine) { ${RESPONSIBILITY_FIELDS} }
    responsibilityChoices { clientId canManage people roles activities }
  }
`;

export const RESPONSIBILITY_CHOICES_QUERY = `
  query ResponsibilityChoices($clientId: ID) { responsibilityChoices(clientId: $clientId) { clientId canManage people roles activities } }
`;

export const SAVE_RESPONSIBILITY = `
  mutation SaveResponsibility($input: SaveResponsibilityInput!) {
    saveResponsibility(input: $input) { responsibility { ${RESPONSIBILITY_FIELDS} } errors { field message code } }
  }
`;

export const DELETE_RESPONSIBILITY = `
  mutation DeleteResponsibility($id: ID!) { deleteResponsibility(id: $id) { success errors { field message code } } }
`;

/** Everything said about one record or one domain. */
export interface ResponsibilityGroup {
  key: string;
  subjectType: string;
  title: string;
  /** The domain of a record, shown beside its name. */
  detail: string | null;
  entityId: string | null;
  domainCode: string | null;
  rows: Responsibility[];
}

/** The person or the role a row names. */
export function holderLabel(row: Pick<Responsibility, 'userId' | 'userName' | 'roleCode' | 'roleName'>): string {
  if (row.userId) return row.userName || 'Unnamed person';
  return `Anyone with the role ${row.roleName || row.roleCode || 'unknown'}`;
}

/** What a row covers, in a few words. */
export function coverageLabel(row: Pick<Responsibility, 'subjectType' | 'includeChildren' | 'activityName' | 'activityCode'>): string {
  const activity = row.activityName || row.activityCode || 'Every activity';
  if (row.subjectType === 'DOMAIN') return activity;
  return `${activity} · ${row.includeChildren ? 'this record and the records under it' : 'this record only'}`;
}

/** Domains first, then records, each by name. Within a group, backups come last. */
export function groupResponsibilities(rows: readonly Responsibility[]): ResponsibilityGroup[] {
  const groups = new Map<string, ResponsibilityGroup>();
  for (const row of rows) {
    const domain = row.subjectType === 'DOMAIN';
    const key = domain ? `domain:${row.domainCode || ''}` : `entity:${row.entityId || ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        subjectType: row.subjectType,
        title: domain ? `Every ${row.domainCode || 'record'}` : row.entityName || 'A record',
        detail: domain ? null : row.domainCode,
        entityId: domain ? null : row.entityId,
        domainCode: row.domainCode,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.rows.sort(
      (a, b) =>
        Number(a.isBackup) - Number(b.isBackup) ||
        (a.activityName || '').localeCompare(b.activityName || '') ||
        holderLabel(a).localeCompare(holderLabel(b)),
    );
  }
  return result.sort((a, b) => {
    if (a.subjectType !== b.subjectType) return a.subjectType === 'DOMAIN' ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

export interface ResponsibilityDraft {
  subjectType: 'ENTITY' | 'DOMAIN';
  entityId: string;
  entityName: string;
  domainCode: string;
  activityCode: string;
  holderKind: 'PERSON' | 'ROLE';
  userId: string;
  roleCode: string;
  isBackup: boolean;
  includeChildren: boolean;
  note: string;
}

export function emptyDraft(): ResponsibilityDraft {
  return {
    subjectType: 'ENTITY',
    entityId: '',
    entityName: '',
    domainCode: '',
    activityCode: '',
    holderKind: 'PERSON',
    userId: '',
    roleCode: '',
    isBackup: false,
    includeChildren: true,
    note: '',
  };
}

/** Why a draft cannot be saved yet, or null when it can. */
export function draftProblem(draft: ResponsibilityDraft): string | null {
  if (draft.subjectType === 'ENTITY' && !draft.entityId) return 'Search for the record this is about and choose it.';
  if (draft.subjectType === 'DOMAIN' && !draft.domainCode) return 'Choose the domain this is about.';
  if (draft.holderKind === 'PERSON' && !draft.userId) return 'Choose the person who is responsible.';
  if (draft.holderKind === 'ROLE' && !draft.roleCode) return 'Choose the role that is responsible.';
  return null;
}

/** The mutation input for a draft. */
export function draftInput(draft: ResponsibilityDraft, clientId: string | null) {
  const entity = draft.subjectType === 'ENTITY';
  return {
    subjectType: draft.subjectType,
    entityId: entity ? draft.entityId : null,
    domainCode: entity ? null : draft.domainCode,
    activityCode: draft.activityCode || null,
    userId: draft.holderKind === 'PERSON' ? draft.userId : null,
    roleCode: draft.holderKind === 'ROLE' ? draft.roleCode : null,
    isBackup: draft.isBackup,
    includeChildren: entity ? draft.includeChildren : true,
    note: draft.note.trim() || null,
    clientId: entity ? null : clientId,
  };
}
