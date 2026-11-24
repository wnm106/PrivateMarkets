/** Which attribute, on which record, each displayed value comes from. Right-click opens these. */
import type { BindTarget } from '../components/common';
import type { Band, Commitment, Deal, Fund, Lens, TargetScope } from './types';
import { targetKey } from './types';
import type { Measure } from './format';
import type { Suf, TreeNode } from './tree';
import { ATTR, TARGET, TARGET_ATTR } from './data';

const onFund = (f: Pick<Fund, 'id' | 'name'>, code: string, name: string): BindTarget => ({ entityId: f.id, entityName: f.name, domainCode: 'FUND', code, name });

export const fundBind = {
  program: (f: Pick<Fund, 'id' | 'name'>) => onFund(f, ATTR.programUsd, 'Program size'),
  count: (f: Pick<Fund, 'id' | 'name'>) => onFund(f, ATTR.programN, 'Target investment count'),
  annual: (f: Pick<Fund, 'id' | 'name'>) => onFund(f, ATTR.annual, 'Annual deployment target'),
  basis: (f: Pick<Fund, 'id' | 'name'>) => onFund(f, ATTR.basis, 'Target percent basis'),
  start: (f: Pick<Fund, 'id' | 'name'>) => onFund(f, ATTR.start, 'Investment period start'),
  end: (f: Pick<Fund, 'id' | 'name'>) => onFund(f, ATTR.end, 'Investment period end'),
};

/**
 * One value of one target: its own attribute on the allocation target record for that fund,
 * hierarchy and level. Null when the level has no record yet, so there is nothing to open.
 */
export function targetBind(f: Fund, scope: TargetScope, level: string, field: keyof Band): BindTarget | null {
  const record = f.targets[targetKey(scope, level)];
  if (!record) return null;
  return { entityId: record.id, entityName: record.name, domainCode: TARGET.domain, code: TARGET_ATTR[field].code, name: TARGET_ATTR[field].name };
}

/**
 * The attribute a shown target figure comes from. A dollar figure may be typed, or implied by
 * a typed percent (and the other way round), so this finds the value that was actually
 * entered: the measure's own target, then its minimum or maximum, then the other measure's.
 */
export function shownTargetBind(f: Fund, lens: Lens, level: string, k: Measure): BindTarget | null {
  const band = f.matrix[lens][level];
  if (!band) return null;
  const own: Array<keyof Band> = [k, `${k}Min`, `${k}Max`] as Array<keyof Band>;
  const other: Array<keyof Band> = k === 'usd' ? ['pct', 'pctMin', 'pctMax'] : k === 'pct' ? ['usd', 'usdMin', 'usdMax'] : [];
  const field = [...own, ...other].find((x) => band[x] != null);
  return field ? targetBind(f, lens, level, field) : null;
}

/** A year's own deployment target, when it has one; else the annual target it falls back to. */
export function yearTargetBind(f: Fund, year: number | string): BindTarget {
  return (f.overrides[String(year)] != null ? targetBind(f, 'year', String(year), 'usd') : null) ?? fundBind.annual(f);
}

/**
 * The attribute behind one cell of the target grid: the program's own size and count for the
 * Total program target, else that level's own minimum, target or maximum. Null for a level
 * that has no target record yet.
 */
export function cellBind(f: Fund, lens: Lens, node: TreeNode, k: Measure, suf: Suf): BindTarget | null {
  if (node.depth === 0 && suf === '' && k === 'usd') return fundBind.program(f);
  if (node.depth === 0 && suf === '' && k === 'n') return fundBind.count(f);
  const field = `${k}${suf}` as keyof Band;
  return node.depth === 0 ? targetBind(f, 'program', '', field) : targetBind(f, lens, node.key, field);
}

const onPosition = (c: Pick<Commitment, 'id' | 'name'>, code: string, name: string): BindTarget => ({ entityId: c.id, entityName: c.name, domainCode: 'POSITION', code, name });
const onSecurity = (c: Pick<Commitment, 'securityId' | 'asset'>, code: string, name: string): BindTarget => ({ entityId: c.securityId, entityName: c.asset, domainCode: 'SECURITY', code, name });

export const commitmentBind = {
  amount: (c: Commitment) => onPosition(c, ATTR.amount, 'Original commitment'),
  date: (c: Commitment) => onPosition(c, ATTR.tradeDate, 'Commit date'),
  allocationYear: (c: Commitment) => onPosition(c, ATTR.allocationYear, 'Allocation tranche'),
  currency: (c: Commitment) => onPosition(c, 'POSITION_CURRENCY', 'Commitment currency'),
  contractual: (c: Commitment) => onPosition(c, 'OCIO_CONTRACTUAL_REVIEW', 'Contractual review'),
  esg: (c: Commitment) => onPosition(c, 'OCIO_ESG_REVIEW', 'ESG questionnaire'),
  strategyReview: (c: Commitment) => onPosition(c, 'OCIO_STRATEGY_REVIEW', 'Strategy questionnaire'),
};

/** Classification and security-master fields live on the underlying investment. */
export const SECURITY_FIELDS = {
  cat: ['OCIO_CATEGORY', 'Category'],
  ac: ['OCIO_ASSET_CLASS', 'Asset class'],
  st: ['OCIO_STRATEGY', 'Strategy'],
  sub: ['OCIO_SUB_STRATEGY', 'Sub-strategy'],
  rg: ['OCIO_REGION', 'Region'],
  ty: ['OCIO_STRUCTURE_TYPE', 'Structure type'],
  det: ['OCIO_STRUCTURE_DETAIL', 'Structure detail'],
  manager: [ATTR.manager, 'Manager'],
  asset: [ATTR.asset, 'Underlying asset'],
  investmentType: ['OCIO_INVESTMENT_TYPE', 'Investment type'],
  market: ['OCIO_MARKET', 'Market'],
  country: ['OCIO_COUNTRY_FOCUS', 'Country focus'],
  sector: ['OCIO_SECTOR', 'Sector'],
  fundSize: [ATTR.fundSize, 'Underlying fund size'],
  firstTime: ['OCIO_FIRST_TIME_FUND', 'First-time fund'],
  relationship: ['OCIO_RELATIONSHIP', 'Relationship'],
} as const;

export function securityBind(c: Pick<Commitment, 'securityId' | 'asset'>, field: keyof typeof SECURITY_FIELDS): BindTarget {
  const [code, name] = SECURITY_FIELDS[field];
  return onSecurity(c, code, name);
}

const onDeal = (d: Pick<Deal, 'id' | 'name'>, code: string, name: string): BindTarget => ({ entityId: d.id, entityName: d.name, domainCode: 'DEAL', code, name });

export const dealBind = {
  size: (d: Deal) => onDeal(d, ATTR.dealSize, 'Deal value'),
  stage: (d: Deal) => onDeal(d, ATTR.dealStage, 'Deal stage'),
  close: (d: Deal) => onDeal(d, ATTR.dealClose, 'Target close date'),
};

export const trancheBind = (t: { id: string; name: string }): BindTarget => ({ entityId: t.id, entityName: t.name, domainCode: 'DEAL_TRANCHE', code: ATTR.trancheHold, name: 'Hold amount' });

export const planBind = {
  amount: (p: { id: string; name: string }): BindTarget => ({ entityId: p.id, entityName: p.name, domainCode: 'DEAL_FUNDING_PLAN', code: ATTR.planAmount, name: 'Allocation amount' }),
  ratio: (p: { id: string; name: string }): BindTarget => ({ entityId: p.id, entityName: p.name, domainCode: 'DEAL_FUNDING_PLAN', code: ATTR.planRatio, name: 'Sharing ratio' }),
  status: (p: { id: string; name: string }): BindTarget => ({ entityId: p.id, entityName: p.name, domainCode: 'DEAL_FUNDING_PLAN', code: ATTR.planStatus, name: 'Funding status' }),
};
