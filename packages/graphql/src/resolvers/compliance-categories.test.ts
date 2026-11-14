import { describe, expect, it } from 'vitest';
import { schema } from '../schema';

describe('compliance rule categories', () => {
  it('includes the coverage and collateral quality categories stored on CLO rules', () => {
    const category = schema.getType('ComplianceRuleCategory');
    expect(category?.name).toBe('ComplianceRuleCategory');
    const names = category && 'getValues' in category ? category.getValues().map((value) => value.name) : [];
    expect(names).toEqual(expect.arrayContaining(['COVERAGE', 'COLLATERAL_QUALITY', 'FORTY_ACT', 'CONCENTRATION']));
    const serialize = category && 'serialize' in category ? category.serialize.bind(category) : null;
    expect(serialize?.('COVERAGE')).toBe('COVERAGE');
    expect(serialize?.('COLLATERAL_QUALITY')).toBe('COLLATERAL_QUALITY');
  });

  it('stores a minimum or maximum on the fund limit, and does not require one on the rule', () => {
    const versionInput = schema.getType('CreateComplianceRuleVersionInput');
    const versionFields = versionInput && 'getFields' in versionInput ? versionInput.getFields() : {};
    expect(versionFields.limitDirection.type.toString()).toBe('ComplianceLimitDirection');

    const thresholdInput = schema.getType('UpsertComplianceThresholdInput');
    const thresholdFields = thresholdInput && 'getFields' in thresholdInput ? thresholdInput.getFields() : {};
    expect(thresholdFields.limitDirection.type.toString()).toBe('ComplianceLimitDirection');

    const threshold = schema.getType('ComplianceThreshold');
    const stored = threshold && 'getFields' in threshold ? threshold.getFields() : {};
    expect(stored.limitDirection.type.toString()).toBe('ComplianceLimitDirection');
  });
});
