import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
// The CommonJS build: the same graphql copy @graphql-tools uses under vitest.
import { Kind, buildSchema, getIntrospectionQuery, parse, specifiedRules, validate } from 'graphql/index.js';
import { QUERY_LIMITS, measureSelections, queryLimitsRule } from './query-limits';
import { createSchema } from '../schema';

const tree = buildSchema(`
  type Query { node: Node }
  type Node { id: ID name: String child: Node }
`);

function nested(levels: number): string {
  let body = 'id';
  for (let index = 1; index < levels; index += 1) body = `child { ${body} }`;
  return `query Deep { node { ${body} } }`;
}

function errorsFor(schema: Parameters<typeof validate>[0], source: string) {
  return validate(schema, parse(source), [...specifiedRules, queryLimitsRule()]).map((error) => error.extensions.code ?? error.message);
}

describe('query depth and alias limits', () => {
  it('passes a query at the depth limit and refuses one level more', () => {
    // node is level 1, so `levels` children plus the leaf reach levels + 1.
    expect(errorsFor(tree, nested(QUERY_LIMITS.maxDepth - 1))).toEqual([]);
    expect(errorsFor(tree, nested(QUERY_LIMITS.maxDepth))).toEqual(['QUERY_TOO_DEEP']);
  });

  it('counts depth through fragments and inline fragments', () => {
    const inner = Array.from({ length: QUERY_LIMITS.maxDepth }, () => 'child {').join(' ') + ' id ' + '}'.repeat(QUERY_LIMITS.maxDepth);
    const source = `query { node { ...F } } fragment F on Node { ... on Node { ${inner} } }`;
    expect(errorsFor(tree, source)).toEqual(['QUERY_TOO_DEEP']);
  });

  it('refuses more aliases than the limit, counting a fragment once per spread', () => {
    const aliases = (count: number) => Array.from({ length: count }, (_, index) => `a${index}: id`).join(' ');
    expect(errorsFor(tree, `query { node { ${aliases(QUERY_LIMITS.maxAliases)} } }`)).toEqual([]);
    expect(errorsFor(tree, `query { node { ${aliases(QUERY_LIMITS.maxAliases + 1)} } }`)).toEqual(['TOO_MANY_ALIASES']);
    const spreads = Array.from({ length: 4 }, (_, index) => `n${index}: node { ...F }`).join(' ');
    expect(errorsFor(tree, `query { ${spreads} } fragment F on Node { ${aliases(7)} }`)).toEqual(['TOO_MANY_ALIASES']);
  });

  it('measures a fragment once however often it is spread', () => {
    // Each fragment spreads the next one twice: 2^40 paths if walked naively.
    const parts = ['query { node { ...F0 } }'];
    for (let index = 0; index < 40; index += 1) parts.push(`fragment F${index} on Node { x${index}: id ...F${index + 1} ...F${index + 1} }`);
    parts.push('fragment F40 on Node { id }');
    const document = parse(parts.join('\n'));
    const fragments = new Map(document.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((d: any) => [d.name.value, d]));
    const operation = document.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION) as any;
    const started = Date.now();
    const found = measureSelections(operation.selectionSet, (name) => fragments.get(name));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(found.aliases).toBeGreaterThan(QUERY_LIMITS.maxAliases);
  });

  it('lets the standard introspection query through', () => {
    expect(errorsFor(createSchema(), getIntrospectionQuery())).toEqual([]);
  });

  it('passes every GraphQL operation the web app sends', () => {
    const root = join(__dirname, '..', '..', '..', '..', 'apps', 'web');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
      }
    };
    for (const dir of ['app', 'components', 'lib']) walk(join(root, dir));

    let operations = 0;
    const over: string[] = [];
    for (const file of files) {
      let source = readFileSync(file, 'utf8');
      // Field lists kept in constants of the same file are pasted in, as the template literal does at run time.
      const constants = new Map<string, string>();
      for (const match of source.matchAll(/const ([A-Za-z0-9_]+)\s*=\s*(?:`([^`]*)`|'([^'\n]*)'|"([^"\n]*)")/g)) {
        constants.set(match[1], match[2] ?? match[3] ?? match[4]);
      }
      for (let pass = 0; pass < 4; pass += 1) {
        source = source.replace(/\$\{([A-Za-z0-9_]+)\}/g, (all, name) => constants.get(name) ?? all);
      }
      for (const match of source.matchAll(/`(\s*(?:query|mutation)\b[^`]*)`/g)) {
        let document;
        try {
          document = parse(match[1].replace(/\$\{[^}]*\}/g, ''));
        } catch {
          continue;
        }
        const fragments = new Map(document.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((d: any) => [d.name.value, d]));
        for (const definition of document.definitions) {
          if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
          operations += 1;
          const found = measureSelections(definition.selectionSet, (name) => fragments.get(name));
          if (found.depth > QUERY_LIMITS.maxDepth || found.aliases > QUERY_LIMITS.maxAliases) {
            over.push(`${relative(root, file)} ${definition.name?.value ?? '(anonymous)'}: depth ${found.depth}, aliases ${found.aliases}`);
          }
        }
      }
    }
    expect(operations).toBeGreaterThan(200);
    expect(over).toEqual([]);
  });
});
