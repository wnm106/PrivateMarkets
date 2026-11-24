/**
 * The house kit: the part of the app's stylesheet a surface is built from,
 * and a reference screen written with it.
 *
 * The Surface Builder gives the kit to the model that redesigns a prototype's
 * views, and loads the same kit into every preview, so what the model writes
 * renders the way it would in the app. The kit is read from the real
 * stylesheet (apps/web/styles/globals.css), not restated, so it follows the
 * app as the app changes.
 */

/** Class families a surface may use: the deal allocation and fund surfaces, the pipeline, record blocks, and shared chrome. */
const FAMILY = /^(da|crumbs|crumb-[\w-]+|page-[\w-]+|btn|btn-[\w-]+|data-table|mono|status-(pill|chip|dot)|(da|fs|cr|pipe|rb)-[\w-]+)$/;
/** A short state or variant class used with a family class, such as .on, .sel, .num or .big. */
const MODIFIER = /^[a-z]{1,12}$/;

interface CssNode {
  prelude: string;
  /** Declarations of a style rule. */
  body?: string;
  /** Children of an at-rule block. */
  children?: CssNode[];
}

/** Parse CSS into rules and at-rule blocks. Statements outside braces (@tailwind, @import) are dropped. */
function parse(css: string): CssNode[] {
  let index = 0;
  const block = (): CssNode[] => {
    const nodes: CssNode[] = [];
    let prelude = '';
    while (index < css.length) {
      const char = css[index];
      if (char === '}') {
        index += 1;
        return nodes;
      }
      if (char === ';') {
        prelude = '';
        index += 1;
        continue;
      }
      if (char === '{') {
        index += 1;
        const head = prelude.trim();
        prelude = '';
        if (head.startsWith('@') && !/^@(font-face|page)\b/.test(head) && !/^@keyframes\b/.test(head)) {
          nodes.push({ prelude: head, children: block() });
        } else {
          // A style rule (or a keyframes/font-face block): read to its matching brace.
          let depth = 1;
          const start = index;
          while (index < css.length && depth > 0) {
            if (css[index] === '{') depth += 1;
            else if (css[index] === '}') depth -= 1;
            index += 1;
          }
          nodes.push({ prelude: head, body: css.slice(start, index - 1).trim() });
        }
        continue;
      }
      prelude += char;
      index += 1;
    }
    return nodes;
  };
  return block();
}

/** Split a selector list on commas that are not inside parentheses or brackets. */
function selectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function keepSelector(selector: string, inBase: boolean): boolean {
  // Pseudo-class arguments (:not(.on)) are part of the state, not new classes.
  const classes = [...selector.replace(/:not\([^)]*\)/g, '').matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]);
  if (classes.length === 0) return inBase && !/^@/.test(selector);
  return classes.some((name) => FAMILY.test(name)) && classes.every((name) => FAMILY.test(name) || MODIFIER.test(name));
}

function emit(nodes: CssNode[], inBase: boolean, out: string[]): void {
  for (const node of nodes) {
    if (node.children) {
      if (/^@layer\b/.test(node.prelude)) {
        emit(node.children, /\bbase\b/.test(node.prelude), out);
      } else if (/^@media\b/.test(node.prelude)) {
        const inner: string[] = [];
        emit(node.children, inBase, inner);
        if (inner.length) out.push(`${node.prelude} {\n${inner.join('\n')}\n}`);
      }
      continue;
    }
    if (node.prelude.startsWith('@')) continue;
    const kept = selectors(node.prelude).filter((selector) => keepSelector(selector, inBase));
    if (kept.length && node.body) out.push(`${kept.join(', ')} { ${node.body.replace(/\s+/g, ' ')} }`);
  }
}

/** The house kit out of the app stylesheet: tokens and base rules, and the shared surface classes. */
export function extractHouseKit(css: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  emit(parse(clean), false, out);
  // The app sets --font-inter from next/font; outside the app, fall back to the system font.
  return [':root { --font-inter: Inter, "Segoe UI", system-ui, sans-serif; }', ...out].join('\n');
}

/**
 * A reference screen in the house design, from the deal allocation board: a
 * ribbon of facts, tabs, a section with a grid and a side panel. The model
 * matches this structure and density.
 */
export const HOUSE_EXAMPLE = `<div class="da">
  <div class="crumbs"><a class="crumb-link" href="#">Deals</a><span class="sep">\u203a</span><span class="crumb-current">Acme Holdings TLB</span></div>
  <header class="da-ribbon">
    <div class="da-title">
      <span class="da-chip">Allocation</span>
      <h1>Acme Holdings TLB</h1>
      <p>Senior secured term loan refinancing</p>
      <span class="da-track"><i class="on"></i><i class="on"></i><i class="on"></i><i></i><i></i></span>
    </div>
    <div class="da-facts">
      <div class="da-fact big"><span>Total facility</span><strong data-attr="DEAL_FACILITY_SIZE">$750.0M</strong></div>
      <div class="da-fact"><span>Borrower</span><strong>Acme Holdings</strong></div>
      <div class="da-fact"><span>Pricing</span><strong data-attr="DEAL_PRICING_SUMMARY">S+475</strong></div>
      <div class="da-fact"><span>Close</span><strong data-attr="DEAL_TARGET_CLOSE_DATE">14 Dec 2026</strong></div>
    </div>
    <div class="da-holdbox">
      <div class="da-holdtop"><span>Our hold, blended across tranches</span><b>32%</b></div>
      <div class="da-bar"><i style="width:64%"></i></div>
      <p>Allocated $153.6M of $240.0M</p>
    </div>
  </header>
  <div class="da-tabs" role="tablist"><button class="on">Capital structure</button><button>Compliance</button><button>Syndicate</button><button>Funding</button></div>
  <section class="da-sec">
    <div class="da-sechead"><h2>Allocation by portfolio</h2></div>
    <div class="da-main">
      <div class="da-gridwrap">
        <table class="da-grid">
          <thead><tr><th>Portfolio</th><th class="num">Available capital</th><th class="num">Term loan B</th><th class="num">Total allocation</th></tr></thead>
          <tbody>
            <tr class="par sel"><td><div class="da-name"><button class="da-caret" aria-expanded="true">\u25be</button><span><b>Credit Opportunities II</b><small>3 sub-portfolios</small></span></div></td><td class="num"><b data-attr="FUND_AVAILABLE_CAPITAL">412.50</b></td><td class="num act">96.00<small>40.0% of hold</small></td><td class="num"><b>96.00</b><small>12.8% of facility</small></td></tr>
            <tr class="sub"><td><div class="da-name"><span><b>Sleeve A</b><small>NAV $210.0M</small></span></div></td><td class="num">180.00</td><td class="num act">48.00<small>20.0% of hold</small></td><td class="num">48.00</td></tr>
            <tr class="par"><td><div class="da-name"><span><b>Direct Lending III</b><small>NAV $1.1B</small></span></div></td><td class="num">88.00</td><td class="num na"><span class="da-natag">Not eligible</span></td><td class="num">0.00</td></tr>
          </tbody>
        </table>
      </div>
      <aside class="da-panel"><h3>Credit Opportunities II</h3><div class="da-big">$96.0M</div><p class="da-note">40.0% of the allocated hold, 12.8% of the facility.</p></aside>
    </div>
  </section>
</div>`;

/** A page that shows house-kit HTML the way the app would: the kit's stylesheet around the fragment. */
export function houseDocument(html: string, kit: string): string {
  const style = `<style>${kit}\nbody { display: block; min-height: 0; margin: 0; padding: 16px 20px; background: var(--bg, #f8fafc); color: var(--ink, #0f172a); font-family: var(--font-ibm-plex-sans, system-ui, sans-serif); font-size: 14px; }</style>`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (tag) => `${tag}${style}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${style}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${html}</body></html>`;
}
