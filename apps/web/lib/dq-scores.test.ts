import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareScores, compositeScore, dimensionScore, scoreFromWeights, type ScoreWeights } from './dq-scores';

const fundA: ScoreWeights = {
  availabilityPassing: 8,
  availabilityApplicable: 10,
  qualityPassing: 12,
  qualityApplicable: 20,
  freshnessPassing: 7,
  freshnessApplicable: 8,
  consensusPassing: 3,
  consensusApplicable: 4,
  waivedChecks: 1,
};

const fundB: ScoreWeights = {
  availabilityPassing: 10,
  availabilityApplicable: 10,
  qualityPassing: 20,
  qualityApplicable: 20,
  freshnessPassing: 9,
  freshnessApplicable: 10,
  consensusPassing: 2,
  consensusApplicable: 2,
  waivedChecks: 0,
};

function add(left: ScoreWeights, right: ScoreWeights): ScoreWeights {
  return {
    availabilityPassing: left.availabilityPassing + right.availabilityPassing,
    availabilityApplicable: left.availabilityApplicable + right.availabilityApplicable,
    qualityPassing: left.qualityPassing + right.qualityPassing,
    qualityApplicable: left.qualityApplicable + right.qualityApplicable,
    freshnessPassing: left.freshnessPassing + right.freshnessPassing,
    freshnessApplicable: left.freshnessApplicable + right.freshnessApplicable,
    consensusPassing: left.consensusPassing + right.consensusPassing,
    consensusApplicable: left.consensusApplicable + right.consensusApplicable,
    waivedChecks: left.waivedChecks + right.waivedChecks,
  };
}

describe('data quality scores', () => {
  it('scores a record from the four dimensions and leaves a waiver out of the ratio', () => {
    const score = scoreFromWeights(fundA);
    assert.equal(score.availability, 80);
    assert.equal(score.quality, 60);
    assert.equal(score.freshness, 87.5);
    assert.equal(score.consensus, 75);
    assert.equal(score.score, 75.6);
    assert.equal(score.dimensionsApplied, 4);
    assert.equal(score.waivedChecks, 1);
  });

  it('drops a dimension with no checks and averages the ones that apply', () => {
    const score = scoreFromWeights({
      ...fundB,
      freshnessPassing: 0,
      freshnessApplicable: 0,
      consensusPassing: 0,
      consensusApplicable: 0,
    });
    assert.equal(score.freshness, null);
    assert.equal(score.consensus, null);
    assert.equal(score.score, 100);
    assert.equal(score.dimensionsApplied, 2);
  });

  it('leaves the score blank when nothing applies', () => {
    const score = scoreFromWeights(undefined);
    assert.equal(score.score, null);
    assert.equal(score.dimensionsApplied, 0);
    assert.equal(dimensionScore(0, 0), null);
    assert.equal(compositeScore([null, null]), null);
  });

  it('rolls entity types up from the checks, not from the average of record scores', () => {
    const pooled = scoreFromWeights(add(fundA, fundB));
    assert.equal(pooled.availability, 90);
    assert.equal(dimensionScore(18, 20), 90);
    const averageOfRecords = compositeScore([
      scoreFromWeights(fundA).score,
      scoreFromWeights(fundB).score,
    ]);
    assert.notEqual(pooled.score, averageOfRecords);
    assert.equal(pooled.waivedChecks, 1);
  });

  it('sorts the lowest score first and a blank score last', () => {
    const rows = [
      { score: null, label: 'Alpha' },
      { score: 90, label: 'Fund' },
      { score: 70, label: 'Deal' },
      { score: 70, label: 'Company' },
    ].sort(compareScores);
    assert.deepEqual(rows.map((row) => row.label), ['Company', 'Deal', 'Fund', 'Alpha']);
  });
});
