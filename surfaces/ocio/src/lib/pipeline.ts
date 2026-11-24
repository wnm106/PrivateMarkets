/** The pipeline list: what each deal offers our sleeves and what is staged for review. */
import type { Deal, OcioData } from './types';
import { parseDay } from './format';

export interface DealView {
  deal: Deal;
  hold: number;
  stageLabel: string;
  closeDays: number | null;
  staged: number;
}

export function dealViews(data: OcioData, asOf: Date): DealView[] {
  return data.deals.map((d) => {
    const close = parseDay(d.close);
    return {
      deal: d,
      hold: d.tranches.reduce((s, t) => s + t.hold, 0),
      stageLabel: data.stages.find((s) => s.code === d.stage)?.label || d.stage || '—',
      closeDays: close ? Math.round((close.getTime() - asOf.getTime()) / 864e5) : null,
      staged: d.plans.reduce((s, p) => s + (p.amount || 0), 0),
    };
  });
}

