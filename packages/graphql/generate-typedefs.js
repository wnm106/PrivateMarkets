const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, 'schema.graphql');
const schema = fs.readFileSync(schemaPath, 'utf8');

const content = `// Auto-generated inlined schema for edge runtime compatibility
export const typeDefs = \`
${schema}
\`;
`;

fs.writeFileSync(path.join(__dirname, 'src', 'schema', 'typeDefs.ts'), content, 'utf8');
console.log('✅ Generated src/schema/typeDefs.ts');
