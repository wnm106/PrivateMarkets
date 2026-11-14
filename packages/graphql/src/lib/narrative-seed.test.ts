import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { narrativePlan, validateNarrative } from './narrative-engine';
import { narrativeSections, sectionRunOrder, type NarrativeSection } from './narrative-spec';

const sql = readFileSync(
  resolve(__dirname, '../../../../supabase/migrations/20261113140000_narrative_framework.sql'),
  'utf8',
);

function dollarQuoted(tag: string): any {
  const match = sql.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
  if (!match) throw new Error(`No $${tag}$ block in the migration`);
  return JSON.parse(match[1]);
}

describe('seeded LP portfolio review', () => {
  const sections = dollarQuoted('s') as NarrativeSection[];
  const rules = dollarQuoted('r') as string[];
  const parameters = dollarQuoted('p') as Array<{ name: string }>;
  const spec = { narrativeName: 'LP Portfolio Review', domainCode: 'FUND', sections, rules };

  it('is valid: structure, queries, expressions, and dependencies', () => {
    expect(validateNarrative(spec)).toEqual([]);
  });

  it('covers every part of the brief, in the order a reader expects', () => {
    expect(sections.map((s) => s.key)).toEqual([
      'exec_summary', 'evolution', 'attribution', 'borrowers', 'credit_ranking',
      'risk_callouts', 'industry', 'compliance_liquidity', 'outlook', 'lp_qa',
    ]);
  });

  it('writes the executive summary and Q&A last, from the finished sections', () => {
    const order = narrativePlan(spec).order;
    expect(order.indexOf('exec_summary')).toBeGreaterThan(order.indexOf('outlook'));
    expect(order.indexOf('lp_qa')).toBeGreaterThan(order.indexOf('outlook'));
    expect(order.indexOf('credit_ranking')).toBeGreaterThan(order.indexOf('borrowers'));
    expect(sectionRunOrder(narrativeSections(spec))).toEqual(order);
  });

  it('compares four dates where the brief asks for them', () => {
    const evolution = sections.find((s) => s.key === 'evolution')!;
    expect(evolution.comparisons?.map((c) => c.label)).toEqual(['Current', 'Last quarter', '1 year ago', 'Inception']);
    expect(parameters.map((p) => p.name)).toContain('inceptionDate');
    expect(evolution.comparisons?.find((c) => c.label === 'Inception')?.param).toBe('inceptionDate');
  });

  it('reviews borrowers a group at a time against a data set that exists', () => {
    const borrowers = sections.find((s) => s.key === 'borrowers')!;
    expect(borrowers.batch?.query).toBe('exposure_by_issuer');
    expect(borrowers.dataQueries?.some((q) => q.key === 'exposure_by_issuer')).toBe(true);
    expect(borrowers.blocks.some((b) => b.type === 'scorecard')).toBe(true);
  });

  it('only researches the web where the brief asks for sentiment or news', () => {
    const researching = sections.filter((s) => s.research).map((s) => s.key);
    expect(researching.sort()).toEqual(['borrowers', 'industry', 'risk_callouts']);
  });

  it('keeps every section agentic where it needs data the queries cannot know', () => {
    for (const key of ['evolution', 'attribution', 'borrowers', 'risk_callouts', 'compliance_liquidity', 'outlook']) {
      expect(sections.find((s) => s.key === key)?.agentic?.enabled).toBe(true);
    }
  });
});
