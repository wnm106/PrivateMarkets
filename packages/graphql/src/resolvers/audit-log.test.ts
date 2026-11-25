import { describe, expect, it } from 'vitest';
import { auditLogParams } from './audit-log';

describe('auditLogParams', () => {
  it('leaves blank filters out and defaults the page size', () => {
    expect(auditLogParams({ kind: ' ', search: '', table: null })).toEqual({
      p_kind: null,
      p_from: null,
      p_to: null,
      p_table: null,
      p_actor_user_id: null,
      p_row_id: null,
      p_search: null,
      p_limit: 100,
      p_before_id: null,
    });
  });

  it('passes filters through, kind in lower case', () => {
    const params = auditLogParams({ kind: 'Configuration', table: 'compliance.rules', beforeId: '42', limit: 25 });
    expect(params.p_kind).toBe('configuration');
    expect(params.p_table).toBe('compliance.rules');
    expect(params.p_before_id).toBe('42');
    expect(params.p_limit).toBe(25);
  });

  it('refuses an unknown kind or a page cursor that is not an id', () => {
    expect(() => auditLogParams({ kind: 'everything' })).toThrow('kind is access or configuration');
    expect(() => auditLogParams({ beforeId: '1; drop' })).toThrow('beforeId');
  });
});
