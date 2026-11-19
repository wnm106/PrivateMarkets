import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NeedsYouItem, ReviewSource } from './home';
import { isNarrowed, narrowNeedsYou, parseScope, universeLabel, type Universe } from './home-universe';

const universe = (patch: Partial<Universe> = {}): Universe => ({ hasAny: true, followed: 0, responsibleRecords: 0, responsibleDomains: [], reviewIds: [], ...patch });

function item(id: string, kind: NeedsYouItem['kind']): NeedsYouItem {
  return { id, lane: kind === 'review' ? 'decide' : 'fix', kind, group: id, groupTitle: id, urgency: 'normal', title: id, detail: '', href: '/', action: 'Open', at: '2026-11-18T10:00:00Z' };
}

const review = (id: string): ReviewSource => ({ id, runId: `run-${id}`, title: id, itemCount: 1, canReview: true, createdAt: '2026-11-18T10:00:00Z' });

describe('home universe', () => {
  it('defaults to the narrower view, and only narrows when there is a universe', () => {
    assert.equal(parseScope(null), 'mine');
    assert.equal(parseScope('all'), 'all');
    assert.equal(parseScope('nonsense'), 'mine');
    assert.equal(isNarrowed(null, 'mine'), false);
    assert.equal(isNarrowed(universe({ hasAny: false }), 'mine'), false);
    assert.equal(isNarrowed(universe(), 'mine'), true);
    assert.equal(isNarrowed(universe(), 'all'), false);
  });

  it('says what the universe is made of', () => {
    assert.equal(universeLabel(universe()), 'nothing yet');
    assert.equal(universeLabel(universe({ followed: 2 })), '2 records you follow');
    assert.equal(universeLabel(universe({ responsibleRecords: 1 })), '1 record you are responsible for');
    assert.equal(universeLabel(universe({ followed: 2, responsibleRecords: 1 })), '2 records you follow and 1 you are responsible for');
    assert.equal(
      universeLabel(universe({ followed: 1, responsibleRecords: 3, responsibleDomains: ['FUND', 'ISSUER'] })),
      '1 record you follow, 3 you are responsible for, and every FUND and ISSUER',
    );
  });

  it('narrows reviews to the person’s own and leaves everything else', () => {
    const items = [item('review-a', 'review'), item('review-b', 'review'), item('job-1', 'job-failed'), item('file-1', 'file-failed')];
    const reviews = [review('a'), review('b')];
    const all = narrowNeedsYou(items, reviews, ['a'], false);
    assert.equal(all.items.length, 4);
    assert.equal(all.hiddenReviews, 0);
    const mine = narrowNeedsYou(items, reviews, ['a'], true);
    assert.deepEqual(mine.items.map((entry) => entry.id), ['review-a', 'job-1', 'file-1']);
    assert.deepEqual(mine.reviews.map((entry) => entry.id), ['a']);
    assert.equal(mine.hiddenReviews, 1);
    assert.equal(narrowNeedsYou(items, reviews, [], true).reviews.length, 0);
  });
});
