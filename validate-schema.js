const fs = require('fs');
const { buildSchema } = require('graphql');

try {
  // Read the combined schema file
  const schemaContent = fs.readFileSync('./packages/graphql/schema.graphql', 'utf8');
  
  console.log('Attempting to build schema...');
  const schema = buildSchema(schemaContent);
  console.log('✓ Schema is valid!');
} catch (error) {
  console.error('✗ Schema validation error:', error.message);
  console.error('Error location:', error.locations);
}