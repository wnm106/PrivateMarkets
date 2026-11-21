/**
 * Database tests for deal capacity and the deal scoring plan.
 *
 * Run against a database built from supabase/migrations (scripts/db-replay):
 *   DATABASE_URL=postgres://... npx tsx scripts/db-tests/capacity-parity.ts
 *
 * What must hold, for every deal with tranches and every allocation-eligible fund:
 *   1. Capacity agrees with the rule evaluator. Buying exactly the reported
 *      room creates no new hard breach on that rule; buying a little more does.
 *   2. A parent fund's figure is the sum of its child funds' figures, for every
 *      rule that consolidates child funds, when the parent holds nothing itself.
 *   3. compliance.deal_score_plans: deal-surface rules cover every fund, an
 *      enrolled rule covers only funds with a limit assigned, an explicit
 *      opt-out wins over a rank band, and an inactive rule is skipped.
 *
 * Exits non-zero on any failure. Changes are made inside transactions that
 * are rolled back.
 */
import { Client } from 'pg';
import {
  solveDealObservations,
  walkRankedCapacity,
  type DealCapacityLine,
  type DealObservationRow,
} from '../../packages/graphql/src/lib/compliance-capacity';

const AS_OF = process.env.CAPACITY_AS_OF || new Date().toISOString().slice(0, 10);
const failures: string[] = [];
let checks = 0;

function check(ok: boolean, message: string) {
  checks += 1;
  if (!ok) failures.push(message);
}

interface Leg {
  security_id: string;
  tranche_id: string;
  par: number;
  unfunded: boolean;
}

async function observe(db: Client, funds: string[], legs: Leg[], dealCode: string, ruleCodes: string[] | null, allGroups: boolean) {
  const { rows } = await db.query(
    `SELECT * FROM compliance.deal_capacity_observations($1::uuid[], $2::jsonb, $3::date, now(), $4, $5::text[], $6)`,
    [funds, JSON.stringify(legs), AS_OF, dealCode, ruleCodes, allGroups],
  );
  return rows as DealObservationRow[];
}

function newBreach(rows: DealObservationRow[], line: DealCapacityLine): boolean {
  return rows.some((row) => row.rule_code === line.ruleCode && row.probe_status === 'HARD_BREACH' && row.base_status !== 'HARD_BREACH');
}

async function eligibleFunds(db: Client): Promise<Array<{ id: string; code: string; parent: string | null }>> {
  const { rows } = await db.query(`
    SELECT f.id, f.entity_code AS code,
           (SELECT r.parent_entity_id FROM entity_instances.entity_relationships r
             WHERE r.relationship_code = 'FUND_PARENT' AND r.child_entity_id = f.id
               AND r.system_to >= TIMESTAMP '9999-01-01' LIMIT 1) AS parent
    FROM entity_instances.master_entities f
    WHERE f.domain_code = 'FUND' AND f.is_active
      AND lower(COALESCE(compliance.get_text_value(f.id, 'FUND_IS_ALLOCATION_ELIGIBLE', $1::date, now(), 'GOLDEN'), '')) = 'true'
    ORDER BY f.entity_code`, [AS_OF]);
  return rows;
}

async function dealsWithLegs(db: Client): Promise<Array<{ code: string; legs: Leg[] }>> {
  const { rows } = await db.query(`
    SELECT d.entity_code AS code,
           jsonb_agg(jsonb_build_object(
             'security_id', ts.child_entity_id,
             'tranche_id', t.id,
             'par', 1,
             'unfunded', lower(COALESCE(compliance.get_text_value(t.id, 'TRANCHE_IS_UNFUNDED', $1::date, now(), 'GOLDEN'), '')) IN ('true', 't', '1')
           ) ORDER BY t.entity_code) AS legs
    FROM entity_instances.master_entities d
    JOIN entity_instances.entity_relationships td ON td.child_entity_id = d.id AND td.relationship_code = 'TRANCHE_DEAL' AND td.system_to >= TIMESTAMP '9999-01-01'
    JOIN entity_instances.master_entities t ON t.id = td.parent_entity_id
    JOIN entity_instances.entity_relationships ts ON ts.parent_entity_id = t.id AND ts.relationship_code = 'TRANCHE_SECURITY' AND ts.system_to >= TIMESTAMP '9999-01-01'
    WHERE d.domain_code = 'DEAL'
    GROUP BY d.entity_code
    ORDER BY d.entity_code`, [AS_OF]);
  return rows;
}

async function capacityParity(db: Client) {
  const funds = await eligibleFunds(db);
  const fundIds = funds.map((fund) => fund.id);
  const code = new Map(funds.map((fund) => [fund.id, fund.code]));
  if (!fundIds.length) {
    failures.push('No allocation-eligible funds: nothing was tested.');
    return;
  }
  for (const deal of await dealsWithLegs(db)) {
    const started = Date.now();
    const rows = await observe(db, fundIds, deal.legs, deal.code, null, false);
    const { lines, errors } = solveDealObservations(rows);
    for (const message of errors) failures.push(`${deal.code}: evaluator error ${message}`);
    const legFor = (securityId: string, par: number) => ({ ...deal.legs.find((leg) => leg.security_id === securityId)!, par });
    for (const line of lines) {
      if (line.rankSensitive && line.capacity != null && line.capacity > 0) {
        line.capacity = await walkRankedCapacity(line, (par) => observe(db, [line.fundId], [legFor(line.securityId, par)], deal.code, [line.ruleCode], true));
      }
    }
    let verified = 0;
    for (const line of lines) {
      if (line.capacity == null || !Number.isFinite(line.capacity)) continue;
      const label = `${deal.code} ${code.get(line.fundId)} ${line.ruleCode} ${line.groupValue ?? ''}`.trim();
      const room = line.capacity;
      if (room > 0) {
        const at = await observe(db, [line.fundId], [legFor(line.securityId, room)], deal.code, [line.ruleCode], true);
        check(!newBreach(at, line), `${label}: buying the reported room ${room.toFixed(2)} breaches the rule`);
      }
      const over = room + Math.max(1000, room * 1e-4);
      const past = await observe(db, [line.fundId], [legFor(line.securityId, over)], deal.code, [line.ruleCode], true);
      check(newBreach(past, line), `${label}: buying ${over.toFixed(2)}, past the reported room ${room.toFixed(2)}, does not breach the rule`);
      verified += 1;
    }
    console.log(`${deal.code}: ${lines.length} capacity lines, ${verified} verified against the evaluator (${Date.now() - started} ms)`);
  }
}

async function parentIsSumOfChildren(db: Client) {
  const funds = await eligibleFunds(db);
  const children = new Map<string, string[]>();
  for (const fund of funds) {
    if (!fund.parent) continue;
    children.set(fund.parent, [...(children.get(fund.parent) || []), fund.id]);
  }
  const { rows: direct } = await db.query(`
    SELECT DISTINCT r.child_entity_id AS fund
    FROM entity_instances.entity_relationships r
    WHERE r.relationship_code = 'POSITION_FUND' AND r.system_to >= TIMESTAMP '9999-01-01'`);
  const holdsDirectly = new Set(direct.map((row) => row.fund));
  const deals = await dealsWithLegs(db);
  const legs = deals[0]?.legs.slice(0, 1) || [];
  if (!legs.length) return;
  for (const [parent, kids] of children) {
    if (holdsDirectly.has(parent)) continue;
    const rows = await observe(db, [parent, ...kids], legs, 'PARITY-CHECK', null, true);
    const { rows: consolidating } = await db.query(`
      SELECT r.rule_code FROM compliance.rules r
      WHERE (compliance.resolve_rule_version(r.id, $1::date, now())).consolidate_descendants
        AND (compliance.resolve_rule_version(r.id, $1::date, now())).numerator_aggregation = 'SUM'`, [AS_OF]);
    const consolidates = new Set(consolidating.map((row) => row.rule_code));
    const key = (row: DealObservationRow) => `${row.rule_code}|${row.group_value ?? ''}`;
    const parentRows = new Map(rows.filter((row) => row.fund_id === parent && row.base_numerator != null).map((row) => [key(row), row]));
    for (const [groupKey, parentRow] of parentRows) {
      if (!consolidates.has(parentRow.rule_code)) continue;
      const childRows = rows.filter((row) => kids.includes(row.fund_id) && key(row) === groupKey);
      // A child the rule does not cover for this deal has no row; compare only when every child has one.
      if (childRows.length !== kids.length) continue;
      const sum = childRows.reduce((total, row) => total + Number(row.base_numerator || 0), 0);
      const own = Number(parentRow.base_numerator);
      check(Math.abs(own - sum) <= 0.01, `${groupKey} on ${parent}: parent ${own} is not the sum of its child funds ${sum}`);
    }
  }
}

async function scorePlans(db: Client) {
  const funds = await eligibleFunds(db);
  const ids = funds.map((fund) => fund.id);
  const plans = async () => {
    const { rows } = await db.query(`SELECT rule_code, anchor_ids FROM compliance.deal_score_plans($1::uuid[], $2::date)`, [ids, AS_OF]);
    return new Map<string, string[]>(rows.map((row) => [row.rule_code, row.anchor_ids]));
  };
  const before = await plans();
  const { rows: surface } = await db.query(`SELECT rule_code FROM compliance.rules WHERE COALESCE((metadata->>'deal_surface')::boolean, false)`);
  for (const { rule_code } of surface) {
    check((before.get(rule_code) || []).length === ids.length, `deal_score_plans: deal-surface rule ${rule_code} does not cover every fund`);
  }

  const { rows: picked } = await db.query(`
    SELECT r.id, r.rule_code FROM compliance.rules r
    WHERE r.is_active AND r.anchor_domain_code = 'FUND' AND NOT COALESCE((r.metadata->>'deal_surface')::boolean, false)
      AND NOT EXISTS (SELECT 1 FROM compliance.rule_thresholds t WHERE t.rule_id = r.id AND t.entity_id = ANY ($1::uuid[]))
    ORDER BY r.rule_code LIMIT 1`, [ids]);
  if (!picked.length || ids.length < 2) return;
  const rule = picked[0];
  check(!before.has(rule.rule_code), `deal_score_plans: ${rule.rule_code} has no fund limits but is scored`);

  await db.query('BEGIN');
  try {
    // A rank band is a limit assigned to the fund: the rule is scored there only.
    await db.query(`INSERT INTO compliance.rule_thresholds (rule_id, entity_id, rank_from, hard_limit_value, applies) VALUES ($1, $2, 1, 10, TRUE)`, [rule.id, ids[0]]);
    let now = await plans();
    check(JSON.stringify(now.get(rule.rule_code)) === JSON.stringify([ids[0]]), `deal_score_plans: a rank band does not enroll only its fund (${JSON.stringify(now.get(rule.rule_code))})`);
    // An explicit opt-out wins over the band.
    await db.query(`INSERT INTO compliance.rule_thresholds (rule_id, entity_id, applies) VALUES ($1, $2, FALSE)`, [rule.id, ids[0]]);
    now = await plans();
    check(!now.has(rule.rule_code), 'deal_score_plans: an opt-out does not win over a rank band');
    // An inactive rule is not scored, even with a limit assigned.
    await db.query(`DELETE FROM compliance.rule_thresholds WHERE rule_id = $1 AND entity_id = $2 AND applies = FALSE`, [rule.id, ids[0]]);
    await db.query(`UPDATE compliance.rules SET is_active = FALSE WHERE id = $1`, [rule.id]);
    now = await plans();
    check(!now.has(rule.rule_code), 'deal_score_plans: an inactive rule is scored');
  } finally {
    await db.query('ROLLBACK');
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL to a database built from supabase/migrations.');
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await scorePlans(db);
    await parentIsSumOfChildren(db);
    await capacityParity(db);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM entity_instances.master_entities WHERE entity_code LIKE 'PF-%'`);
    check(rows[0].n === 0, `${rows[0].n} proforma legs were left behind`);
  } finally {
    await db.end();
  }
  if (failures.length) {
    console.error(`\n${failures.length} of ${checks} checks failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\nAll ${checks} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
