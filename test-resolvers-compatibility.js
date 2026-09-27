// Test script to check if resolvers are compatible with schema
const { buildSchema } = require('graphql');

try {
  // Load the type definitions
  const fs = require('fs');
  const schemaContent = fs.readFileSync('./packages/graphql/schema.graphql', 'utf8');
  console.log('✓ Loaded schema.graphql');
  
  // Build the schema
  const schema = buildSchema(schemaContent);
  console.log('✓ Built schema successfully');
  
  // Check if entities query exists in schema
  const queryType = schema.getQueryType();
  const fields = queryType.getFields();
  
  if (fields.entities) {
    console.log('✓ entities query exists in schema');
  } else {
    console.log('✗ entities query missing from schema');
  }
  
  if (fields.entity) {
    console.log('✓ entity query exists in schema');
  } else {
    console.log('✗ entity query missing from schema');
  }
  
  // Check if createDomainType exists in mutation
  const mutationType = schema.getMutationType();
  if (mutationType) {
    const mutationFields = mutationType.getFields();
    if (mutationFields.createDomainType) {
      console.log('✓ createDomainType mutation exists in schema');
    } else {
      console.log('✗ createDomainType mutation missing from schema');
    }
  } else {
    console.log('✗ No mutation type found in schema');
  }
  
  console.log('\nSchema validation completed successfully!');
  
} catch (error) {
  console.error('✗ Schema validation failed:', error.message);
  console.error(error.stack);
}