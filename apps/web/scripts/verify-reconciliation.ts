import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { reconciliationResolvers } from '../../../packages/graphql/src/resolvers/reconciliation';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const context = {
  supabase,
  supabaseAdmin: supabase,
  user: { id: '', email: 'reconciliation-check@local', role: 'admin' as const },
  requestId: 'reconciliation-check',
  loaders: {} as never,
};

async function main() {
  const definitions = await reconciliationResolvers.Query.reconciliationDefinitions({}, {}, context as never);
  console.log('definitions', definitions.map((item: { definitionCode: string }) => item.definitionCode).join(', '));

  const opened: string[] = [];
  for (const domain of ['SECURITY', 'FUND']) {
    let entityQuery = supabase
      .from('master_entities')
      .select('id, entity_code, entity_name, domain_code')
      .eq('domain_code', domain)
      .eq('is_active', true)
      .limit(1);
    if (domain === 'FUND') entityQuery = entityQuery.eq('entity_code', 'BENCH-FUND-004');
    const { data: entity, error } = await entityQuery.maybeSingle();
    if (error) throw error;
    if (!entity) {
      console.log(domain, 'no entity');
      continue;
    }
    const definition = definitions.find((item: { domainCode: string }) => item.domainCode === domain);
    const result = await reconciliationResolvers.Mutation.openReconciliationRun({}, {
      input: {
        definitionCode: definition.definitionCode,
        entityId: entity.id,
        asOfDate: '2026-10-14',
        compareAsOfDate: '2026-07-14',
      },
    }, context as never);
    if (result.errors?.length) {
      console.log(domain, entity.entity_code, 'error', result.errors[0].message);
      continue;
    }
    const run = result.run;
    opened.push(run.id);
    const kinds = run.lines.reduce((counts: Record<string, number>, line: { breakKind: string; isBreak: boolean }) => {
      const key = `${line.breakKind}${line.isBreak ? ':break' : ':match'}`;
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    console.log(domain, entity.entity_code, run.status, 'lines', run.lines.length, 'open', run.openBreakCount, JSON.stringify(kinds), 'identities', run.identities.map((item: { code: string; passed: boolean; message: string | null }) => `${item.code}:${item.passed ? 'pass' : item.message || 'fail'}`).join(' | '));

    const sample = run.lines.find((line: { isBreak: boolean; breakKind: string }) => line.isBreak && line.breakKind !== 'IDENTITY');
    if (sample) {
      const resolved = await reconciliationResolvers.Mutation.resolveReconciliationLine({}, {
        input: { lineId: sample.id, status: 'ACCEPTED' },
      }, context as never);
      console.log('resolved', sample.attributeCode, resolved.errors?.[0]?.message || resolved.run.status, 'open', resolved.run?.openBreakCount);
    }
  }

  if (opened.length) {
    const { error } = await supabase.from('reconciliation_runs').delete().in('id', opened);
    if (error) throw error;
    console.log('cleaned', opened.length);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
