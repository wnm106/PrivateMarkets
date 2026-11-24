/**
 * Checks a redesigned view before it is handed to a builder, and the set of
 * views against each other. Pure text work, so it runs in the browser, on the
 * server and in tests.
 *
 * It answers the questions a build has gone wrong on before:
 *  - which values are bound (data-attr), which are derived (data-derived), and
 *    which figures are neither, so right-click has nothing to open;
 *  - which controls the view has, so none is dropped without saying so;
 *  - which x- classes two views define differently, so nobody builds the
 *    surface's stylesheet by pasting the views' style blocks together;
 *  - where the view's own styles make text small or an input narrow.
 */

export interface CssRule {
  selector: string;
  /** Declarations, normalised: trimmed, lower-cased properties, sorted. */
  declarations: string;
  /** As written, for the merged stylesheet. */
  body: string;
}

export interface ViewAudit {
  label: string;
  /** Bound values by attribute code. */
  bound: Record<string, number>;
  boundTotal: number;
  /** Figures marked as worked out from other values. */
  derived: number;
  editable: number;
  /** Figures with neither data-attr nor data-derived on them or around them. */
  unboundTotal: number;
  unbound: string[];
  /** Buttons, selects, inputs and links a person can act on, by their label. */
  controls: string[];
  rules: CssRule[];
  media: string[];
  /** Selectors of the view's own styles that set text below 12px. */
  smallText: string[];
  /** Selectors that fix an input narrower than a money figure needs. */
  narrowInputs: string[];
}

export interface ClassConflict {
  selector: string;
  /** Each distinct definition and the views that carry it. */
  variants: Array<{ declarations: string; views: string[] }>;
}

export interface BundleAudit {
  views: ViewAudit[];
  conflicts: ClassConflict[];
  /** data-attr codes in the views that the blueprint does not name. */
  unknownCodes: string[];
  /** Every x- rule once, first definition kept, for the surface's one stylesheet. */
  sharedCss: string;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Text that is a figure and nothing else: $1.2B, 74%, 1.06x, 22, ≈$280M, (12.5). */
const FIGURE = /^[≈~<>≤≥]?\s*[-(]?[$€£]?\d[\d,.]*\s?(%|x|bps|[kmb]|bn|mm|#)?\)?$/i;
const MIN_TEXT_PX = 12;
const MIN_INPUT_PX = 56;

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

const hasAttr = (tag: string, name: string) => new RegExp(`\\s${name}(\\s|=|>|/)`, 'i').test(tag);

function decode(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse the rules of a style block. At-rule blocks are returned whole. */
export function parseCss(css: string): { rules: CssRule[]; media: string[] } {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const media: string[] = [];
  let index = 0;
  let prelude = '';
  while (index < clean.length) {
    const char = clean[index];
    if (char === '{') {
      let depth = 1;
      const start = index + 1;
      index += 1;
      while (index < clean.length && depth > 0) {
        if (clean[index] === '{') depth += 1;
        else if (clean[index] === '}') depth -= 1;
        index += 1;
      }
      const body = clean.slice(start, index - 1).trim();
      const head = prelude.trim();
      prelude = '';
      if (!head) continue;
      if (head.startsWith('@')) {
        media.push(`${head} { ${body.replace(/\s+/g, ' ')} }`);
        continue;
      }
      const declarations = body.split(';').map((part) => part.trim()).filter(Boolean)
        .map((part) => {
          const at = part.indexOf(':');
          return at < 0 ? part : `${part.slice(0, at).trim().toLowerCase()}:${part.slice(at + 1).trim().replace(/\s+/g, ' ')}`;
        })
        .sort()
        .join(';');
      for (const selector of head.split(',').map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean)) {
        rules.push({ selector, declarations, body: body.replace(/\s+/g, ' ') });
      }
      continue;
    }
    if (char === ';' || char === '}') prelude = '';
    else prelude += char;
    index += 1;
  }
  return { rules, media };
}

/** Read one redesigned view: its bindings, figures, controls and own styles. */
export function auditView(label: string, html: string): ViewAudit {
  const styles: string[] = [];
  const markup = html
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css: string) => { styles.push(css); return ''; })
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const { rules, media } = parseCss(styles.join('\n'));

  const bound: Record<string, number> = {};
  let boundTotal = 0;
  let derived = 0;
  let editable = 0;
  let unboundTotal = 0;
  const unbound: string[] = [];
  const controls: string[] = [];
  /** Open elements: whether a binding covers them, and whether their text is a label. */
  const stack: Array<{ name: string; covered: boolean; label: boolean; control: number }> = [];
  const pendingControl: Array<{ at: number; text: string }> = [];

  const noteFigure = (text: string) => {
    unboundTotal += 1;
    if (unbound.length < 12 && !unbound.includes(text)) unbound.push(text);
  };

  const tokens = markup.split(/(<[^>]+>)/);
  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith('<')) {
      if (token.startsWith('</')) {
        const name = token.slice(2, -1).trim().toLowerCase();
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i].name !== name) continue;
          const closed = stack.splice(i);
          const control = closed[0].control;
          if (control >= 0) {
            const text = pendingControl[control]?.text.trim();
            if (text && controls.length < 80 && !controls.includes(text)) controls.push(text);
          }
          break;
        }
        continue;
      }
      const name = (/^<\s*([a-zA-Z0-9-]+)/.exec(token)?.[1] || '').toLowerCase();
      if (!name) continue;
      const code = attr(token, 'data-attr');
      const isDerived = hasAttr(token, 'data-derived');
      if (code) {
        bound[code.toUpperCase()] = (bound[code.toUpperCase()] || 0) + 1;
        boundTotal += 1;
      }
      if (isDerived) derived += 1;
      if (attr(token, 'data-editable') === 'true') editable += 1;
      const parent = stack[stack.length - 1];
      const covered = Boolean(code) || isDerived || Boolean(parent?.covered);
      const isLabel = /^(th|label|option|h[1-6]|title|caption|legend|summary)$/.test(name) || Boolean(parent?.label);
      let control = parent ? parent.control : -1;
      if (name === 'button' || name === 'select' || (name === 'a' && hasAttr(token, 'href'))) {
        control = pendingControl.length;
        pendingControl.push({ at: control, text: attr(token, 'aria-label') || '' });
      }
      if (name === 'input' || name === 'textarea') {
        const inputLabel = attr(token, 'aria-label') || attr(token, 'placeholder') || attr(token, 'name');
        if (inputLabel && controls.length < 80 && !controls.includes(inputLabel)) controls.push(inputLabel);
        const value = decode(attr(token, 'value') || '');
        if (value && FIGURE.test(value) && !covered) noteFigure(value);
      }
      if (!VOID.has(name) && !token.endsWith('/>')) stack.push({ name, covered, label: isLabel, control });
      continue;
    }
    const text = decode(token);
    if (!text) continue;
    const top = stack[stack.length - 1];
    if (top && top.control >= 0 && !pendingControl[top.control].text) pendingControl[top.control].text = text.slice(0, 60);
    if (top?.covered || top?.label) continue;
    if (FIGURE.test(text)) noteFigure(text);
  }

  const px = (declarations: string, property: string): number | null => {
    const match = new RegExp(`(?:^|;)${property}:(\\d+(?:\\.\\d+)?)px`).exec(declarations);
    return match ? Number(match[1]) : null;
  };
  const smallText = [...new Set(rules.filter((rule) => { const size = px(rule.declarations, 'font-size'); return size != null && size < MIN_TEXT_PX; }).map((rule) => rule.selector))];
  const narrowInputs = [...new Set(rules.filter((rule) => /\binput\b/.test(rule.selector) && (() => { const width = px(rule.declarations, 'width'); return width != null && width < MIN_INPUT_PX; })()).map((rule) => rule.selector))];

  return { label, bound, boundTotal, derived, editable, unboundTotal, unbound, controls, rules, media, smallText, narrowInputs };
}

/** Read every view, then compare them: classes defined two ways, codes the blueprint does not know. */
export function auditViews(views: Array<{ label: string; html: string }>, knownCodes: Iterable<string> = []): BundleAudit {
  const audits = views.map((view) => auditView(view.label, view.html));
  const bySelector = new Map<string, Map<string, { body: string; views: string[] }>>();
  const order: string[] = [];
  for (const audit of audits) {
    for (const rule of audit.rules) {
      let variants = bySelector.get(rule.selector);
      if (!variants) {
        variants = new Map();
        bySelector.set(rule.selector, variants);
        order.push(rule.selector);
      }
      const variant = variants.get(rule.declarations);
      if (variant) { if (!variant.views.includes(audit.label)) variant.views.push(audit.label); }
      else variants.set(rule.declarations, { body: rule.body, views: [audit.label] });
    }
  }
  const conflicts: ClassConflict[] = [];
  const shared: string[] = [];
  for (const selector of order) {
    const variants = [...bySelector.get(selector)!.entries()];
    shared.push(`${selector} { ${variants[0][1].body} }`);
    if (variants.length > 1) conflicts.push({ selector, variants: variants.map(([declarations, value]) => ({ declarations, views: value.views })) });
  }
  const media = [...new Set(audits.flatMap((audit) => audit.media))];
  const known = new Set([...knownCodes].map((code) => code.toUpperCase()));
  const unknownCodes = known.size
    ? [...new Set(audits.flatMap((audit) => Object.keys(audit.bound)))].filter((code) => !known.has(code)).sort()
    : [];
  const header = conflicts.length
    ? `/* ${conflicts.length} class(es) are defined differently by different views. The first definition is kept here; see "Class conflicts" in README.md and settle each before you use it. */\n`
    : '/* Every class the views add to the house kit, each defined once. */\n';
  return { views: audits, conflicts, unknownCodes, sharedCss: `${header}${shared.join('\n')}${media.length ? `\n${media.join('\n')}` : ''}\n` };
}

/** What the designer must fix in its own redesign, as lines for the check round. Empty when nothing is wrong. */
export function auditFindings(audit: ViewAudit): string[] {
  const lines: string[] = [];
  if (audit.unboundTotal > 0) lines.push(`${audit.unboundTotal} figure(s) carry neither data-attr nor data-derived, for example: ${audit.unbound.slice(0, 8).join(', ')}. Bind each to its attribute, or mark it data-derived="how it is worked out".`);
  if (audit.smallText.length) lines.push(`Text below ${MIN_TEXT_PX}px in: ${audit.smallText.slice(0, 8).join(', ')}. Use ${MIN_TEXT_PX}px or more.`);
  if (audit.narrowInputs.length) lines.push(`Inputs narrower than ${MIN_INPUT_PX}px in: ${audit.narrowInputs.slice(0, 8).join(', ')}. An input must fit the longest value it can show, implied values included.`);
  return lines;
}
