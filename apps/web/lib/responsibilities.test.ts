import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coverageLabel,
  draftInput,
  draftProblem,
  emptyDraft,
  groupResponsibilities,
  holderLabel,
  type Responsibility,
} from './responsibilities';

function row(patch: Partial<Responsibility>): Responsibility {
  return {
    id: 'r-1',
    clientId: 'c-1',
    subjectType: 'ENTITY',
    entityId: 'e-1',
    entityName: 'Halyard II',
    domainCode: 'FUND',
    includeChildren: true,
    activityCode: null,
    activityName: null,
    userId: 'u-1',
    userName: 'Ana',
    roleCode: null,
    roleName: null,
    isBackup: false,
    note: null,
    isMine: false,
    canManage: true,
    createdAt: null,
    ...patch,
  };
}

describe('responsibilities', () => {
  it('names the person or the role', () => {
    assert.equal(holderLabel(row({})), 'Ana');
    assert.equal(holderLabel(row({ userId: null, userName: null, roleCode: 'OPS_LEAD', roleName: 'Operations lead' })), 'Anyone with the role Operations lead');
  });

  it('says what a row covers', () => {
    assert.equal(coverageLabel(row({})), 'Every activity · this record and the records under it');
    assert.equal(coverageLabel(row({ includeChildren: false, activityName: 'Reconciliation' })), 'Reconciliation · this record only');
    assert.equal(coverageLabel(row({ subjectType: 'DOMAIN', activityName: 'Data quality' })), 'Data quality');
  });

  it('groups by subject, domains first, backups last', () => {
    const groups = groupResponsibilities([
      row({ id: 'a', isBackup: true, userName: 'Zed' }),
      row({ id: 'b', userName: 'Ana' }),
      row({ id: 'c', subjectType: 'DOMAIN', entityId: null, entityName: null, domainCode: 'ISSUER' }),
      row({ id: 'd', entityId: 'e-2', entityName: 'Brightwater III' }),
    ]);
    assert.deepEqual(groups.map((group) => group.title), ['Every ISSUER', 'Brightwater III', 'Halyard II']);
    assert.deepEqual(groups[2].rows.map((entry) => entry.id), ['b', 'a']);
  });

  it('checks a draft and builds its input', () => {
    const draft = emptyDraft();
    assert.match(draftProblem(draft) || '', /record/);
    draft.entityId = 'e-1';
    assert.match(draftProblem(draft) || '', /person/);
    draft.userId = 'u-1';
    assert.equal(draftProblem(draft), null);
    assert.deepEqual(draftInput(draft, 'c-1'), {
      subjectType: 'ENTITY',
      entityId: 'e-1',
      domainCode: null,
      activityCode: null,
      userId: 'u-1',
      roleCode: null,
      isBackup: false,
      includeChildren: true,
      note: null,
      clientId: null,
    });
    const domain = draftInput({ ...draft, subjectType: 'DOMAIN', domainCode: 'ISSUER', holderKind: 'ROLE', roleCode: 'OPS_LEAD', includeChildren: false, note: ' covers leave ' }, 'c-1');
    assert.deepEqual(
      { entityId: domain.entityId, domainCode: domain.domainCode, userId: domain.userId, roleCode: domain.roleCode, includeChildren: domain.includeChildren, note: domain.note, clientId: domain.clientId },
      { entityId: null, domainCode: 'ISSUER', userId: null, roleCode: 'OPS_LEAD', includeChildren: true, note: 'covers leave', clientId: 'c-1' },
    );
  });
});
