import { describe, expect, it } from 'vitest';
import { GraphQLError } from 'graphql';
import { maskGraphqlError, safeMessage } from './mask-errors';
import { DbError } from './db-result';

const wrap = (original: Error) => new GraphQLError(original.message, { originalError: original });

describe('what a caller is told', () => {
  it('passes a resolver message the page shows', () => {
    expect(maskGraphqlError(wrap(new Error('Deal not found')), 'Deal not found').message).toBe('Deal not found');
  });

  it('passes a message our database functions raise on purpose', () => {
    const raised = new DbError('P0001', 'Only a promoted batch can be reverted. This one is staged.');
    expect(maskGraphqlError(wrap(raised), raised.message).message).toBe('Only a promoted batch can be reverted. This one is staged.');
  });

  it('replaces the database text, keeping what it means', () => {
    const duplicate = new DbError('23505', 'duplicate key value violates unique constraint "master_entities_client_entity_code_key" Key (client_id, entity_code)=(…, B-FUND-1)');
    expect(maskGraphqlError(wrap(duplicate), duplicate.message).message).toBe('That already exists.');
    const denied = new DbError('42501', 'permission denied for table rule_versions');
    expect(maskGraphqlError(wrap(denied), denied.message).message).toBe('You do not have access to this.');
  });

  it('hides raw database text rethrown without its code, with a reference', () => {
    const raw = new Error('column "foo" does not exist');
    const masked = maskGraphqlError(wrap(raw), raw.message);
    expect(masked.message).toMatch(/could not be completed\. Reference [A-Z0-9]+\./);
    expect(masked.message).not.toMatch(/column/);
    expect(safeMessage(new Error('x'), 'relation "golden_master.entity_attribute_values" does not exist')).toBeNull();
  });

  it('leaves query validation errors as they are', () => {
    const invalid = new GraphQLError('Cannot query field "nope" on type "Query".');
    expect(maskGraphqlError(invalid, invalid.message)).toBe(invalid);
  });
});
