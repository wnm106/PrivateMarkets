import { describe, expect, it } from 'vitest';
import { isCategoryAllowed } from './context-profiles';

describe('tool profiles for the guided write tools', () => {
  it('lets the workflow tools through only to the workflow and general profiles', () => {
    expect(isCategoryAllowed('workflow', 'workflow')).toBe(true);
    expect(isCategoryAllowed('workflow', 'general')).toBe(true);
    for (const profile of ['entity-explorer', 'analyst', 'compliance', 'data-quality', 'lineage', 'report-designer']) {
      expect(isCategoryAllowed('workflow', profile)).toBe(false);
    }
  });

  it('lets rule creation through only to the data quality and general profiles', () => {
    expect(isCategoryAllowed('dq-admin', 'data-quality')).toBe(true);
    expect(isCategoryAllowed('dq-admin', 'general')).toBe(true);
    for (const profile of ['entity-explorer', 'analyst', 'compliance', 'lineage', 'workflow']) {
      expect(isCategoryAllowed('dq-admin', profile)).toBe(false);
    }
  });
});
