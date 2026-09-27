/**
 * Relationship Graph Analyzer & Import Sequencer
 * Analyzes entity relationships and determines import order via topological sort
 */

import { SupabaseClient } from '@supabase/supabase-js';

export interface DomainDependency {
  parentDomain: string;
  childDomain: string;
  relationshipCode: string;
  relationshipName: string;
  cardinality: string;
}

export interface ImportPlan {
  /** Ordered list of domain codes to import (parents first) */
  importOrder: string[];
  /** Dependency graph edges */
  dependencies: DomainDependency[];
  /** Domains that can be imported in parallel (no cross-dependencies) */
  parallelGroups: string[][];
  /** Circular dependency warnings */
  circularDependencies: string[][];
  /** Domains not in the import set but referenced as parents */
  missingParents: string[];
}

export interface ImportBatch {
  /** Sequential batch number (0 = first) */
  batchNumber: number;
  /** Domain codes that can be imported in this batch */
  domains: string[];
  /** Whether this batch can run in parallel */
  canParallelize: boolean;
}

/**
 * Analyze relationships between a set of domain codes to build a dependency graph
 */
export async function analyzeRelationships(
  domainCodes: string[],
  supabase: SupabaseClient
): Promise<{
  dependencies: DomainDependency[];
  adjacencyList: Map<string, Set<string>>;
}> {
  // Fetch all relationship types
  const { data: relationshipTypes, error } = await supabase
    .from('relationship_types')
    .select('*')
    .eq('is_active', true);

  if (error) throw error;

  const domainSet = new Set(domainCodes.map(d => d.toUpperCase()));
  const dependencies: DomainDependency[] = [];
  const adjacencyList = new Map<string, Set<string>>();

  // Initialize adjacency list
  for (const domain of domainCodes) {
    adjacencyList.set(domain.toUpperCase(), new Set());
  }

  // Build dependency graph from relationship types
  for (const relType of relationshipTypes || []) {
    const parentDomain = relType.parent_domain_code?.toUpperCase();
    const childDomain = relType.child_domain_code?.toUpperCase();

    if (!parentDomain || !childDomain) continue;

    // Only include relationships where both domains are in our import set
    if (domainSet.has(parentDomain) && domainSet.has(childDomain) && parentDomain !== childDomain) {
      dependencies.push({
        parentDomain,
        childDomain,
        relationshipCode: relType.relationship_code,
        relationshipName: relType.relationship_name,
        cardinality: relType.cardinality || 'ONE_TO_ONE',
      });

      // child depends on parent (parent must be imported first)
      adjacencyList.get(childDomain)?.add(parentDomain);
    }
  }

  return { dependencies, adjacencyList };
}

/**
 * Topological sort using Kahn's algorithm
 * Returns domains in import order (parents first)
 */
export function topologicalSort(
  domainCodes: string[],
  adjacencyList: Map<string, Set<string>>
): {
  sorted: string[];
  hasCycle: boolean;
  cycleNodes: string[];
} {
  const normalizedCodes = domainCodes.map(d => d.toUpperCase());
  const inDegree = new Map<string, number>();
  const reverseAdj = new Map<string, Set<string>>();

  // Initialize
  for (const domain of normalizedCodes) {
    inDegree.set(domain, 0);
    reverseAdj.set(domain, new Set());
  }

  // Calculate in-degrees (how many domains depend on each domain as parent)
  for (const [domain, parents] of adjacencyList.entries()) {
    if (!normalizedCodes.includes(domain)) continue;
    
    for (const parent of parents) {
      if (!normalizedCodes.includes(parent)) continue;
      
      // domain depends on parent, so parent has an outgoing edge to domain
      reverseAdj.get(parent)?.add(domain);
      inDegree.set(domain, (inDegree.get(domain) || 0) + 1);
    }
  }

  // Start with nodes that have no dependencies (in-degree 0)
  const queue: string[] = [];
  for (const [domain, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(domain);
    }
  }

  // Sort queue for deterministic output
  queue.sort();

  const sorted: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);

    // For each domain that depends on current
    const dependents = reverseAdj.get(current) || new Set();
    for (const dependent of dependents) {
      const newDegree = (inDegree.get(dependent) || 0) - 1;
      inDegree.set(dependent, newDegree);

      if (newDegree === 0) {
        queue.push(dependent);
        queue.sort(); // Keep deterministic
      }
    }
  }

  // Check for cycles
  const hasCycle = sorted.length < normalizedCodes.length;
  const cycleNodes = normalizedCodes.filter(d => !sorted.includes(d));

  return { sorted, hasCycle, cycleNodes };
}

/**
 * Generate a complete import plan with parallelization groups
 */
export async function generateImportPlan(
  domainCodes: string[],
  supabase: SupabaseClient
): Promise<ImportPlan> {
  const { dependencies, adjacencyList } = await analyzeRelationships(domainCodes, supabase);

  // Topological sort
  const { sorted, hasCycle, cycleNodes } = topologicalSort(domainCodes, adjacencyList);

  // Detect circular dependencies
  const circularDependencies: string[][] = [];
  if (hasCycle) {
    // Trace cycles through the adjacency list
    const visited = new Set<string>();
    const inStack = new Set<string>();

    for (const node of cycleNodes) {
      if (!visited.has(node)) {
        const cycle = findCycle(node, adjacencyList, visited, inStack);
        if (cycle.length > 0) {
          circularDependencies.push(cycle);
        }
      }
    }
  }

  // Build parallel groups (domains at the same "level" can run in parallel)
  const parallelGroups = buildParallelGroups(sorted, adjacencyList);

  // Find missing parent domains (referenced but not in import set)
  const domainSet = new Set(domainCodes.map(d => d.toUpperCase()));
  const missingParents = new Set<string>();
  for (const dep of dependencies) {
    if (!domainSet.has(dep.parentDomain)) {
      missingParents.add(dep.parentDomain);
    }
  }

  return {
    importOrder: sorted,
    dependencies,
    parallelGroups,
    circularDependencies,
    missingParents: Array.from(missingParents),
  };
}

/**
 * Build parallel execution groups from sorted domains
 * Domains at the same depth level can be imported in parallel
 */
function buildParallelGroups(
  sortedDomains: string[],
  adjacencyList: Map<string, Set<string>>
): string[][] {
  if (sortedDomains.length === 0) return [];

  const depth = new Map<string, number>();

  // Calculate depth for each domain (longest path from a root)
  for (const domain of sortedDomains) {
    const parents = adjacencyList.get(domain) || new Set();
    let maxParentDepth = -1;

    for (const parent of parents) {
      const parentDepth = depth.get(parent);
      if (parentDepth !== undefined && parentDepth > maxParentDepth) {
        maxParentDepth = parentDepth;
      }
    }

    depth.set(domain, maxParentDepth + 1);
  }

  // Group domains by depth
  const maxDepth = Math.max(...Array.from(depth.values()));
  const groups: string[][] = [];

  for (let d = 0; d <= maxDepth; d++) {
    const group = sortedDomains.filter(domain => depth.get(domain) === d);
    if (group.length > 0) {
      groups.push(group);
    }
  }

  return groups;
}

/**
 * Find a cycle starting from a given node using DFS
 */
function findCycle(
  startNode: string,
  adjacencyList: Map<string, Set<string>>,
  visited: Set<string>,
  inStack: Set<string>
): string[] {
  const path: string[] = [];
  const pathSet = new Set<string>();

  function dfs(node: string): boolean {
    if (inStack.has(node)) {
      // Found cycle - extract it
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        path.push(node);
        return true;
      }
      return false;
    }

    if (visited.has(node)) return false;

    visited.add(node);
    inStack.add(node);
    path.push(node);
    pathSet.add(node);

    const neighbors = adjacencyList.get(node) || new Set();
    for (const neighbor of neighbors) {
      if (pathSet.has(neighbor) || dfs(neighbor)) {
        return true;
      }
    }

    path.pop();
    pathSet.delete(node);
    inStack.delete(node);
    return false;
  }

  dfs(startNode);

  // Extract cycle from path
  if (path.length > 1) {
    const lastNode = path[path.length - 1];
    const cycleStart = path.indexOf(lastNode, 0);
    if (cycleStart >= 0 && cycleStart < path.length - 1) {
      return path.slice(cycleStart);
    }
  }

  return [];
}

/**
 * Convert import plan to execution batches
 */
export function planToBatches(plan: ImportPlan): ImportBatch[] {
  return plan.parallelGroups.map((domains, index) => ({
    batchNumber: index,
    domains,
    canParallelize: domains.length > 1,
  }));
}

/**
 * Validate that an import plan is executable
 */
export function validateImportPlan(plan: ImportPlan): {
  isValid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for circular dependencies
  if (plan.circularDependencies.length > 0) {
    for (const cycle of plan.circularDependencies) {
      errors.push(
        `Circular dependency detected: ${cycle.join(' → ')}. ` +
        `Break the cycle by removing a relationship or importing in stages.`
      );
    }
  }

  // Warn about missing parent domains
  if (plan.missingParents.length > 0) {
    warnings.push(
      `Missing parent domain(s): ${plan.missingParents.join(', ')}. ` +
      `These domains are referenced as parents but not included in the import. ` +
      `Ensure they exist in the system before importing.`
    );
  }

  // Check for isolated domains (no relationships)
  const relatedDomainss = new Set<string>();
  for (const dep of plan.dependencies) {
    relatedDomainss.add(dep.parentDomain);
    relatedDomainss.add(dep.childDomain);
  }

  const allDomains = new Set(plan.importOrder.map(d => d.toUpperCase()));
  const isolatedDomains = Array.from(allDomains).filter(d => !relatedDomainss.has(d));
  
  if (isolatedDomains.length > 0) {
    warnings.push(
      `Domain(s) with no relationships: ${isolatedDomains.join(', ')}. ` +
      `These can be imported in any order.`
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}
