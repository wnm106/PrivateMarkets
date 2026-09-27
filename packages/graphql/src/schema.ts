import { makeExecutableSchema } from '@graphql-tools/schema';
import { resolvers } from './resolvers';
import { typeDefs } from './schema/typeDefs';

export function createSchema() {
  return makeExecutableSchema({
    typeDefs,
    resolvers,
  });
}

export const schema = createSchema();
