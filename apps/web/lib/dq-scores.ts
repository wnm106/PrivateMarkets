/** Weights behind one data-quality score. A zero applicable count means that dimension does not apply. */
export interface ScoreWeights {
  availabilityPassing: number;
  availabilityApplicable: number;
  qualityPassing: number;
  qualityApplicable: number;
  freshnessPassing: number;
  freshnessApplicable: number;
  consensusPassing: number;
  consensusApplicable: number;
  waivedChecks: number;
}

export interface QualityScore {
  score: number | null;
  availability: number | null;
  quality: number | null;
  freshness: number | null;
  consensus: number | null;
  dimensionsApplied: number;
  waivedChecks: number;
  weights: ScoreWeights;
}

function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 100 × passing / applicable, to one decimal. No applicable checks leaves the dimension blank. */
export function dimensionScore(passing: number, applicable: number): number | null {
  if (!(applicable > 0)) return null;
  return Math.round((1000 * passing) / applicable) / 10;
}

/** Average of the dimensions that apply, to one decimal. */
export function compositeScore(dimensions: Array<number | null>): number | null {
  const applied = dimensions.filter((value): value is number => value != null);
  if (applied.length === 0) return null;
  const mean = applied.reduce((sum, value) => sum + value, 0) / applied.length;
  return Math.round(mean * 10) / 10;
}

export function scoreFromWeights(weights: Partial<ScoreWeights> | null | undefined): QualityScore {
  const normalized: ScoreWeights = {
    availabilityPassing: count(weights?.availabilityPassing),
    availabilityApplicable: count(weights?.availabilityApplicable),
    qualityPassing: count(weights?.qualityPassing),
    qualityApplicable: count(weights?.qualityApplicable),
    freshnessPassing: count(weights?.freshnessPassing),
    freshnessApplicable: count(weights?.freshnessApplicable),
    consensusPassing: count(weights?.consensusPassing),
    consensusApplicable: count(weights?.consensusApplicable),
    waivedChecks: count(weights?.waivedChecks),
  };
  const availability = dimensionScore(normalized.availabilityPassing, normalized.availabilityApplicable);
  const quality = dimensionScore(normalized.qualityPassing, normalized.qualityApplicable);
  const freshness = dimensionScore(normalized.freshnessPassing, normalized.freshnessApplicable);
  const consensus = dimensionScore(normalized.consensusPassing, normalized.consensusApplicable);
  const dimensions = [availability, quality, freshness, consensus];
  return {
    score: compositeScore(dimensions),
    availability,
    quality,
    freshness,
    consensus,
    dimensionsApplied: dimensions.filter((value) => value != null).length,
    waivedChecks: normalized.waivedChecks,
    weights: normalized,
  };
}

/** Lowest score first. A blank score sorts last, then by label. */
export function compareScores(a: { score: number | null; label: string }, b: { score: number | null; label: string }): number {
  if (a.score == null && b.score == null) return a.label.localeCompare(b.label);
  if (a.score == null) return 1;
  if (b.score == null) return -1;
  return a.score - b.score || a.label.localeCompare(b.label);
}
