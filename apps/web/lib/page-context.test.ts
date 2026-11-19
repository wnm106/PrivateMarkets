import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { routeChatContext } from './page-context';

describe('routeChatContext', () => {
  it('names a surface by its title, not the s prefix', () => {
    assert.equal(routeChatContext('/s/deal-pipeline').page, 'Deal Pipeline');
    assert.equal(routeChatContext('/s/fund-index').page, 'Fund Index');
  });

  it('keeps the deal id on a deal workspace route', () => {
    const route = routeChatContext('/deals/55537801-66b2-4e43-957c-c71f541a590f/allocation');
    assert.equal(route.page, 'Deal · Allocation');
    assert.equal(route.domainCode, 'DEAL');
    assert.equal(route.entityId, '55537801-66b2-4e43-957c-c71f541a590f');
  });
});
