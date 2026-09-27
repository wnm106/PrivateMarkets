const { buildSchema } = require('graphql');

// Read the typeDefs from the generated file
const { typeDefs } = require('./packages/graphql/src/schema/typeDefs');

console.log('Testing GraphQL schema validity...');

try {
  console.log('About to build schema...');
  const schema = buildSchema(typeDefs);
  console.log('✓ Schema is valid!');
} catch (error) {
  console.error('✗ Schema validation error:', error.message);
  console.error('Error locations:', error.locations);
  console.error('Stack trace:', error.stack);
}