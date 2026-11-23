import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { certifyBlockedBy, figureChanges, replacedDependencies, standing, surfaceDates, versionsFor, type Certification } from './certification';

const certification: Certification = {
  id: 'c1',
  processCode: 'FUND_CLOSE',
  subjectEntityId: 'close-1',
  periodEnd: '2026-09-30',
  asOfDate: '2026-10-20',
  knowledgeAt: '2026-10-21T14:03:11.250Z',
  figures: {
    nav: { label: 'Certified NAV', value: 101_250_000.25 },
    breaks: { label: 'Breaks', value: 0 },
    outcome: { label: 'Outcome', value: 'Tied' },
  },
  fingerprint: 'x',
  note: null,
  certifiedBy: 'Pat',
  certifiedAt: '2026-10-21T14:03:11.250Z',
  version: 1,
  supersedesId: null,
  dependsOn: [],
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
};

const user = { asOfDate: '2026-11-22', knowledgeDate: '2026-11-22' };

describe('surface dates', () => {
  it('reads at the certified As Of date and knowledge instant', () => {
    const dates = surfaceDates(user, certification);
    assert.equal(dates.asOfDate, '2026-10-20');
    assert.equal(dates.knowledgeDate, '2026-10-21T14:03:11.250Z');
    assert.match(String(dates.pinnedBy), /^Certified .* by Pat$/);
  });

  it('follows the user when not certified, reopened, or asked for current data', () => {
    assert.deepEqual(surfaceDates(user, null), { ...user, pinnedBy: null, asOfKeptBy: null });
    assert.deepEqual(surfaceDates(user, { ...certification, revokedAt: '2026-11-01T00:00:00Z' }), { ...user, pinnedBy: null, asOfKeptBy: null });
    assert.deepEqual(surfaceDates(user, certification, 'current'), { ...user, pinnedBy: null, asOfKeptBy: null });
  });

  it('keeps the As Of date of a reopened certification and rolls knowledge forward', () => {
    const reopened = { ...certification, revokedAt: '2026-11-03T09:12:00Z', revokedBy: 'Sam', revokeReason: 'NAV restated' };
    const dates = surfaceDates(user, null, 'certified', reopened);
    assert.equal(dates.asOfDate, '2026-10-20');
    assert.equal(dates.knowledgeDate, '2026-11-22');
    assert.equal(dates.pinnedBy, null);
    assert.match(String(dates.asOfKeptBy), /^Version 1, reopened .* by Sam: NAV restated$/);
  });
});

describe('versions', () => {
  const v1 = { ...certification, revokedAt: '2026-11-03T09:12:00Z', revokeReason: 'NAV restated' };
  const v2 = { ...certification, id: 'c2', version: 2, supersedesId: 'c1', knowledgeAt: '2026-11-04T10:00:00Z', certifiedAt: '2026-11-04T10:00:00Z' };
  const other = { ...certification, id: 'c9', periodEnd: '2026-08-31' };

  it('keeps one period, newest version first', () => {
    assert.deepEqual(versionsFor([v1, other, v2], '2026-09-30').map((item) => item.id), ['c2', 'c1']);
  });

  it('finds the certification in force, or the reopened one to replace', () => {
    assert.deepEqual(standing([v2, v1]), { active: v2, reopened: null });
    assert.deepEqual(standing([v1]), { active: null, reopened: v1 });
    assert.deepEqual(standing([]), { active: null, reopened: null });
  });

  it('names the certifications read against that were reopened since', () => {
    const october = {
      ...certification,
      dependencies: [
        { id: 'c1', processCode: 'FUND_CLOSE', periodEnd: '2026-09-30', version: 1, certifiedAt: v1.certifiedAt, revokedAt: v1.revokedAt, revokedBy: null, revokeReason: 'NAV restated' },
        { id: 'c5', processCode: 'FUND_CLOSE', periodEnd: '2026-08-31', version: 1, certifiedAt: v1.certifiedAt, revokedAt: null, revokedBy: null, revokeReason: null },
      ],
    };
    assert.deepEqual(replacedDependencies(october).map((item) => item.id), ['c1']);
    assert.deepEqual(replacedDependencies(certification), []);
  });
});

describe('figure changes', () => {
  it('finds nothing when the later read matches, rounding aside', () => {
    const current = {
      nav: { label: 'Certified NAV', value: 101_250_000.251 },
      breaks: { label: 'Breaks', value: 0 },
      outcome: { label: 'Outcome', value: 'Tied' },
      extra: { label: 'Not certified', value: 5 },
    };
    assert.deepEqual(figureChanges(certification.figures, current), []);
  });

  it('lists each certified figure that reads differently, and one that is gone', () => {
    const current = {
      nav: { label: 'Certified NAV', value: 101_400_000 },
      breaks: { label: 'Breaks', value: 0 },
    };
    assert.deepEqual(figureChanges(certification.figures, current), [
      { key: 'nav', label: 'Certified NAV', certified: 101_250_000.25, current: 101_400_000 },
      { key: 'outcome', label: 'Outcome', certified: 'Tied', current: null },
    ]);
  });

  it('has nothing to compare until both reads exist', () => {
    assert.deepEqual(figureChanges(certification.figures, null), []);
    assert.deepEqual(figureChanges(null, certification.figures), []);
  });
});

describe('certify blocked by', () => {
  it('allows certifying at current knowledge only', () => {
    assert.equal(certifyBlockedBy('2026-11-22', '2026-11-22'), null);
    assert.equal(certifyBlockedBy('', '2026-11-22'), null);
    assert.match(String(certifyBlockedBy('2026-11-01', '2026-11-22')), /as known on 2026-11-01/);
  });
});
