/**
 * Sharing ratios for a pipeline deal: the one home for the allocation math.
 *
 * A sleeve's profile allocation is its program times its strategy target share for the
 * deal's profile, times its region share when one is set. What is left of it, spread over
 * the years left in its investment period, is its annual need. The sharing ratio is each
 * eligible sleeve's annual need over the total. The deal's hold is split by ratio, capped
 * by each sleeve's compliance capacity (from the engine) and target-max headroom.
 */
import type { Commitment, Deal, Fund } from './types';
import { actualMap, effUsd, effUsdK, tagKeys, type Trees } from './tree';
import { endOf, startOf, yearsLeft } from './pacing';
import { commitmentsOf } from './tree';

export interface Profile {
  programUsd: number;
  strategyKey: string | null;
  strategyPct: number;
  regionPct: number | null;
  regionSource: 'sleeve' | 'client' | 'none';
  allocUsd: number;
  deployed: number;
  inProfile: number;
  remaining: number;
  start: Date;
  end: Date;
  years: number;
  annual: number;
  excluded: boolean;
  reason: string;
  eligible: boolean;
  targeted: boolean;
}

export function profileFor(m: Fund, d: Deal, funds: Fund[], all: Commitment[], trees: Trees, asOf: Date, excluded: boolean): Profile {
  const prog = m.programUsd || 0;
  let sKey: string | null = null;
  let sUsd: number | null = null;
  for (const k of tagKeys(d.tags, 'strategy').slice(1)) {
    const n = trees.nodes.strategy[k];
    if (!n) break;
    if (m.matrix.strategy[k]) {
      const u = effUsd(m, 'strategy', n);
      if (u != null) { sKey = k; sUsd = u; }
    }
  }
  const strategyPct = sKey && prog && sUsd != null ? sUsd / prog : 0;
  const rn = d.tags.rg ? trees.nodes.region[d.tags.rg] : undefined;
  let regionPct: number | null = null;
  let regionSource: Profile['regionSource'] = 'none';
  if (rn) {
    const own = m.matrix.region[rn.key] ? effUsd(m, 'region', rn) : null;
    if (own != null && prog) { regionPct = own / prog; regionSource = 'sleeve'; }
    else {
      const c = funds.find((f) => f.id === m.parentId);
      const theirs = c && c.matrix.region[rn.key] ? effUsd(c, 'region', rn) : null;
      if (c && theirs != null) { regionPct = theirs / (c.programUsd || 1); regionSource = 'client'; }
    }
  }
  const allocUsd = prog * strategyPct * (regionPct ?? 1);
  const mine = commitmentsOf(m, funds, all);
  const inProfile = mine.filter((c) => sKey && tagKeys(c.tags, 'strategy').includes(sKey) && (regionPct == null || c.tags.rg === d.tags.rg));
  const deployed = inProfile.reduce((s, c) => s + c.amount, 0);
  const remaining = allocUsd - deployed;
  const years = yearsLeft(m, asOf);
  const annual = years > 0 ? Math.max(0, remaining) / years : 0;
  const reason = !sKey ? 'No target for this profile' : excluded ? 'Excluded' : years <= 0 ? 'Investment period ended' : remaining <= 0 ? 'Profile fully deployed' : '';
  return {
    programUsd: prog, strategyKey: sKey, strategyPct, regionPct, regionSource, allocUsd, deployed, inProfile: inProfile.length,
    remaining, start: startOf(m, asOf), end: endOf(m, asOf), years, annual, excluded, reason, eligible: !reason, targeted: !!sKey,
  };
}

/** Headroom under the sleeve's typed maximums at the deal's levels. Null when no maximum applies. */
export function targetHeadroom(m: Fund, d: Deal, list: Commitment[], trees: Trees): { cap: number; basis: string } | null {
  let best: { cap: number; basis: string } | null = null;
  for (const lens of ['strategy', 'region'] as const) {
    const A = actualMap(list, lens);
    for (const k of tagKeys(d.tags, lens).slice(1)) {
      const n = trees.nodes[lens][k];
      if (!n || !m.matrix[lens][k]) continue;
      const mx = effUsdK(m, lens, n, 'Max');
      if (mx == null) continue;
      const cap = mx - (A[k]?.usd || 0);
      if (!best || cap < best.cap) best = { cap, basis: `${n.name} max` };
    }
  }
  return best;
}

export interface AllocRow {
  fund: Fund;
  profile: Profile;
  /** Compliance capacity from the engine; null when no rule caps the buy. */
  engineCap: number | null;
  headroom: { cap: number; basis: string } | null;
  capacity: number;
  binding: string | null;
  ratio: number;
  alloc: Array<number | null>;
  proRata: number[];
  overridden: boolean[];
  capped: boolean;
  total: number;
  overCap: boolean;
}

export interface Allocation {
  rows: AllocRow[];
  unallocated: number[];
  allocated: number;
  hold: number;
}

export interface AllocInput {
  fund: Fund;
  profile: Profile;
  engineCap: number | null;
  bindingRule: string | null;
  headroom: { cap: number; basis: string } | null;
}

/** Split each tranche by sharing ratio, filling capped sleeves to their capacity first. */
export function runAllocation(d: Deal, inputs: AllocInput[], overrides: Record<string, Record<number, number>>): Allocation {
  const rows: AllocRow[] = inputs.map((x) => {
    const caps = [x.engineCap ?? Infinity, x.headroom ? Math.max(0, x.headroom.cap) : Infinity];
    const capacity = Math.max(0, Math.min(...caps));
    const binding = capacity === Infinity ? null : caps[0] <= caps[1] ? x.bindingRule : x.headroom?.basis ?? null;
    return { fund: x.fund, profile: x.profile, engineCap: x.engineCap, headroom: x.headroom, capacity, binding, ratio: 0, alloc: d.tranches.map(() => null), proRata: [], overridden: d.tranches.map(() => false), capped: false, total: 0, overCap: false };
  });
  const tot = rows.filter((r) => r.profile.eligible).reduce((s, r) => s + r.profile.annual, 0);
  rows.forEach((r) => { r.ratio = r.profile.eligible && tot ? r.profile.annual / tot : 0; });
  const left = new Map(rows.map((r) => [r.fund.id, r.capacity]));
  const unallocated = d.tranches.map((t, ti) => {
    let pool = t.hold;
    rows.forEach((r) => {
      const o = overrides[r.fund.id]?.[ti];
      if (o != null) { r.alloc[ti] = o; r.overridden[ti] = true; pool -= o; left.set(r.fund.id, (left.get(r.fund.id) ?? 0) - o); }
    });
    let active = rows.filter((r) => r.ratio > 0 && r.alloc[ti] == null);
    active.forEach((r) => { r.alloc[ti] = 0; });
    for (let g = 0; pool > 0.5 && active.length && g < 25; g += 1) {
      const w = active.reduce((s, r) => s + r.ratio, 0);
      const capped = active.filter((r) => (pool * r.ratio) / w > Math.max(0, left.get(r.fund.id) ?? 0) + 1);
      if (!capped.length) {
        active.forEach((r) => { const a = (pool * r.ratio) / w; r.alloc[ti] = (r.alloc[ti] ?? 0) + a; left.set(r.fund.id, (left.get(r.fund.id) ?? 0) - a); });
        pool = 0;
        break;
      }
      capped.forEach((r) => { const a = Math.max(0, left.get(r.fund.id) ?? 0); r.alloc[ti] = (r.alloc[ti] ?? 0) + a; pool -= a; left.set(r.fund.id, (left.get(r.fund.id) ?? 0) - a); r.capped = true; });
      active = active.filter((r) => !capped.includes(r));
    }
    rows.forEach((r) => { r.proRata[ti] = t.hold * r.ratio; });
    return Math.max(0, pool);
  });
  rows.forEach((r) => { r.total = r.alloc.reduce<number>((s, a) => s + (a || 0), 0); r.overCap = r.total > r.capacity + 1; });
  return { rows, unallocated, allocated: rows.reduce((s, r) => s + r.total, 0), hold: d.tranches.reduce((s, t) => s + t.hold, 0) };
}
