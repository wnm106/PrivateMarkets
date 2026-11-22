import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { combinePageData, withoutSources } from './view-context';

const nav = { label: 'NAV', purpose: 'What the fund is worth.', howToRead: 'Dollars.', data: { nav: 100 } };
const returns = { label: 'Returns', purpose: 'How the fund performed.', data: null };

describe('combinePageData', () => {
  it('returns the page data unchanged when no tab is published', () => {
    assert.deepEqual(combinePageData({ a: 1 }, []), { a: 1 });
    assert.equal(combinePageData(null, [{ key: 'nav', entry: null }]), null);
  });

  it('lists every published tab under tabs, not only one', () => {
    const result = combinePageData({ fund: 'F1' }, [{ key: 'nav', entry: nav }, { key: 'returns', entry: returns }]) as Record<string, any>;
    assert.equal(result.fund, 'F1');
    assert.deepEqual(Object.keys(result.tabs), ['nav', 'returns']);
    assert.deepEqual(result.tabs.nav, { label: 'NAV', purpose: 'What the fund is worth.', howToRead: 'Dollars.', data: { nav: 100 } });
  });

  it('says a tab has not loaded instead of publishing empty data', () => {
    const result = combinePageData(null, [{ key: 'returns', entry: returns }]) as Record<string, any>;
    assert.equal(result.tabs.returns.data, undefined);
    assert.match(result.tabs.returns.note, /not finished loading/);
  });

  it('lets a loaded tab replace the surface\'s placeholder for it, whichever was published first', () => {
    const placeholder = { label: 'NAV', purpose: 'What the fund is worth.', data: null };
    for (const order of [[placeholder, nav], [nav, placeholder]]) {
      const result = combinePageData(null, order.map((entry) => ({ key: 'nav', entry }))) as Record<string, any>;
      assert.deepEqual(result.tabs.nav.data, { nav: 100 });
    }
    const pending = combinePageData(null, [{ key: 'nav', entry: placeholder }]) as Record<string, any>;
    assert.match(pending.tabs.nav.note, /not finished loading/);
  });

  it('leaves out howToRead when a tab has none', () => {
    const result = combinePageData(null, [{ key: 'returns', entry: returns }]) as Record<string, any>;
    assert.equal('howToRead' in result.tabs.returns, false);
  });
});

describe('withoutSources', () => {
  it('removes source references at any depth and keeps everything else', () => {
    const value = {
      name: 'Fee',
      sources: [{ id: 1 }],
      rows: [{ admin: 5, adminSources: [{ id: 2 }], nested: { oursSources: [], keep: true } }],
    };
    assert.deepEqual(withoutSources(value), { name: 'Fee', rows: [{ admin: 5, nested: { keep: true } }] });
  });

  it('passes primitives and null through', () => {
    assert.equal(withoutSources(3), 3);
    assert.equal(withoutSources(null), null);
  });
});
