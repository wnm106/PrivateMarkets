/**
 * Every root field needs a signed-in caller unless it is listed here.
 *
 * Resolvers still check their own rights. This guard is the floor beneath them:
 * a resolver that forgets to check `context.user` still cannot run for a request
 * with no valid Bearer token.
 */

import { GraphQLError, defaultFieldResolver, type GraphQLFieldConfig, type GraphQLSchema } from 'graphql';
import { MapperKind, mapSchema } from '@graphql-tools/utils';

/**
 * Root fields a signed-out caller may use, by operation.
 *
 * The workflow portal (/portal/<token>) is opened by people outside the client,
 * with no account. The token in the link is the credential, and the database
 * functions behind these two fields check it.
 */
export const PUBLIC_ROOT_FIELDS = {
  Query: new Set(['workflowPortalForm']),
  Mutation: new Set(['submitWorkflowPortalForm']),
  Subscription: new Set<string>(),
} as const;

type Operation = keyof typeof PUBLIC_ROOT_FIELDS;

export function unauthenticatedError(): GraphQLError {
  return new GraphQLError('Sign in to continue.', { extensions: { code: 'UNAUTHENTICATED' } });
}

function assertSignedIn(context: unknown): void {
  const user = (context as { user?: { id?: string } | null } | null | undefined)?.user;
  if (!user || !user.id) throw unauthenticatedError();
}

function guarded(operation: Operation) {
  return (fieldConfig: GraphQLFieldConfig<any, any>, fieldName: string): GraphQLFieldConfig<any, any> => {
    if (PUBLIC_ROOT_FIELDS[operation].has(fieldName)) return fieldConfig;
    const resolve = fieldConfig.resolve ?? defaultFieldResolver;
    const next: GraphQLFieldConfig<any, any> = {
      ...fieldConfig,
      resolve: (source, args, context, info) => {
        assertSignedIn(context);
        return resolve(source, args, context, info);
      },
    };
    const subscribe = fieldConfig.subscribe;
    if (subscribe) {
      next.subscribe = (source, args, context, info) => {
        assertSignedIn(context);
        return subscribe(source, args, context, info);
      };
    }
    return next;
  };
}

/** Wraps every Query, Mutation and Subscription field so it refuses a request with no user. */
export function requireSignedIn(schema: GraphQLSchema): GraphQLSchema {
  return mapSchema(schema, {
    [MapperKind.QUERY_ROOT_FIELD]: guarded('Query'),
    [MapperKind.MUTATION_ROOT_FIELD]: guarded('Mutation'),
    [MapperKind.SUBSCRIPTION_ROOT_FIELD]: guarded('Subscription'),
  });
}
