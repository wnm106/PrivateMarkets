export interface FundThresholdEnrollment {
  ruleId: string;
  entityId?: string | null;
  groupValue?: string | null;
  rankFrom?: number | null;
  applies?: boolean | null;
}

/** A fund is scored for a test only when its own threshold says the test applies. */
export function fundUsesRule(thresholds: FundThresholdEnrollment[], ruleId: string, entityId: string): boolean {
  const fundDefault = thresholds.find((item) =>
    item.ruleId === ruleId
    && item.entityId === entityId
    && !item.groupValue
    && item.rankFrom == null
  );
  return fundDefault?.applies === true;
}
