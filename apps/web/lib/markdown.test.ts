import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { followInternalLink, linkTarget, markdownToHtml } from './markdown';

describe('markdownToHtml', () => {
  it('renders every heading level, not only the first three', () => {
    const html = markdownToHtml('#### Consolidated Interest Coverage Ratio\n\n###### Small');
    assert.match(html, /<h4[^>]*>Consolidated Interest Coverage Ratio<\/h4>/);
    assert.match(html, /<h6[^>]*>Small<\/h6>/);
    assert.doesNotMatch(html, /####/);
  });

  it('typesets $$ formulas and leaves no LaTeX source showing', () => {
    const html = markdownToHtml('$$\\text{Ratio} = \\frac{\\text{Consolidated EBITDA}}{\\text{Interest Expense}}$$');
    assert.match(html, /class="md-math"/);
    assert.match(html, /class="katex/);
    assert.doesNotMatch(html, /\$\$/);
  });

  it('typesets \\( inline \\) formulas and leaves money alone', () => {
    const html = markdownToHtml('Coverage is \\(a/b\\) on $5M of debt and $3M of interest.');
    assert.match(html, /class="katex"/);
    assert.match(html, /\$5M of debt and \$3M/);
  });

  it('does not read underscores or asterisks in a formula as emphasis', () => {
    const html = markdownToHtml('$$x_1 * y_2 * z$$');
    assert.doesNotMatch(html, /<em>/);
  });

  it('turns > lines into one block quote with its formatting', () => {
    const html = markdownToHtml('> **Quote:** "the ratio of (a) to (b)"\n> **Citation:** page 18\n\nAfter');
    assert.equal((html.match(/<blockquote/g) || []).length, 1);
    assert.match(html, /<blockquote class="md-quote"><strong>Quote:<\/strong>/);
    assert.doesNotMatch(html, /&gt; /);
  });

  it('routes app paths in place and opens outside links in a new tab', () => {
    const html = markdownToHtml('[Credit Agreement, page 18](/documents/abc?at=1200) and [site](https://example.com)');
    assert.match(html, /<a href="\/documents\/abc\?at=1200" data-internal="1" class="md-link">Credit Agreement, page 18<\/a>/);
    assert.match(html, /<a href="https:\/\/example.com" target="_blank"/);
  });

  it('resolves entity: links to the record page', () => {
    const html = markdownToHtml('[Acme Fund III](entity:FUND/1234-abcd)');
    assert.match(html, /href="\/funds\/1234-abcd" data-internal="1"/);
  });

  it('keeps underscores in a link path', () => {
    const html = markdownToHtml('[Flow](/cash_flows/x_y_z)');
    assert.match(html, /href="\/cash_flows\/x_y_z"/);
  });

  it('never links an unsafe target', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,hi', '//evil.example', 'vbscript:x']) {
      const html = markdownToHtml(`[click](${href})`);
      assert.doesNotMatch(html, /<a /, href);
      assert.match(html, /click/);
    }
  });

  it('draws --- as a rule and leaves a list item alone', () => {
    const html = markdownToHtml('Above\n\n---\n\n- item');
    assert.match(html, /<hr class="md-rule"\/>/);
    assert.doesNotMatch(html, /---/);
    assert.match(html, /<li[^>]*>item<\/li>/);
  });

  it('keeps a table separator out of rules', () => {
    const html = markdownToHtml('| A | B |\n| --- | --- |\n| 1 | 2 |');
    assert.doesNotMatch(html, /<hr/);
    assert.match(html, /<th>A<\/th>/);
  });

  it('keeps code exactly as written', () => {
    const html = markdownToHtml('Run `a_b_c` and\n\n```\n**not bold** $$x$$\n```');
    assert.match(html, /<code[^>]*>a_b_c<\/code>/);
    assert.match(html, /\*\*not bold\*\* \$\$x\$\$/);
  });
});

describe('linkTarget', () => {
  it('tells app paths from outside ones', () => {
    assert.deepEqual(linkTarget('/funds/1'), { href: '/funds/1', internal: true });
    assert.deepEqual(linkTarget('mailto:a@b.c'), { href: 'mailto:a@b.c', internal: false });
    assert.equal(linkTarget('/\\evil.example'), null);
  });
});

describe('followInternalLink', () => {
  function click(href: string | null, extra: Partial<{ metaKey: boolean; button: number }> = {}) {
    let prevented = false;
    let pushed: string | null = null;
    const anchor = href == null ? null : { getAttribute: () => href };
    followInternalLink({
      target: { closest: () => anchor } as unknown as EventTarget,
      defaultPrevented: false,
      button: extra.button ?? 0,
      metaKey: extra.metaKey ?? false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => { prevented = true; },
    }, (to) => { pushed = to; });
    return { prevented, pushed };
  }

  it('routes a plain click on an in-app link', () => {
    assert.deepEqual(click('/documents/a?at=3'), { prevented: true, pushed: '/documents/a?at=3' });
  });

  it('leaves a modified click to the browser', () => {
    assert.deepEqual(click('/documents/a', { metaKey: true }), { prevented: false, pushed: null });
  });

  it('ignores clicks outside a link', () => {
    assert.deepEqual(click(null), { prevented: false, pushed: null });
  });
});
