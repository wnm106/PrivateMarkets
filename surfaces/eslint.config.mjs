// Import boundary for client surfaces: a surface may use React, the surface SDK,
// the design system, and its own files. Nothing from the host app.
import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@/*'], message: 'Surfaces must not import host code. Use @tapestrai/surface-sdk.' },
            { group: ['**/apps/**', '@tapestrai/graphql', '@tapestrai/database', '@tapestrai/mcp-server'], message: 'Reach the platform only through @tapestrai/surface-sdk.' },
            { group: ['@surfaces/*', '../../*'], message: 'A surface must not import another surface or reach outside its own folder.' },
          ],
        },
      ],
    },
  },
];
