import { makeExecutableSchema } from '@graphql-tools/schema';
import { resolvers } from './resolvers';
import { typeDefs } from './schema/typeDefs';
import { requireSignedIn } from './lib/auth-guard';

export function createSchema() {
  // Every root field needs a signed-in user unless lib/auth-guard.ts lists it as public.
  return requireSignedIn(makeExecutableSchema({
    typeDefs,
    resolvers,
  }));
}

export const schema = createSchema();
