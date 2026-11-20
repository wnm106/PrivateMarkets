import { describe, expect, it } from 'vitest';
import { GraphQLError, type GraphQLResolveInfo } from 'graphql';
// @graphql-tools builds the schema with the CommonJS graphql build. Under vitest a
// plain 'graphql' import is the ESM build, a second copy that rejects the schema.
import { graphql } from 'graphql/index.js';
import { createSchema } from '../schema';
import { PUBLIC_ROOT_FIELDS } from './auth-guard';
import { fakeSupabase } from '../testing/fake-supabase';

const schema = createSchema();

function signedOut() {
  const { client, calls } = fakeSupabase();
  return { context: { supabase: client, supabaseAdmin: null, user: null, requestId: 'test', loaders: {} as any }, calls };
}

function signedIn() {
  const { client, calls } = fakeSupabase();
  return {
    context: { supabase: client, supabaseAdmin: null, user: { id: 'user-1', email: 'a@example.com', role: 'readonly' as const }, requestId: 'test', loaders: {} as any },
    calls,
  };
}

describe('signed-in guard on root fields', () => {
  it('allows exactly the workflow portal fields without a session', () => {
    expect([...PUBLIC_ROOT_FIELDS.Query]).toEqual(['workflowPortalForm']);
    expect([...PUBLIC_ROOT_FIELDS.Mutation]).toEqual(['submitWorkflowPortalForm']);
    expect([...PUBLIC_ROOT_FIELDS.Subscription]).toEqual([]);
  });

  it('refuses every other Query and Mutation field before its resolver runs', () => {
    const { context, calls } = signedOut();
    const roots = [schema.getQueryType(), schema.getMutationType()];
    let checked = 0;
    for (const root of roots) {
      const publicFields = root === schema.getQueryType() ? PUBLIC_ROOT_FIELDS.Query : PUBLIC_ROOT_FIELDS.Mutation;
      for (const field of Object.values(root!.getFields())) {
        if (publicFields.has(field.name)) continue;
        let thrown: unknown = null;
        try {
          void field.resolve!(undefined, {}, context, {} as GraphQLResolveInfo);
        } catch (error) {
          thrown = error;
        }
        expect(thrown, `${root!.name}.${field.name}`).toBeInstanceOf(GraphQLError);
        expect((thrown as GraphQLError).extensions.code).toBe('UNAUTHENTICATED');
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(calls).toHaveLength(0);
  });

  it('answers a signed-out query with UNAUTHENTICATED and no data', async () => {
    const { context, calls } = signedOut();
    const result = await graphql({ schema, source: '{ me { id } }', contextValue: context });
    expect(result.data).toBeNull();
    expect(result.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
    expect(calls).toHaveLength(0);
  });

  it('refuses a signed-out mutation', async () => {
    const { context, calls } = signedOut();
    const result = await graphql({
      schema,
      source: 'mutation { scoreDealCompliance(dealId: "d1") { errors { message } } }',
      contextValue: context,
    });
    expect(result.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
    expect(calls).toHaveLength(0);
  });

  it('still serves the portal form and its submit to a visitor with a link', async () => {
    const { context } = signedOut();
    const form = await graphql({ schema, source: '{ workflowPortalForm(token: "not-a-token") }', contextValue: context });
    expect(form.errors).toBeUndefined();
    expect(form.data).toEqual({ workflowPortalForm: null });

    const submit = await graphql({
      schema,
      source: 'mutation { submitWorkflowPortalForm(token: "not-a-token", outcome: "APPROVE") { success errors { code } } }',
      contextValue: context,
    });
    expect(submit.errors).toBeUndefined();
    expect(submit.data).toEqual({ submitWorkflowPortalForm: { success: false, errors: [{ code: 'NOT_FOUND' }] } });
  });

  it('runs the resolver for a signed-in caller', async () => {
    const { context } = signedIn();
    const result = await graphql({ schema, source: '{ workflowStageScreens { code } }', contextValue: context });
    expect(result.errors).toBeUndefined();
    expect((result.data as any).workflowStageScreens.length).toBeGreaterThan(0);
  });
});
