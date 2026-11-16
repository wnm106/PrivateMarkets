export interface ComplianceFundNode {
  fundId: string;
  level: string;
}

export interface ComplianceResultRef {
  anchorEntityId: string;
}

export function descendantIds(fundId: string, childrenOf: Map<string, Array<{ fundId: string }>>): string[] {
  const ids: string[] = [];
  const walk = (id: string) => {
    for (const child of childrenOf.get(id) || []) {
      ids.push(child.fundId);
      walk(child.fundId);
    }
  };
  walk(fundId);
  return ids;
}

/**
 * Show the fund's own score for a rule. When a limit is assigned only on a
 * sleeve, and the portfolio has no score for that rule, show the sleeve score.
 */
export function resultsForAssignedRules<T extends ComplianceResultRef & { ruleId: string }>(
  fundId: string,
  byFund: Map<string, T[]>,
  childrenOf: Map<string, Array<{ fundId: string }>>,
): T[] {
  const own = byFund.get(fundId) || [];
  const covered = new Set(own.map((row) => row.ruleId));
  const extra: T[] = [];
  for (const id of descendantIds(fundId, childrenOf)) {
    for (const row of byFund.get(id) || []) {
      if (!covered.has(row.ruleId)) extra.push(row);
    }
  }
  return [...own, ...extra];
}

/**
 * A portfolio often has no positions of its own: the proposed allocation is
 * written on its sleeves. Show the portfolio score when it has one, and the
 * sleeve scores when the portfolio row is empty.
 */
export function resultsForFund<T extends ComplianceResultRef>(
  fundId: string,
  byFund: Map<string, T[]>,
  childrenOf: Map<string, Array<{ fundId: string }>>,
): T[] {
  const own = byFund.get(fundId) || [];
  if (own.length) return own;
  return descendantIds(fundId, childrenOf).flatMap((id) => byFund.get(id) || []);
}

/**
 * Count a portfolio score once. When the portfolio row already includes its
 * sleeves, the sleeve rows are the same exposure a second time.
 */
export function dealCheckResults<T extends ComplianceResultRef>(
  funds: ComplianceFundNode[],
  byFund: Map<string, T[]>,
  childrenOf: Map<string, Array<{ fundId: string }>>,
): T[] {
  const covered = new Set<string>();
  const rows: T[] = [];
  for (const fund of funds) {
    if (fund.level !== 'PORTFOLIO') continue;
    const own = byFund.get(fund.fundId) || [];
    if (!own.length) continue;
    rows.push(...own);
    for (const id of descendantIds(fund.fundId, childrenOf)) covered.add(id);
  }
  for (const fund of funds) {
    if (fund.level === 'PORTFOLIO' || covered.has(fund.fundId)) continue;
    rows.push(...(byFund.get(fund.fundId) || []));
  }
  return rows;
}
