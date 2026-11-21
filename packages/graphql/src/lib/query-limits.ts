/**
 * Refuses a query that nests too deep or uses too many aliases, before it runs.
 *
 * The app's own deepest query (compliance rules with their versions, measure
 * lines and condition dimensions) is 7 levels; the most aliases any of its
 * queries uses is 4. The standard introspection query is 15 levels, and
 * introspection is measured on its own so tools that read the schema still work.
 */

import {
  GraphQLError,
  Kind,
  type ASTVisitor,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from 'graphql';

export interface QueryLimits {
  /** Deepest field below a root field, counting the root field as 1. */
  maxDepth: number;
  /** The same, inside __schema and __type. */
  maxIntrospectionDepth: number;
  /** Aliased fields in one operation, counting a fragment once per spread. */
  maxAliases: number;
}

export const QUERY_LIMITS: QueryLimits = { maxDepth: 12, maxIntrospectionDepth: 15, maxAliases: 30 };

interface Measure {
  depth: number;
  introspectionDepth: number;
  aliases: number;
}

export function measureSelections(
  selectionSet: SelectionSetNode,
  fragment: (name: string) => FragmentDefinitionNode | null | undefined,
): Measure {
  // A fragment's own measure does not depend on where it is spread, so each is walked
  // once. Spreading one fragment many times cannot make this check slow.
  const memo = new Map<string, Measure>();
  const walking = new Set<string>();

  const walk = (set: SelectionSetNode, depth: number, introspection: boolean): Measure => {
    const out: Measure = { depth: 0, introspectionDepth: 0, aliases: 0 };
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        if (selection.alias) out.aliases += 1;
        const inside = introspection || selection.name.value === '__schema' || selection.name.value === '__type';
        const here = depth + 1;
        if (inside) out.introspectionDepth = Math.max(out.introspectionDepth, here);
        else out.depth = Math.max(out.depth, here);
        if (selection.selectionSet) add(out, walk(selection.selectionSet, here, inside));
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        add(out, walk(selection.selectionSet, depth, introspection));
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const name = selection.name.value;
        const key = `${introspection ? 'i' : 'a'}:${name}`;
        let inner = memo.get(key);
        if (!inner) {
          const definition = fragment(name);
          // A missing or cyclic fragment is reported by the standard rules.
          if (!definition || walking.has(key)) continue;
          walking.add(key);
          inner = walk(definition.selectionSet, 0, introspection);
          walking.delete(key);
          memo.set(key, inner);
        }
        out.aliases += inner.aliases;
        if (inner.depth) out.depth = Math.max(out.depth, depth + inner.depth);
        if (inner.introspectionDepth) out.introspectionDepth = Math.max(out.introspectionDepth, depth + inner.introspectionDepth);
      }
    }
    return out;
  };

  return walk(selectionSet, 0, false);
}

function add(into: Measure, from: Measure) {
  into.depth = Math.max(into.depth, from.depth);
  into.introspectionDepth = Math.max(into.introspectionDepth, from.introspectionDepth);
  into.aliases += from.aliases;
}

export function queryLimitsRule(limits: QueryLimits = QUERY_LIMITS): ValidationRule {
  return (context: ValidationContext): ASTVisitor => ({
    OperationDefinition(node) {
      const found = measureSelections(node.selectionSet, (name) => context.getFragment(name));
      const name = node.name ? `"${node.name.value}"` : 'This operation';
      if (found.depth > limits.maxDepth) {
        context.reportError(new GraphQLError(
          `${name} nests fields ${found.depth} levels deep. The limit is ${limits.maxDepth}.`,
          { nodes: [node], extensions: { code: 'QUERY_TOO_DEEP' } },
        ));
      }
      if (found.introspectionDepth > limits.maxIntrospectionDepth) {
        context.reportError(new GraphQLError(
          `${name} nests schema fields ${found.introspectionDepth} levels deep. The limit is ${limits.maxIntrospectionDepth}.`,
          { nodes: [node], extensions: { code: 'QUERY_TOO_DEEP' } },
        ));
      }
      if (found.aliases > limits.maxAliases) {
        context.reportError(new GraphQLError(
          `${name} uses ${found.aliases} aliases. The limit is ${limits.maxAliases}.`,
          { nodes: [node], extensions: { code: 'TOO_MANY_ALIASES' } },
        ));
      }
    },
  });
}

/** Yoga plugin: adds the depth and alias rule to validation. Both GraphQL servers use it. */
export function useQueryLimits(limits: QueryLimits = QUERY_LIMITS) {
  const rule = queryLimitsRule(limits);
  return {
    onValidate({ addValidationRule }: { addValidationRule: (rule: ValidationRule) => void }) {
      addValidationRule(rule);
    },
  };
}
