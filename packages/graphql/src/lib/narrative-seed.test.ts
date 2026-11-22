import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { narrativePlan, validateNarrative } from './narrative-engine';
import {
  applyMeasures, evaluateScenarios, evaluateScreens, narrativeSections, resolveAsOfSet, sectionRunOrder, type NarrativeSection,
} from './narrative-spec';

// The seeded LP review: inputs from the investor redesign, sections and rules from the latest
// migration that replaces them (the story layout).
const migration = (file: string) => readFileSync(resolve(__dirname, '../../../../supabase/migrations', file), 'utf8');
const redesign = migration('20261121160000_lp_review_investor_redesign.sql');
const latest = migration('20261121170000_lp_review_story_layout.sql');

function dollarQuoted(sql: string, tag: string): any {
  const match = sql.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
  if (!match) throw new Error(`No $${tag}$ block in the migration`);
  return JSON.parse(match[1]);
}

describe('seeded LP portfolio review', () => {
  const sections = dollarQuoted(latest, 's') as NarrativeSection[];
  const rules = dollarQuoted(latest, 'r') as string[];
  const parameters = dollarQuoted(redesign, 'p') as Array<{ name: string }>;
  const spec = { narrativeName: 'LP Portfolio Review', domainCode: 'FUND', sections, rules };
  const section = (key: string) => sections.find((s) => s.key === key)!;

  it('is valid: structure, queries, expressions, and dependencies', () => {
    expect(validateNarrative(spec)).toEqual([]);
  });

  it('reads in the order an investor expects, with the gaps in one internal appendix at the end', () => {
    expect(sections.map((s) => s.key)).toEqual([
      'at_a_glance', 'nav_trend', 'returns', 'drivers', 'allocation', 'concentration', 'loan_book', 'credit', 'limits', 'lp_qa', 'data_room',
    ]);
    expect(section('data_room').title).toMatch(/internal/i);
  });

  it('writes the opening page and the LP questions last, from the finished sections', () => {
    const order = narrativePlan(spec).order;
    for (const key of ['nav_trend', 'returns', 'drivers', 'allocation', 'concentration', 'loan_book', 'credit', 'limits']) {
      expect(order.indexOf('at_a_glance')).toBeGreaterThan(order.indexOf(key));
      expect(order.indexOf('lp_qa')).toBeGreaterThan(order.indexOf(key));
    }
    expect(sectionRunOrder(narrativeSections(spec))).toEqual(order);
  });

  it('keeps gaps out of the investor-facing sections', () => {
    expect(rules.some((r) => /Data Room Readiness appendix/.test(r) && /leave out/.test(r))).toBe(true);
    expect(section('lp_qa').instructions).toMatch(/Never ask about our data/);
  });

  it('reads industry from the security, where it is stored, not the issuer', () => {
    for (const key of ['drivers', 'allocation']) {
      const q = section(key).dataQueries!.find((d) => d.key === 'exposure_by_industry')!;
      expect(q.groupBy).toEqual(['sec.INDUSTRY']);
    }
  });

  it('charts thirteen monthly NAV marks from the fund itself', () => {
    const nav = section('nav_trend');
    expect(nav.comparisons).toHaveLength(13);
    // Every one of them is run: a year of month-ends, not just the first six.
    expect(resolveAsOfSet(nav.comparisons, '2026-11-21').map((d) => d.date).at(-1)).toBe('2025-11-21');
    const fund = nav.dataQueries!.find((q) => q.key === 'fund_values')!;
    expect(fund.includeAnchor).toBe(true);
    expect(fund.select).toEqual(['NAV', 'GROSS_ASSET_VALUE']);
  });

  it('computes concentration and stress cases instead of judging them', () => {
    const conc = section('concentration');
    expect(conc.scenarios!.map((s) => s.key)).toEqual([
      'borrowers', 'top5_share', 'top10_share', 'top20_share', 'hhi', 'largest_loss_100', 'largest2_loss_50', 'largest5_loss_50',
    ]);
    const rows = [
      { 'iss.entity_name': 'A', exposure: 50, exposure_share: 0.5 },
      { 'iss.entity_name': 'B', exposure: 30, exposure_share: 0.3 },
      { 'iss.entity_name': 'C', exposure: 20, exposure_share: 0.2 },
    ];
    const { results, errors } = evaluateScenarios({ exposure_by_issuer: rows }, conc.scenarios!);
    expect(errors).toEqual([]);
    const by = Object.fromEntries(results.map((r) => [r.key, r]));
    expect(by.borrowers.value).toBe(3);
    expect(by.hhi.value).toBeCloseTo(0.38);
    expect(by.largest2_loss_50.value).toBeCloseTo(0.4);
    // Grouped rows have no entity_name: the names come from the grouped column.
    expect(by.largest2_loss_50.names).toEqual(['A', 'B']);
  });

  it('lets each story section design its layout, with story tools in its palette', () => {
    const free = sections.filter((s) => s.layout === 'free').map((s) => s.key);
    expect(free).toEqual(['at_a_glance', 'nav_trend', 'returns', 'drivers', 'allocation', 'concentration', 'loan_book', 'credit', 'limits']);
    // The questions and the appendix keep their fixed form.
    expect(section('lp_qa').layout).toBeUndefined();
    expect(section('data_room').layout).toBeUndefined();
    const palette = sections.flatMap((s) => s.blocks);
    expect(palette.filter((b) => b.type === 'hero').length).toBeGreaterThanOrEqual(4);
    expect(palette.some((b) => /spark/.test(b.guidance ?? ''))).toBe(true);
    expect(palette.some((b) => /delta/.test(b.guidance ?? ''))).toBe(true);
    expect(palette.some((b) => /[Hh]ighlight/.test(b.guidance ?? ''))).toBe(true);
  });

  it('names windows, never calls the largest exposure a cap, and judges the appendix against the report', () => {
    expect(rules.some((r) => /window of every change/.test(r))).toBe(true);
    expect(rules.some((r) => /not a cap, a limit/.test(r))).toBe(true);
    expect(section('data_room').instructions).toMatch(/never quote its percentages/);
    expect(section('data_room').dependsOn).toContain('credit');
  });

  it('computes TVPI, DPI and income yield from the NAV statement', () => {
    const returns = section('returns');
    const statement = returns.dataQueries!.find((q) => q.key === 'statement')!;
    expect(statement.path).toEqual([{ direction: 'UP', domainCode: 'NAV_STATEMENT', relationshipCode: 'STATEMENT_FUND' }]);
    const row = {
      NAV_RF_ENDING: 1163.9, NAV_RF_DISTRIBUTIONS: -312.4, NAV_RF_CONTRIBUTIONS: 1140,
      NAV_CH_NET_INVESTMENT_INCOME: 26.9, NAV_CH_BEGINNING: 1172.4, NAV_CH_DISTRIBUTIONS: -25.6,
      NAV_CH_NET_OPERATIONS: 17.1, NAV_OP_TOTAL_EXPENSES: 5.17,
    };
    const { rows, errors } = applyMeasures([row], returns.measures!.filter((m) => m.query === 'statement'));
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ tvpi: 1.3, dpi: 0.27, nii_yield_pct: 9.2, dist_coverage: 1.05 });
  });

  it('assigns borrower status from data, and names every screened borrower', () => {
    const credit = section('credit');
    const status = credit.measures!.filter((m) => m.query === 'borrower_credit');
    const borrower = (name: string, lev: number | null, cov: number | null, mark: number) => ({
      'iss.entity_name': name, 'iss.TOTAL_NET_LEVERAGE_RATIO': lev, 'iss.INTEREST_COVERAGE_RATIO': cov, lowest_mark: mark,
      'iss.CREDIT_RATING': 'B', exposure: 10, exposure_share: 0.1,
    });
    const { rows } = applyMeasures([
      borrower('Fine', 5, 2, 98), borrower('Thin cover', 5, 1.4, 98), borrower('Marked down', 5, 2, 86), borrower('No data', null, null, 98),
    ], status);
    expect(rows.map((r) => r.status)).toEqual(['Performing', 'Watchlist', 'Watchlist', 'Not rated']);
    const screens = evaluateScreens({ borrower_credit: rows }, credit.screens!).results;
    expect(screens.find((s) => s.key === 'coverage_below_1_5')!.flagged.map((f) => f['iss.entity_name'])).toEqual(['Thin cover']);
  });

  it('only uses tools where the queries cannot reach, and never searches the web', () => {
    const agentic = sections.filter((s) => s.agentic?.enabled).map((s) => s.key).sort();
    expect(agentic).toEqual(['data_room', 'drivers', 'limits']);
    expect(sections.some((s) => s.research)).toBe(false);
    expect(parameters.map((p) => p.name)).toEqual(['lpName', 'watchlistNotes', 'inceptionDate']);
  });
});
