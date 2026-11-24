/**
 * Reads a prototype HTML page into an outline the Surface Builder can reason
 * about: its tabs, figures, tables, charts, actions and inputs.
 *
 * It runs on the server and in the browser, so it does not use a DOM. It reads
 * the markup with patterns, which is enough for a prototype: the outline is a
 * starting point the model and the admin refine, not a parse of record.
 */

export type FieldKind = 'kpi' | 'field' | 'column' | 'input';

export interface PrototypeField {
  /** The label as the prototype shows it. */
  label: string;
  kind: FieldKind;
  /** A sample value shown next to the label, when there is one. */
  sample?: string;
  /** Where the field sits: a tab label, table caption or section heading. */
  where?: string;
}

export interface PrototypeTable {
  title?: string;
  columns: string[];
  rowCount: number;
  where?: string;
}

export interface PrototypeOutline {
  title: string;
  headings: string[];
  tabs: string[];
  fields: PrototypeField[];
  tables: PrototypeTable[];
  charts: Array<{ title?: string; kind: string }>;
  actions: string[];
  inputs: string[];
  /** Hints that the prototype already shows the house interactions. */
  signals: {
    contextMenu: boolean;
    inlineEdit: boolean;
    asOfDate: boolean;
    emptyState: boolean;
    loadingState: boolean;
    externalScripts: string[];
  };
  textLength: number;
  /** The rendered views the outline was read from, when the prototype was captured. */
  views?: string[];
}

const MAX_ITEMS = 120;

/** Text of a markup fragment, with tags removed and entities decoded. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&middot;/g, '\u00b7')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function uniq(values: string[], max = MAX_ITEMS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || value.length > 80) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function matchAll(html: string, pattern: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && out.length < 2000) out.push(match);
  return out;
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[2] ?? match[3]) : undefined;
}

function classOf(tag: string): string {
  return (attr(tag, 'class') || '').toLowerCase();
}

/** Whether a short string reads as a value (a figure, date or status) rather than a label. */
export function looksLikeValue(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/^[-+(]?[$\u20ac\u00a3]?\s?[\d.,]+\s?(%|x|bp|bps|[kmb]n?|mm)?\)?$/i.test(value)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value)) return true;
  if (/^(q[1-4]\s?\d{2,4}|fy\s?\d{2,4})$/i.test(value)) return true;
  return false;
}

function tabLabels(html: string): string[] {
  const labels: string[] = [];
  for (const match of matchAll(html, /<(button|a|li|div|span)\b([^>]*)>([\s\S]*?)<\/\1>/i)) {
    const tag = match[2];
    const cls = classOf(tag);
    const role = (attr(tag, 'role') || '').toLowerCase();
    if (role === 'tab' || /(^|\s|-)tab(\s|$|-btn|-button|-item|-link)/.test(cls) || attr(tag, 'data-tab') !== undefined) {
      const label = textOf(match[3]);
      if (label && label.length <= 40) labels.push(label);
    }
  }
  // Buttons and links inside a tablist or a nav whose class says tabs.
  for (const match of matchAll(html, /<(div|nav|ul)\b([^>]*(role\s*=\s*["']tablist["']|class\s*=\s*["'][^"']*tabs?\b[^"']*["'])[^>]*)>([\s\S]*?)<\/\1>/i)) {
    for (const child of matchAll(match[4], /<(button|a|li)\b[^>]*>([\s\S]*?)<\/\1>/i)) {
      const label = textOf(child[2]);
      if (label && label.length <= 40) labels.push(label);
    }
  }
  return uniq(labels, 24);
}

/** The tab or heading a position in the markup falls under. */
function sectionAt(html: string, index: number, tabs: string[]): string | undefined {
  const before = html.slice(0, index);
  const panels = matchAll(before, /<[^>]+(data-tab|id|aria-labelledby)\s*=\s*["']([^"']+)["'][^>]*>/i);
  for (let i = panels.length - 1; i >= 0; i -= 1) {
    const key = panels[i][2].toLowerCase().replace(/[-_]/g, ' ').replace(/\b(tab|panel|pane)\b/g, '').trim();
    const tab = tabs.find((label) => label.toLowerCase() === key || key.includes(label.toLowerCase()));
    if (tab) return tab;
  }
  const heads = matchAll(before, /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
  const last = heads[heads.length - 1];
  return last ? textOf(last[1]) || undefined : undefined;
}

function tables(html: string, tabs: string[]): PrototypeTable[] {
  const out: PrototypeTable[] = [];
  for (const match of matchAll(html, /<table\b[^>]*>([\s\S]*?)<\/table>/i)) {
    const body = match[1];
    const caption = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(body);
    let columns = matchAll(body, /<th\b[^>]*>([\s\S]*?)<\/th>/i).map((cell) => textOf(cell[1]));
    const rows = matchAll(body, /<tr\b[^>]*>/i).length;
    if (columns.length === 0) {
      const first = /<tr\b[^>]*>([\s\S]*?)<\/tr>/i.exec(body);
      columns = first ? matchAll(first[1], /<td\b[^>]*>([\s\S]*?)<\/td>/i).map((cell) => textOf(cell[1])) : [];
    }
    columns = uniq(columns.filter((column) => column && !looksLikeValue(column)), 40);
    if (columns.length === 0) continue;
    out.push({
      title: caption ? textOf(caption[1]) : sectionAt(html, match.index, tabs),
      columns,
      rowCount: Math.max(0, rows - 1),
      where: sectionAt(html, match.index, tabs),
    });
    if (out.length >= 30) break;
  }
  // Grids drawn with divs: a header row whose class names it.
  for (const match of matchAll(html, /<(div|tr)\b[^>]*class\s*=\s*["'][^"']*(grid-head|table-head|thead|col-head|header-row)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i)) {
    const columns = uniq(matchAll(match[3], /<(div|span|th)\b[^>]*>([^<]{1,60})<\/\1>/i).map((cell) => textOf(cell[2])), 40);
    if (columns.length >= 2) out.push({ columns, rowCount: 0, where: sectionAt(html, match.index, tabs) });
  }
  return out;
}

function fields(html: string, tabs: string[]): PrototypeField[] {
  const out: PrototypeField[] = [];
  const push = (label: string, kind: FieldKind, sample: string | undefined, index: number) => {
    const clean = label.replace(/[:\u2022]+$/, '').trim();
    if (!clean || clean.length > 60 || looksLikeValue(clean)) return;
    out.push({ label: clean, kind, sample: sample?.trim() || undefined, where: sectionAt(html, index, tabs) });
  };

  // KPI tiles: an element whose class names a label, followed by one that names a value.
  for (const match of matchAll(html, /<(\w+)\b[^>]*class\s*=\s*["'][^"']*(label|title|name|caption)[^"']*["'][^>]*>([\s\S]{1,200}?)<\/\1>\s*(?:<[^>]+>\s*)*?<(\w+)\b[^>]*class\s*=\s*["'][^"']*(value|figure|amount|number|metric|stat)[^"']*["'][^>]*>([\s\S]{1,120}?)<\/\4>/i)) {
    const cls = `${match[0].slice(0, 200)}`.toLowerCase();
    push(textOf(match[3]), /kpi|stat|metric|tile|card/.test(cls) ? 'kpi' : 'field', textOf(match[6]), match.index);
  }
  // Definition lists.
  for (const match of matchAll(html, /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/i)) {
    push(textOf(match[1]), 'field', textOf(match[2]), match.index);
  }
  // Label then value in a two-cell row.
  for (const match of matchAll(html, /<tr\b[^>]*>\s*<t[hd]\b[^>]*>([\s\S]{1,120}?)<\/t[hd]>\s*<td\b[^>]*>([\s\S]{1,120}?)<\/td>\s*<\/tr>/i)) {
    const label = textOf(match[1]);
    const value = textOf(match[2]);
    if (looksLikeValue(value) || value.length < 40) push(label, 'field', value, match.index);
  }
  // Form inputs with labels.
  for (const match of matchAll(html, /<label\b[^>]*>([\s\S]*?)<\/label>/i)) {
    push(textOf(match[1]), 'input', undefined, match.index);
  }
  for (const match of matchAll(html, /<(input|select|textarea)\b([^>]*)>/i)) {
    const label = attr(match[2], 'aria-label') || attr(match[2], 'placeholder') || attr(match[2], 'name');
    const type = (attr(match[2], 'type') || '').toLowerCase();
    if (label && !['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(type)) push(label, 'input', undefined, match.index);
  }

  const seen = new Set<string>();
  return out.filter((field) => {
    const key = `${field.kind}:${field.label.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_ITEMS);
}

function charts(html: string, source: string, tabs: string[]): PrototypeOutline['charts'] {
  const out: PrototypeOutline['charts'] = [];
  // Elements come from the markup without scripts: a template string inside a
  // script is code, not a chart on the page.
  for (const match of matchAll(html, /<(canvas|svg|div)\b([^>]*)>/i)) {
    const tag = match[2];
    const cls = `${classOf(tag)} ${(attr(tag, 'id') || '').toLowerCase()} ${(attr(tag, 'data-chart') || '').toLowerCase()}`;
    const isChart = match[1].toLowerCase() === 'canvas' || /chart|spark|graph|plot|waterfall|donut|heatmap/.test(cls);
    if (!isChart) continue;
    const kind = (/(bar|line|donut|pie|waterfall|heatmap|area|spark|scatter|stacked)/.exec(cls)?.[1]) || (match[1].toLowerCase() === 'canvas' ? 'canvas' : 'chart');
    out.push({ title: sectionAt(html, match.index, tabs), kind });
    if (out.length >= 30) break;
  }
  if (/new\s+Chart\(|echarts|d3\.|Plotly|ApexCharts|Highcharts/.test(source) && out.length === 0) out.push({ kind: 'script chart' });
  return out;
}

export function readPrototype(html: string): PrototypeOutline {
  const source = String(html || '').slice(0, 600_000);
  const withoutScripts = source.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  const headings = uniq(matchAll(withoutScripts, /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i).map((match) => textOf(match[1])), 60);
  const tabs = tabLabels(withoutScripts);
  const actions = uniq(matchAll(withoutScripts, /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/i)
    .filter((match) => {
      const tag = match[2];
      const role = (attr(tag, 'role') || '').toLowerCase();
      return role !== 'tab' && !/(^|\s)tab/.test(classOf(tag)) && (match[1].toLowerCase() === 'button' || /btn|button|action/.test(classOf(tag)));
    })
    .map((match) => textOf(match[3]))
    .filter((label) => label && !tabs.includes(label)), 60);
  const scripts = matchAll(source, /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i).map((match) => match[1]);
  const lower = source.toLowerCase();

  return {
    title: textOf(titleMatch?.[1] || '') || headings[0] || 'Untitled prototype',
    headings,
    tabs,
    fields: fields(withoutScripts, tabs),
    tables: tables(withoutScripts, tabs),
    charts: charts(withoutScripts, source, tabs),
    actions,
    inputs: uniq(fields(withoutScripts, tabs).filter((field) => field.kind === 'input').map((field) => field.label), 60),
    signals: {
      contextMenu: /contextmenu|oncontextmenu|right-click|right click/.test(lower),
      inlineEdit: /contenteditable|inline-edit|editable|dblclick/.test(lower),
      asOfDate: /as[\s-]?of|knowledge date|asofdate/.test(lower),
      emptyState: /empty|no (data|results|records)|nothing to show/.test(lower),
      loadingState: /loading|skeleton|spinner/.test(lower),
      externalScripts: uniq(scripts, 20),
    },
    textLength: textOf(withoutScripts).length,
  };
}

/** One rendered state of the prototype: the navigation that reached it and its markup. */
export interface RenderedView {
  label: string;
  html: string;
}

const VIEW_SEP = ' \u203a ';

/**
 * The outline of a prototype as it renders, not only as its source reads.
 * A prototype that draws its screens with scripts has little in its markup;
 * each captured view adds the tabs, tables, labels and actions it drew, placed
 * under the view that showed them. Signals still come from the source, which
 * holds every script and style.
 */
export function readPrototypeWithViews(html: string, views: RenderedView[]): PrototypeOutline {
  const base = readPrototype(html);
  if (views.length === 0) return base;
  const read = views.map((view) => ({
    view: view.label,
    outline: readPrototype(`<html><head><title>${base.title}</title></head><body>${view.html}</body></html>`),
  }));
  const topViews = views.map((view) => view.label.split(VIEW_SEP)[0]).filter((label) => label && label !== 'Initial view');
  const fieldKey = (field: PrototypeField) => `${field.kind}:${field.label.toLowerCase()}`;
  const fieldsSeen = new Set(base.fields.map(fieldKey));
  const mergedFields = [...base.fields];
  const tablesSeen = new Set(base.tables.map((table) => table.columns.join('|').toLowerCase()));
  const mergedTables = [...base.tables];
  const mergedCharts = [...base.charts];
  for (const { view, outline } of read) {
    for (const field of outline.fields) {
      const key = fieldKey(field);
      if (fieldsSeen.has(key)) continue;
      fieldsSeen.add(key);
      mergedFields.push({ ...field, where: field.where || view });
    }
    for (const table of outline.tables) {
      const key = table.columns.join('|').toLowerCase();
      if (tablesSeen.has(key)) continue;
      tablesSeen.add(key);
      mergedTables.push({ ...table, title: table.title || view, where: view });
    }
    for (const chart of outline.charts) {
      if (mergedCharts.length >= 40) break;
      mergedCharts.push({ ...chart, title: chart.title ? `${view}: ${chart.title}` : view });
    }
  }
  return {
    ...base,
    headings: uniq([...base.headings, ...read.flatMap((item) => item.outline.headings)], 80),
    tabs: uniq([...topViews, ...base.tabs, ...read.flatMap((item) => item.outline.tabs)], 40),
    fields: mergedFields.slice(0, MAX_ITEMS * 2),
    tables: mergedTables.slice(0, 40),
    charts: mergedCharts,
    actions: uniq([...base.actions, ...read.flatMap((item) => item.outline.actions)], 80),
    inputs: uniq([...base.inputs, ...read.flatMap((item) => item.outline.inputs)], 80),
    views: views.map((view) => view.label),
    textLength: Math.max(base.textLength, ...read.map((item) => item.outline.textLength)),
  };
}

/** Every label the prototype shows that could be a stored or derived value. */
export function prototypeLabels(outline: PrototypeOutline): Array<{ label: string; kind: FieldKind; sample?: string; where?: string }> {
  const out: Array<{ label: string; kind: FieldKind; sample?: string; where?: string }> = outline.fields.filter((field) => field.kind !== 'input');
  for (const table of outline.tables) {
    for (const column of table.columns) out.push({ label: column, kind: 'column', where: table.title || table.where });
  }
  const seen = new Set<string>();
  return out.filter((item) => {
    const key = item.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
