/**
 * Redesigning one prototype view in the house design: the prompt, and reading
 * the reply. The model starts from the view's rendered markup and screenshot,
 * keeps everything the view shows, and restyles it with the house kit only.
 * A second round shows it its own version rendered next to the original so it
 * can correct what differs.
 */
import { HOUSE_EXAMPLE } from './house-kit';

export interface RedesignBinding {
  label: string;
  attributeCode?: string;
  decision: string;
  editable?: boolean;
}

export interface RedesignReply {
  html: string;
  notes: string[];
}

const MAX_HTML = 200_000;

export function designerSystem(kit: string): string {
  return `You are a senior product designer at tapestr.ai. You redesign one screen of a prototype in the house design system, so it can be built as a surface in the app.

THE HOUSE KIT is the app's own stylesheet for surfaces. It is the only styling you may use:
- Classes from the kit: the da- family (ribbon, facts, tabs, sections, grids, panels, chips, bars, notes), fs-, cr-, pipe- and rb- panels, crumbs, page-header, btn, data-table, status-pill. Read the kit to see what each class does before you use it.
- Tokens from the kit (var(--ink), var(--ink-3), var(--line), var(--surface), var(--bg-alt), var(--accent), var(--accent-2), status colors) for anything you style yourself.
- Wrap the screen in <div class="da">, which sets the surface's scoped tokens.
- When the kit has no component for something the view needs (a min/target/max band bar, a tree-grid indent, a pacing chart), add one small <style> block at the top with classes prefixed x-, built only from kit tokens, 1px borders, 8px radius, no shadows or gradients. Keep it short.
- The views of one surface share one stylesheet in the build. When SHARED CLASSES are given, they are the x- classes earlier views of this surface already defined: reuse them exactly as written for the same thing (the shell, rail, ribbon, tabs, grids), do not redefine or restyle them, and repeat their rules unchanged in your <style> block so the page renders on its own. Give a class that only this view needs a name no shared class uses. One class name never means two things.

THE HOUSE DESIGN: dense and editorial. Light background, one accent, tabular numerals, right-aligned figures, 1px low-contrast borders, 8px radius, no shadows, no gradients, direct labels on charts, system font. The prototype's own palette, fonts and dark theme are not the house design: drop them.

REFERENCE SCREEN in the house design (structure and density to match):
${HOUSE_EXAMPLE}

THE HOUSE KIT CSS:
${kit}

LEGIBILITY. Dense is not cramped. The redesign is read by a person and then built literally, so anything too tight here ships:
- Design the main column for about 1100px. The app's own sidebar, the surface's rail and the assistant panel take the rest of a 1920px screen; at 1440px there is less.
- No text below 12px, except the kit's own uppercase tags.
- An input is as wide as the longest value it can show at its font size, placeholders and implied values (such as \u2248$280M) included: about 64px for money, 58px for a percent, 40px for a count. Never a fixed width that clips its own sample value.
- A row with no value in it is one quiet line with a control to add to it. Do not draw a row of empty boxes for every level of a tree.
- Names wrap; they are not cut off with an ellipsis. Tab labels are short; put a tab's description in its title, not in a second line that gets truncated.
- A table that can grow taller than the window sits in a frame with a sticky header.
- A side panel that repeats what the main area shows is marked as hideable.

Rules for the redesign:
- Keep the view's information architecture: every region, heading, figure, row, column, control, status and label it shows, in the same order. Do not drop rows or columns, do not summarise, do not invent data. Use the figures as they appear.
- Map each region to the closest house pattern: a header strip of figures is a da-ribbon with da-facts; a tab strip is da-tabs; a panel is a da-sec with da-sechead; a table is a da-grid inside da-gridwrap; a side detail is da-panel; a status is a da-chip or status-pill.
- Every figure, date and status value carries a binding, with no exceptions:
  - data-attr="<ATTRIBUTE_CODE>" on each value that comes from an attribute, using the bindings given. Put it on the value itself: each cell of a grid, each figure in a rail, side list, card, ribbon or footer. Never on a table, a row or a wrapper around many values, and never once under a grid in place of its cells.
  - data-derived="<one sentence: what is added up or divided>" on each figure worked out from other values (a total, a share, a count, a ratio, a status). The build turns this into a right-click panel.
  - A value you cannot place gets data-derived="unknown: <why>" so it is asked about, not dropped.
- Mark each value a person edits on this view with data-editable="true", on the same element as its data-attr.
- Static HTML only: no scripts, no external stylesheets, fonts or images.
Reply with the full HTML in one \`\`\`html block, then a line NOTES: followed by short bullet lines on what you mapped to which house pattern and anything the kit could not express.`;
}

export function redesignAsk(view: string, purpose: string | undefined, bindings: RedesignBinding[], sharedCss?: string): string {
  return `Redesign the view "${view}" shown above in the house design.${purpose ? `\nWhat this view is for: ${purpose}` : ''}
Bindings for values on this view (label, attribute code, whether a person edits it):
${JSON.stringify(bindings.slice(0, 150))}${sharedCss?.trim() ? `\nSHARED CLASSES already defined by earlier views of this surface. Reuse them as written; do not redefine them:\n${sharedCss.trim().slice(0, 30_000)}` : ''}`;
}

export function checkAsk(view: string, findings: string[] = []): string {
  return `CHECK ROUND for "${view}". Above are, in order: the original view (markup and screenshot), your redesign (HTML), and a screenshot of your redesign rendered with the house kit.
Compare the two screenshots region by region. List what is missing or different in content (regions, rows, columns, figures, controls, labels) and what does not follow the house design (palette, fonts, spacing, borders, alignment, density). In the screenshot of your redesign, look for anything clipped inside an input, cut off with an ellipsis, or too small to read, and fix it. Then return the corrected full HTML, keeping what was already right.${findings.length ? `\nA check of your HTML found these. Fix every one:\n${findings.map((line) => `- ${line}`).join('\n')}` : ''}
Reply with the corrected HTML in one \`\`\`html block, then NOTES: with the differences you fixed, one per line.`;
}

/** The x- rules a redesign defines, for the views that come after it. */
export function styleBlocks(html: string): string {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1].trim()).filter(Boolean).join('\n');
}

/** The HTML and notes out of a redesign reply. */
export function readRedesignReply(text: string): RedesignReply | null {
  const fenced = /```html\s*([\s\S]*?)```/i.exec(text) || /```\s*(<[\s\S]*?)```/.exec(text);
  const html = (fenced ? fenced[1] : /^\s*</.test(text) ? text : '').trim();
  if (!html || !/<[a-z]/i.test(html)) return null;
  const notesAt = text.search(/NOTES:/i);
  const notes = notesAt >= 0
    ? text.slice(notesAt + 6).split('\n').map((line) => line.replace(/^\s*[-*\u2022]\s*/, '').trim()).filter(Boolean).slice(0, 30)
    : [];
  return { html: html.slice(0, MAX_HTML), notes };
}
