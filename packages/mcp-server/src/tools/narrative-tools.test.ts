import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../lib/tool-registry';
import { NARRATIVE_COMPOSE_GUIDE, SERVER_INSTRUCTIONS } from '../lib/narrative-guide';
import { PROMPTS, getPromptMessages } from '../prompts';
import { listResources, readResource } from '../resources';
import { registerComplianceTools } from './compliance-tools';
import { registerDomainTools } from './domain-tools';
import { registerDQTools } from './dq-tools';
import { registerLineageTools } from './lineage-tools';
import { NARRATIVE_AGENT_TOOLS, registerNarrativeTools } from './narrative-tools';
import { registerQueryTools } from './query-data';
import { registerReportingTools } from './reporting-tools';

/** A tiny in-memory stand-in for the parts of supabase-js these tools use. */
function fakeSupabase(seed: Record<string, any[]>, rpc: (name: string, args: any) => any) {
  const db: Record<string, any[]> = JSON.parse(JSON.stringify(seed));
  let counter = 0;
  const from = (table: string) => {
    const state: { op: string; filters: Array<[string, unknown]>; payload: any } = { op: 'select', filters: [], payload: null };
    const rows = () => (db[table] ??= []);
    const matches = (r: any) => state.filters.every(([c, v]) => r[c] === v);
    const run = (single: boolean) => {
      let data: any;
      if (state.op === 'insert') {
        const items = (Array.isArray(state.payload) ? state.payload : [state.payload])
          .map((p: any) => ({ id: `id-${++counter}`, created_at: '2026-11-13T00:00:00Z', ...p }));
        rows().push(...items);
        data = items;
      } else if (state.op === 'update') {
        data = rows().filter(matches);
        data.forEach((r: any) => Object.assign(r, state.payload));
      } else {
        data = rows().filter(matches);
      }
      return { data: single ? (data[0] ?? null) : data, error: null };
    };
    const b: any = {
      select: () => b,
      insert: (p: any) => { state.op = 'insert'; state.payload = p; return b; },
      update: (p: any) => { state.op = 'update'; state.payload = p; return b; },
      eq: (c: string, v: unknown) => { state.filters.push([c, v]); return b; },
      or: () => b, in: () => b, order: () => b, limit: () => b,
      maybeSingle: async () => run(true),
      single: async () => run(true),
      then: (res: any, rej: any) => Promise.resolve(run(false)).then(res, rej),
    };
    return b;
  };
  return {
    db,
    from,
    schema: () => ({ rpc: async () => ({ data: [], error: null }) }),
    rpc: async (name: string, args: any) => rpc(name, args),
  };
}

const TEMPLATE = {
  id: 't1',
  narrative_code: 'TEST_REVIEW',
  narrative_name: 'Test review',
  description: 'A two-section test narrative',
  domain_code: 'FUND',
  exposed_domains: [],
  is_active: true,
  persona: 'You are an analyst.',
  audience: 'PM',
  rules: [],
  allow_external_search: false,
  parameters: [],
  instructions: '',
  data_queries: [],
  output_blocks: [],
  sections: [
    {
      key: 'exposure', title: 'Exposure', purpose: 'Where is the money?', instructions: 'Report exposure by industry.',
      dataQueries: [{ key: 'by_industry', start: 'DOMAIN', domainCode: 'POSITION', groupBy: ['INDUSTRY'], metrics: [{ alias: 'exposure', agg: 'SUM', field: 'MARKET_VALUE' }] }],
      blocks: [{ type: 'kpis', key: 'headline' }, { type: 'markdown', key: 'story' }],
    },
    {
      key: 'summary', title: 'Summary', instructions: 'Summarise.', dependsOn: ['exposure'], dataQueries: [],
      blocks: [{ type: 'markdown', key: 'pitch' }],
    },
  ],
};

const GRID = {
  mode: 'aggregate', total: 2, matched: 6203, columns: [], groupBy: ['INDUSTRY'],
  rows: [{ INDUSTRY: 'Software', exposure: 400000000 }, { INDUSTRY: 'Energy', exposure: 500000000 }],
};

function setup() {
  const supabase = fakeSupabase(
    {
      narrative_templates: [TEMPLATE],
      entity_master: [{ entity_id: 'e1', entity_code: 'FUND_1', entity_name: 'Fund One', domain_code: 'FUND' }],
    },
    (name) => (name === 'report_grid' ? { data: GRID, error: null } : { data: null, error: { message: `unexpected rpc ${name}` } }),
  );
  const registry = new ToolRegistry(supabase as never);
  registerNarrativeTools(registry);
  const call = (name: string, args: Record<string, unknown>) => registry.executeTool(name, args, supabase as never) as Promise<any>;
  return { supabase, registry, call };
}

describe('narrative lifecycle over MCP', () => {
  it('finds the narrative for a record and shows its sections', async () => {
    const { call } = setup();
    const out = await call('list_narratives', { entityCode: 'FUND_1' });
    expect(out.domainCode).toBe('FUND');
    expect(out.narratives).toHaveLength(1);
    expect(out.narratives[0].sections.map((s: any) => s.key)).toEqual(['exposure', 'summary']);
  });

  it('returns the blueprint with rules, order, and block format', async () => {
    const { call } = setup();
    const out = await call('get_narrative', { narrativeCode: 'TEST_REVIEW' });
    expect(out.runOrder).toEqual(['exposure', 'summary']);
    expect(out.rules.join(' ')).toMatch(/data not available/);
    expect(out.blockFormat).toMatch(/scorecard/);
    expect(out.systemPrompt).toMatch(/You are an analyst/);
  });

  it('runs end to end: start, evidence, verified save, dependent section, finish', async () => {
    const { call, supabase } = setup();

    const started = await call('start_narrative_run', { narrativeCode: 'TEST_REVIEW', entityCode: 'FUND_1', asOfDate: '2026-09-30' });
    expect(started.runId).toBeTruthy();
    expect(started.runOrder).toEqual(['exposure', 'summary']);
    expect(supabase.db.narrative_run_sections).toHaveLength(2);

    // A section that depends on another cannot start first.
    const early = await call('run_narrative_section_data', { runId: started.runId, sectionKey: 'summary' });
    expect(early.error).toMatch(/exposure/);

    const data = await call('run_narrative_section_data', { runId: started.runId, sectionKey: 'exposure' });
    expect(data.evidence.datasets.by_industry.rows).toHaveLength(2);
    expect(data.evidence.mustDisclose).toBeDefined();
    expect(data.evidence.datasets.by_industry.totalsOverAllGroups).toEqual({ exposure: 900000000 });
    expect(data.evidence.datasets.by_industry.rows[0].exposure_share).toBeCloseTo(0.4444, 3);
    expect(data.research.allowed).toBe(false);

    // A figure the model computed itself is flagged; one in the evidence is traced.
    const first = await call('save_narrative_section', {
      runId: started.runId, sectionKey: 'exposure',
      blocks: JSON.stringify([
        { type: 'kpis', key: 'headline', items: [{ label: 'Largest', value: '$500M' }, { label: 'Total', value: '$900M' }, { label: 'Made up', value: '$1.25B' }] },
        { type: 'markdown', key: 'story', text: 'Software is $400M of exposure across 6,203 positions.' },
      ]),
    });
    expect(first.saved).toBe(true);
    // The engine supplied the total ($900M) and each group's share, so those trace; $1.25B is the model's own.
    expect(first.verification.notTraced.map((u: any) => u.figure)).toEqual(['$1.25B']);
    expect(first.next).toMatch(/could not be traced/);

    const fixed = await call('save_narrative_section', {
      runId: started.runId, sectionKey: 'exposure',
      blocks: JSON.stringify([
        { type: 'kpis', key: 'headline', items: [{ label: 'Largest', value: '$500M' }] },
        { type: 'markdown', key: 'story', text: 'Software is $400M of exposure across 6,203 positions.' },
      ]),
    });
    expect(fixed.verification.notTraced).toEqual([]);
    expect(fixed.sectionStatus).toBe('COMPLETED');

    const summaryData = await call('run_narrative_section_data', { runId: started.runId, sectionKey: 'summary' });
    expect(summaryData.sectionsAlreadyWritten[0].text).toMatch(/Software is \$400M/);
    // Figures from an earlier section can be quoted again.
    const summary = await call('save_narrative_section', {
      runId: started.runId, sectionKey: 'summary',
      blocks: JSON.stringify([{ type: 'markdown', key: 'pitch', text: 'Exposure is led by Energy at $500M.' }]),
    });
    expect(summary.verification.notTraced).toEqual([]);

    const finished = await call('finish_narrative_run', { runId: started.runId });
    expect(finished.status).toBe('COMPLETED');
    expect(finished.sectionsMissing).toEqual([]);
    expect(finished.reportMarkdown).toMatch(/## Exposure/);
    expect(finished.reportMarkdown).toMatch(/## Summary/);
    expect(supabase.db.narrative_runs[0].status).toBe('COMPLETED');
    expect(supabase.db.narrative_runs[0].origin).toBe('MCP');
  });

  it('reports a partial run when a section is missing', async () => {
    const { call } = setup();
    const started = await call('start_narrative_run', { narrativeCode: 'TEST_REVIEW', entityCode: 'FUND_1', asOfDate: '2026-09-30' });
    const finished = await call('finish_narrative_run', { runId: started.runId });
    expect(finished.status).toBe('FAILED');
    expect(finished.sectionsMissing).toEqual(['exposure', 'summary']);
  });

  it('refuses a record of a type the narrative is not offered on', async () => {
    const { call, supabase } = setup();
    supabase.db.entity_master.push({ entity_id: 'e2', entity_code: 'ISS_1', entity_name: 'Issuer', domain_code: 'ISSUER' });
    const out = await call('start_narrative_run', { narrativeCode: 'TEST_REVIEW', entityCode: 'ISS_1', asOfDate: '2026-09-30' });
    expect(out.error).toMatch(/offered on FUND/);
  });

  it('will not save a section before its evidence was gathered', async () => {
    const { call } = setup();
    const started = await call('start_narrative_run', { narrativeCode: 'TEST_REVIEW', entityCode: 'FUND_1', asOfDate: '2026-09-30' });
    const out = await call('save_narrative_section', {
      runId: started.runId, sectionKey: 'exposure',
      blocks: JSON.stringify([{ type: 'markdown', key: 'story', text: 'Hello' }]),
    });
    expect(out.error).toMatch(/run_narrative_section_data/);
  });
});

describe('reusing finished runs', () => {
  /** Runs the two-section test narrative to completion and returns the run id. */
  async function finishedRun(call: (n: string, a: Record<string, unknown>) => Promise<any>, supabase: any, asOfDate = '2026-09-30') {
    const started = await call('start_narrative_run', { narrativeCode: 'TEST_REVIEW', entityCode: 'FUND_1', asOfDate });
    await call('run_narrative_section_data', { runId: started.runId, sectionKey: 'exposure' });
    await call('save_narrative_section', {
      runId: started.runId, sectionKey: 'exposure',
      blocks: JSON.stringify([{ type: 'markdown', key: 'story', text: 'Software is $400M of exposure.' }, { type: 'kpis', key: 'headline', items: [{ label: 'Largest', value: '$500M' }] }]),
    });
    await call('run_narrative_section_data', { runId: started.runId, sectionKey: 'summary' });
    await call('save_narrative_section', {
      runId: started.runId, sectionKey: 'summary',
      blocks: JSON.stringify([{ type: 'markdown', key: 'pitch', text: 'Energy leads at $500M.' }]),
    });
    await call('finish_narrative_run', { runId: started.runId });
    const row = supabase.db.narrative_runs.find((r: any) => r.id === started.runId);
    row.created_by_label = 'Bill McMahon';
    return started.runId as string;
  }

  it('lists a finished run with who made it and recommends showing it instead of recomputing', async () => {
    const { call, supabase } = setup();
    const runId = await finishedRun(call, supabase);
    const out = await call('list_narrative_runs', { narrativeCode: 'TEST_REVIEW', entityCode: 'FUND_1', asOfDate: '2026-09-30' });
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]).toMatchObject({ runId, createdBy: 'Bill McMahon', matchesAsOfDate: true, published: false });
    expect(out.suggestion).toMatch(new RegExp(`Show run ${runId}`));
  });

  it('does not offer an unfinished run, and says when the date differs', async () => {
    const { call, supabase } = setup();
    await call('start_narrative_run', { narrativeCode: 'TEST_REVIEW', entityCode: 'FUND_1', asOfDate: '2026-09-30' });
    const none = await call('list_narrative_runs', { narrativeCode: 'TEST_REVIEW', entityCode: 'FUND_1' });
    expect(none.runs).toEqual([]);
    expect(none.suggestion).toMatch(/start_narrative_run/);

    await finishedRun(call, supabase, '2026-06-30');
    const other = await call('list_narrative_runs', { narrativeCode: 'TEST_REVIEW', entityCode: 'FUND_1', asOfDate: '2026-09-30' });
    expect(other.runs[0].matchesAsOfDate).toBe(false);
    expect(other.suggestion).toMatch(/No finished run|different as-of date/);
  });

  it('reads a finished run back as the assembled report, with its gaps and verification', async () => {
    const { call, supabase } = setup();
    const runId = await finishedRun(call, supabase);
    const out = await call('get_narrative_run', { runId });
    expect(out.reportMarkdown).toMatch(/## Exposure/);
    expect(out.reportMarkdown).toMatch(/Energy leads at \$500M/);
    expect(out.createdBy).toBe('Bill McMahon');
    expect(out.sections.map((s: any) => s.status)).toEqual(['COMPLETED', 'COMPLETED']);
  });

  it('publishes through the database function and reports who published', async () => {
    const supabase = fakeSupabase(
      { narrative_templates: [TEMPLATE], entity_master: [] },
      (name, args) => (name === 'publish_narrative_run'
        ? { data: { id: args.p_run_id, published_label: args.p_label, published_by_label: 'Pat Lee' }, error: null }
        : { data: null, error: { message: `unexpected rpc ${name}` } }),
    );
    const registry = new ToolRegistry(supabase as never);
    registerNarrativeTools(registry);
    const out: any = await registry.executeTool('publish_narrative_run', { runId: 'r1', label: 'Q3 LP review' }, supabase as never);
    expect(out).toEqual({ published: true, runId: 'r1', label: 'Q3 LP review', publishedBy: 'Pat Lee' });
  });

  it('passes a refusal from the database back instead of throwing', async () => {
    const supabase = fakeSupabase({}, () => ({ data: null, error: { message: 'Only a finished run can be published' } }));
    const registry = new ToolRegistry(supabase as never);
    registerNarrativeTools(registry);
    const out: any = await registry.executeTool('publish_narrative_run', { runId: 'r1' }, supabase as never);
    expect(out).toEqual({ published: false, error: 'Only a finished run can be published' });
  });

  it('tells an outside assistant to look for an existing report before spending a run', () => {
    expect(SERVER_INSTRUCTIONS).toContain('list_narrative_runs');
    expect(NARRATIVE_COMPOSE_GUIDE).toContain('Check for an existing report first');
    expect(NARRATIVE_COMPOSE_GUIDE).toContain('publish_narrative_run');
  });
});

describe('consistency review over MCP', () => {
  async function finishedRun(call: (n: string, a: Record<string, unknown>) => Promise<any>) {
    const started = await call('start_narrative_run', { narrativeCode: 'TEST_REVIEW', entityCode: 'FUND_1', asOfDate: '2026-09-30' });
    await call('run_narrative_section_data', { runId: started.runId, sectionKey: 'exposure' });
    await call('save_narrative_section', {
      runId: started.runId, sectionKey: 'exposure',
      blocks: JSON.stringify([{ type: 'markdown', key: 'story', text: 'Software is $400M of exposure. Bench Issuer 79 is in Healthcare.' }]),
    });
    await call('run_narrative_section_data', { runId: started.runId, sectionKey: 'summary' });
    await call('save_narrative_section', {
      runId: started.runId, sectionKey: 'summary',
      blocks: JSON.stringify([{ type: 'markdown', key: 'pitch', text: 'No issuer has any industry classification.' }]),
    });
    await call('finish_narrative_run', { runId: started.runId });
    return started.runId as string;
  }

  it('hands an outside reviewer the instructions and every finished section', async () => {
    const { call } = setup();
    const runId = await finishedRun(call);
    const out = await call('get_review_brief', { runId });
    expect(out.instructions).toMatch(/gap-vs-figure/);
    expect(out.instructions).toMatch(/exact words/);
    expect(out.sections.map((s: any) => s.key)).toEqual(['exposure', 'summary']);
    expect(out.brief).toContain('Section [exposure]');
    expect(out.brief).toContain('No issuer has any industry classification');
  });

  it('keeps an issue whose quote is in the report and discards one that is invented', async () => {
    const { call, supabase } = setup();
    const runId = await finishedRun(call);
    const out = await call('save_run_review', {
      runId,
      issues: JSON.stringify([
        { severity: 'high', kind: 'gap-vs-figure', sections: ['summary', 'exposure'], quote: 'No issuer has any industry classification', problem: 'Another section gives an industry.', suggestion: 'Say four issuers have one.' },
        { severity: 'high', kind: 'unsupported', sections: ['exposure'], quote: 'a sentence that was never written', problem: 'Invented.' },
      ]),
    });
    expect(out).toMatchObject({ saved: true, issues: 1, discarded: 1, summary: '1 consistency issue (1 high)' });
    const stored = supabase.db.narrative_runs.find((r: any) => r.id === runId).verification.review;
    expect(stored.source).toBe('MCP');
    expect(stored.issues[0].quote).toBe('No issuer has any industry classification');
    expect(stored.sectionsReviewed).toBe(2);
  });

  it('refuses to review a run with nothing finished', async () => {
    const { call } = setup();
    const started = await call('start_narrative_run', { narrativeCode: 'TEST_REVIEW', entityCode: 'FUND_1', asOfDate: '2026-09-30' });
    expect((await call('get_review_brief', { runId: started.runId })).error).toMatch(/nothing to review/);
  });

  it('is part of the method an outside assistant is given', () => {
    expect(NARRATIVE_COMPOSE_GUIDE).toContain('get_review_brief');
    expect(NARRATIVE_COMPOSE_GUIDE).toContain('save_run_review');
    expect(NARRATIVE_COMPOSE_GUIDE).toContain('A name is not an identifier');
    expect(SERVER_INSTRUCTIONS).toContain('get_review_brief');
  });
});

describe('analyze_rows', () => {
  const rows = [
    { entity_name: 'Acme', COVENANT_CURRENT: 4.0, COVENANT_LEVEL: 5.0, MARKET_VALUE: 100 },
    { entity_name: 'Beta', COVENANT_CURRENT: 4.9, COVENANT_LEVEL: 5.0, MARKET_VALUE: 300 },
    { entity_name: 'Gamma', COVENANT_CURRENT: null, COVENANT_LEVEL: 5.0, MARKET_VALUE: 50 },
  ];
  const supabase = fakeSupabase({}, (name) => (name === 'report_grid'
    ? { data: { mode: 'rows', total: 3, matched: 3, rows, columns: [], groupBy: [] }, error: null }
    : { data: null, error: { message: `unexpected rpc ${name}` } }));
  const registry = new ToolRegistry(supabase as never);
  registerNarrativeTools(registry);
  registerQueryTools(registry);

  it('computes measures, flags rows, counts what it could not test, and runs a stress', async () => {
    const out: any = await registry.executeTool('analyze_rows', {
      query: JSON.stringify({ start: 'DOMAIN', domainCode: 'POSITION', select: ['COVENANT_CURRENT', 'COVENANT_LEVEL', 'MARKET_VALUE'], limit: 500 }),
      measures: JSON.stringify([{ alias: 'cushion', expr: '(COVENANT_LEVEL - COVENANT_CURRENT) / COVENANT_LEVEL', unit: 'percent' }]),
      screens: JSON.stringify([{ key: 'thin', label: 'Cushion under 15%', when: 'cushion < 0.15', severity: 'high' }]),
      scenarios: JSON.stringify([{ key: 'stress', label: 'Two largest stop paying', expr: 'MARKET_VALUE', agg: 'SUM', rankBy: 'MARKET_VALUE', top: 2 }]),
    }, supabase as never);
    expect(out.error).toBeUndefined();
    expect(out.screens[0].flaggedCount).toBe(1);
    expect(out.screens[0].flagged[0].entity_name).toBe('Beta');
    expect(out.screens[0].notEvaluable).toBe(1);
    expect(out.scenarios[0].value).toBe(400);
    expect(out.scenarios[0].names).toEqual(['Beta', 'Acme']);
    expect(out.coverage.columns.cushion.populated).toBe(2);
  });

  it('reports a bad expression instead of guessing', async () => {
    const out: any = await registry.executeTool('analyze_rows', {
      query: JSON.stringify({ start: 'DOMAIN', domainCode: 'POSITION', select: ['MARKET_VALUE'] }),
      measures: JSON.stringify([{ alias: 'bad', expr: 'MARKET_VALUE +' }]),
    }, supabase as never);
    expect(out.notes.join(' ')).toMatch(/measure bad/);
  });
});

describe('what an outside assistant is told', () => {
  it('lists every read-only tool a section may use, and each one exists', () => {
    const registry = new ToolRegistry(null as never);
    registerDomainTools(registry);
    registerLineageTools(registry);
    registerDQTools(registry);
    registerComplianceTools(registry);
    registerReportingTools(registry);
    registerQueryTools(registry);
    registerNarrativeTools(registry);
    const names = new Set(registry.listTools().map((t) => t.name));
    for (const tool of NARRATIVE_AGENT_TOOLS) expect(names, tool).toContain(tool);
    // A section never gets a tool that changes data, templates, or other runs.
    for (const tool of NARRATIVE_AGENT_TOOLS) expect(tool).not.toMatch(/^(create|update|delete|submit|resolve|save|assign|start|finish|split)_/);
    expect(registry.listTools().length).toBe(names.size);
  });

  it('tells the client the method on connect', () => {
    for (const phrase of ['list_narratives', 'start_narrative_run', 'analyze_rows', 'data not available', 'tapestrai://model/narrative-guide', 'get_model_map']) {
      expect(SERVER_INSTRUCTIONS).toContain(phrase);
    }
    expect(SERVER_INSTRUCTIONS).not.toMatch(/```answer/);
  });

  it('serves the method as a resource and the saved narratives as resources', async () => {
    const supabase = fakeSupabase({ narrative_templates: [TEMPLATE], domain_templates: [] }, () => ({ data: null, error: null }));
    const list = await listResources(supabase as never);
    expect(list.map((r) => r.uri)).toContain('tapestrai://model/narrative-guide');
    expect(list.map((r) => r.uri)).toContain('tapestrai://narrative/TEST_REVIEW');
    expect((await readResource('tapestrai://model/narrative-guide', supabase as never)).text).toBe(NARRATIVE_COMPOSE_GUIDE);
    const blueprint = JSON.parse((await readResource('tapestrai://narrative/TEST_REVIEW', supabase as never)).text);
    expect(blueprint.runOrder).toEqual(['exposure', 'summary']);
  });

  it('offers prompts that start the method', () => {
    expect(PROMPTS.map((p) => p.name)).toEqual(expect.arrayContaining(['compose_narrative', 'portfolio_review']));
    const text = getPromptMessages('portfolio_review', { entityCode: 'FUND_1', asOfDate: '2026-09-30' }).map((m) => m.content.text).join('\n');
    expect(text).toContain('FUND_LP_PORTFOLIO_REVIEW');
    expect(text).toContain('FUND_1');
    expect(text).toContain('2026-09-30');
  });

  it('covers the method end to end', () => {
    for (const phrase of ['Settle the scope', 'saved narrative', 'data not available', 'mustDisclose', 'Sources', 'analyze_rows', 'finish_narrative_run']) {
      expect(NARRATIVE_COMPOSE_GUIDE).toContain(phrase);
    }
  });
});
