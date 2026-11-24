/**
 * The handoff bundle: everything Claude Code needs to build a surface from a
 * blueprint, laid out as a folder to unzip at the repo root. The README is the
 * brief; the rest is the evidence it points to.
 *
 * The brief is written to be followed literally. It says what to ask before
 * building, counts what each view binds so a build can be checked against it,
 * ships the views' styles merged into one file, and ends with an acceptance
 * script whose output the builder hands back. Each of those is there because a
 * build once went wrong without it.
 */
import { acceptanceScript } from './acceptance';
import { blueprintMarkdown, exportBlockers, surfaceCode, type SurfaceBlueprint } from './blueprint';
import { houseDocument } from './house-kit';
import { auditViews, type BundleAudit, type ViewAudit } from './view-audit';
import type { ZipEntry } from '../zip';

export interface HandoffInput {
  blueprint: SurfaceBlueprint;
  /** The house kit CSS, so each view also ships as a page that opens styled. */
  kit: string;
  /** The original prototype, which the blueprint itself does not keep. */
  prototypeHtml?: string;
  /** Screenshots of the original views, base64 JPEG, by view label. */
  originals?: Record<string, string>;
}

export function handoffSlug(text: string): string {
  return surfaceCode(text);
}

export function handoffFolder(blueprint: SurfaceBlueprint): string {
  return `docs/surfaces/${handoffSlug(blueprint.request.name)}`;
}

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface ViewFile {
  /** File name in views/, without the extension. */
  file: string;
  title: string;
  view?: string;
  fragment: string;
  page: string;
  original?: string;
  checked?: boolean;
  audit?: ViewAudit;
}

const PLACEMENT: Record<string, string> = {
  'record-tab': 'a tab on a record page in the app',
  'sdk-surface': 'a client surface in `surfaces/<code>/`, built on `@tapestrai/surface-sdk`',
  'app-page': 'a page in the app',
};

/** What the builder must ask a person before building, from the blueprint and the views. */
export function stopAndAsk(blueprint: SurfaceBlueprint, audit: BundleAudit | null): string[] {
  const asks: string[] = [];
  for (const question of blueprint.openQuestions) asks.push(question);
  for (const decision of blueprint.decisions.filter((item) => item.source === 'assumed')) {
    asks.push(`Assumed, not confirmed: ${decision.question} The blueprint follows "${decision.answer}".`);
  }
  const derived = blueprint.fields.filter((field) => field.decision === 'derived');
  if (derived.length > 0 && blueprint.computations.length === 0) {
    asks.push(`${derived.length} figure(s) are worked out from other values (${derived.slice(0, 4).map((field) => field.label).join(', ')}${derived.length > 4 ? ', ...' : ''}) and \`build.md\` names no home for them. Where does each calculation run: a database function, a calculated attribute, or one shared module the assistant can also call?`);
  }
  for (const computation of blueprint.computations.filter((item) => !item.runsIn)) {
    asks.push(`Where does "${computation.name}" run? \`build.md\` does not say.`);
  }
  if (audit?.unknownCodes.length) {
    asks.push(`The views bind ${audit.unknownCodes.map((code) => `\`${code}\``).join(', ')}, which \`build.md\` does not list as an existing or new attribute. Which attribute is meant?`);
  }
  return asks;
}

function readme(blueprint: SurfaceBlueprint, folder: string, views: ViewFile[], hasPrototype: boolean, audit: BundleAudit | null): string {
  const { request } = blueprint;
  const code = handoffSlug(request.name);
  const sdk = request.placement === 'sdk-surface';
  const lines: string[] = [];
  lines.push(`# Build brief: ${request.name}`, '');
  lines.push(`Written by the Surface Builder on ${blueprint.generatedAt}${blueprint.model ? ` (reviewed by ${blueprint.model})` : ''}. Give this file to Claude Code with: _"Build the surface in \`${folder}/README.md\`."_`, '');
  lines.push('Follow this brief literally. Where it gives a number, the build is checked against that number.', '');

  lines.push('## What to build', '');
  lines.push(`${blueprint.summary}`, '');
  lines.push(`- **Purpose:** ${request.description}`);
  if (request.audience) lines.push(`- **Audience:** ${request.audience}`);
  if (request.placement) lines.push(`- **Placement:** ${PLACEMENT[request.placement] || request.placement}`);
  if (request.domainCode) lines.push(`- **Anchored on entity type:** \`${request.domainCode}\``);
  if (sdk) lines.push(`- **Surface code:** \`${code}\`. The folder is \`surfaces/${code}/\`, the route is \`/s/${code}\`, the manifest code is \`${code}\`. Use this code everywhere; ignore any other folder name.`);
  lines.push('');

  const asks = stopAndAsk(blueprint, audit);
  lines.push('## 1. Before you write code: ask', '');
  if (asks.length) {
    lines.push('Put these to the person in one message and wait for the answers. Do not choose for them, and do not build the part a question affects until it is answered.', '');
    asks.forEach((ask, index) => lines.push(`${index + 1}. ${ask}`));
  } else {
    lines.push('Nothing is open. If you find the views and `build.md` disagreeing as you build, stop and ask; do not pick one.');
  }
  lines.push('');

  lines.push('## 2. Files in this folder', '');
  lines.push('- `build.md`: the blueprint. Tabs, field bindings, entity model, relationship types, taxonomies, compliance mapping, calculations, design decisions, standards (each with its rule, how to meet it here, and what to measure) and build steps.');
  lines.push('- `blueprint.json`: the same blueprint as data.');
  if (hasPrototype) lines.push('- `prototype.html`: the original prototype. Behaviour reference only; do not copy its code or styling.');
  if (views.length) {
    lines.push('- `views/`: each view redesigned in the house design.');
    lines.push('  - `<view>.html` is the markup to build from. `data-attr` marks a value bound to an attribute, `data-derived` a figure worked out from others, `data-editable` a value edited in place.');
    lines.push('  - `<view>.preview.html` opens in a browser styled with the house kit.');
    lines.push('  - `<view>.original.jpg` is the prototype view it came from.');
    lines.push('  - `shared.css` holds every class the views add to the house kit, each once. Build the surface\'s stylesheet from this file. **Do not paste the views\' `<style>` blocks together**: each view was designed on its own and several reuse a class name with different rules.');
  }
  lines.push('- `acceptance.js`: the check to run in the browser before you call the surface done (section 6).');
  lines.push('');

  if (views.length) {
    lines.push('## 3. What each view holds', '');
    lines.push('The build is checked against these counts. A tab with fewer bound values than its view has dropped bindings.', '');
    lines.push('| View | File | Bound values | Derived figures | Editable | Figures with no binding | Controls | Checked against the original |', '|---|---|---|---|---|---|---|---|');
    for (const view of views) {
      const a = view.audit;
      lines.push(`| ${view.view || view.title} | \`views/${view.file}.html\` | ${a ? a.boundTotal : ''} | ${a ? a.derived : ''} | ${a ? a.editable : ''} | ${a ? a.unboundTotal : ''} | ${a ? a.controls.length : ''} | ${view.checked ? 'yes' : 'no'} |`);
    }
    lines.push('');
    const loose = views.filter((view) => (view.audit?.unboundTotal ?? 0) > 0);
    if (loose.length) {
      lines.push('**Figures with no binding.** The redesign left these figures with neither `data-attr` nor `data-derived`. The build does not get to leave them out: bind each to its attribute, or give it a "how it is worked out" panel.', '');
      for (const view of loose) lines.push(`- ${view.view || view.title}: ${view.audit!.unboundTotal}, for example ${view.audit!.unbound.slice(0, 8).map((text) => `\`${text}\``).join(', ')}`);
      lines.push('');
    }
    lines.push('**Controls.** Each control below is in the build, or in your "Left out or changed" list with the reason.', '');
    for (const view of views) {
      if (!view.audit?.controls.length) continue;
      lines.push(`- ${view.view || view.title}: ${view.audit.controls.slice(0, 40).join('; ')}${view.audit.controls.length > 40 ? '; ...' : ''}`);
    }
    lines.push('');
    if (audit?.conflicts.length) {
      lines.push('**Class conflicts.** These classes are defined differently by different views. `shared.css` keeps the first definition. Settle each one (rename, or pick one meaning) before you use it; the surface defines each class once.', '');
      for (const conflict of audit.conflicts.slice(0, 60)) {
        lines.push(`- \`${conflict.selector}\`: ${conflict.variants.map((variant) => variant.views.join(', ')).join(' / ')}`);
      }
      if (audit.conflicts.length > 60) lines.push(`- and ${audit.conflicts.length - 60} more; compare the views' style blocks.`);
      lines.push('');
    }
    const cramped = views.filter((view) => view.audit && (view.audit.smallText.length || view.audit.narrowInputs.length));
    if (cramped.length) {
      lines.push('**Where the views are too tight.** The legibility standard wins over the view here: fix these as you build, and say that you did.', '');
      for (const view of cramped) {
        const a = view.audit!;
        const parts = [
          a.smallText.length ? `text below 12px in ${a.smallText.slice(0, 6).map((selector) => `\`${selector}\``).join(', ')}` : '',
          a.narrowInputs.length ? `inputs under 56px in ${a.narrowInputs.slice(0, 6).map((selector) => `\`${selector}\``).join(', ')}` : '',
        ].filter(Boolean);
        lines.push(`- ${view.view || view.title}: ${parts.join('; ')}`);
      }
      lines.push('');
    }
  }

  lines.push('## 4. How to build it', '');
  lines.push('Read `AGENTS.md`, `docs/GUARDRAILS.md`, `docs/SURFACE_TABS.md` and `surfaces/README.md` first. Work in two pull requests, platform first.', '');
  lines.push('### Platform pull request', '');
  lines.push('- Entity types, relationship types and new attributes from `build.md`: schema and functions go in a new migration; records go in `supabase/seed`. Never edit an applied migration.');
  lines.push('- Use the attribute codes `build.md` names, exactly as written. If a code has to differ (it exists under another name, or a naming rule applies), do not rename quietly: list old code and new code in your hand-back.');
  lines.push('- Taxonomies become reference lists in seed.');
  lines.push('- Compliance: express each prototype rule through `compliance.rules`, `rule_thresholds` and `rule_scope_assignments` as the mapping says. Rules are interpreted only by `compliance.evaluate_rule`; capacity only by `compliance-capacity.ts`. Do not write a second evaluator.');
  lines.push(blueprint.computations.length
    ? '- Calculations live in one home each, as named under "Calculations and where each runs" in `build.md`, never inside the surface.'
    : '- `build.md` names no calculations. If the surface must work a figure out, that is a question for section 1: ask where it runs before you write it inside the surface.');
  lines.push('- No code names a client, rule or entity by its code: put the difference in data.');
  lines.push('- Run `npm run guard`, `npm run guard:db` and `npm run test:db`.', '');
  lines.push('### Surface pull request', '');
  if (sdk) {
    lines.push(`- Copy \`surfaces/fund-index\` to \`surfaces/${code}/\`, set the manifest code to \`${code}\`, and register it in \`apps/web/lib/surface-registry.ts\`.`);
    lines.push('- Import only React, `@tapestrai/surface-sdk`, `@tapestrai/ui` and the surface\'s own files. Read and write through `useSurfaceHost()`. Nothing in `build.md` licenses an import from `apps/web`; where a standard names an app component, use the host method it gives instead.');
  } else {
    lines.push('- Build it where the placement says, following the nearest existing screen of that kind (the deal allocation board is the house reference).');
  }
  lines.push('- Build each tab from its file in `views/`: same regions, columns and controls, in the same order, with the sample figures replaced by data.');
  lines.push('- **Right-click, value by value.** Every element with `data-attr` in a view is a bound value in the build, and right-click on it opens its sources. That means each cell of a grid, each figure in a rail or side list, and each editable input, not one link under the table. Every figure with `data-derived`, and every figure the view left unmarked, opens how it is worked out and the records behind it. Keep `data-attr` and `data-derived` on the built elements: the acceptance script counts them.');
  lines.push('- **Edit in place.** Every element with `data-editable` is edited where it stands and saved through the golden write path, with the old value put back if the save is refused.');
  lines.push('- **One stylesheet.** Start from `views/shared.css`, settle the conflicts listed above, drop what the build does not use, and scope every selector to the surface root. Each class is defined once.');
  lines.push('- **Legible before faithful.** The views set the layout. They do not license clipped values, cut-off names, text below 12px or rows of empty boxes: the legibility standard in `build.md` wins, and you say where you departed from a view.');
  lines.push('- Publish every tab to the assistant (`label`, `purpose`, `data`, and `howToRead` where needed), with the user\'s As Of and Knowledge dates applied, and publish the open record as the view focus.');
  lines.push('- Link the open record\'s name, and each record named in a list, to its golden record.', '');

  lines.push('## 5. Keep a "Left out or changed" list', '');
  lines.push('As you build, write down every control, column, value or behaviour in the views or `build.md` that you did not build, moved or changed, with one line on why. Hand the list back with the work. An empty list is a claim that nothing was dropped; make it only if it is true.', '');

  lines.push('## 6. Done is measured', '');
  lines.push('Do not report the surface as done from reading your own code. Open it in the browser with real records and measure it:', '');
  lines.push('1. Run `npm run guard`' + (sdk ? ', `npm run lint:surfaces`' : '') + ' and the web tests.');
  lines.push('2. On every tab and top-level view, at 1440x900 and again at 1920x1080, run `acceptance.js` in the browser console (or the browser tool\'s script runner). It returns a table: figures that do not answer right-click, bound values against the view\'s count, clipped inputs, cut-off text, text below 12px, rows of empty boxes, tables that lose their header, classes defined twice, and sideways page scroll.');
  lines.push('3. By hand: right-click one grid cell, one ribbon figure, one rail or side-list figure and one derived figure, and confirm each opens a panel. Type a value into one editable cell, see it saved, and undo it.');
  lines.push('4. Hand back: the acceptance tables for every tab at both widths, the "Left out or changed" list, any attribute code you changed, and the answers you were given in section 1.', '');
  lines.push('A failing line means the surface is not done. Say which line fails and why; do not leave it out of the report.');
  return lines.join('\n') + '\n';
}

/** Raised when a blueprint may not be handed to a builder. The message says why, one reason per line. */
export class HandoffBlocked extends Error {
  constructor(public readonly reasons: string[]) {
    super(`This blueprint cannot be handed to a builder yet.\n${reasons.join('\n')}`);
    this.name = 'HandoffBlocked';
  }
}

/**
 * The files of the handoff bundle, with paths from the repo root. Refuses a blueprint whose
 * data model is not fit to build (exportBlockers): a bundle is followed literally.
 */
export function handoffFiles({ blueprint, kit, prototypeHtml, originals = {} }: HandoffInput): ZipEntry[] {
  const blockers = exportBlockers(blueprint);
  if (blockers.length) throw new HandoffBlocked(blockers);
  const folder = handoffFolder(blueprint);
  const used = new Set<string>();
  const views: ViewFile[] = [];
  for (const artifact of blueprint.artifacts) {
    if (!artifact.html) continue;
    const base = handoffSlug(artifact.view || artifact.title);
    let file = base;
    for (let n = 2; used.has(file); n += 1) file = `${base}-${n}`;
    used.add(file);
    views.push({
      file,
      title: artifact.title,
      view: artifact.view,
      fragment: artifact.html,
      page: houseDocument(artifact.html, kit),
      original: artifact.view ? originals[artifact.view] : undefined,
      checked: artifact.checked,
    });
  }

  const knownCodes = [...blueprint.fields.map((field) => field.attributeCode), ...blueprint.newAttributes.map((attribute) => attribute.code)].filter((value): value is string => Boolean(value));
  const audit = views.length ? auditViews(views.map((view) => ({ label: view.view || view.title, html: view.fragment })), knownCodes) : null;
  if (audit) views.forEach((view, index) => { view.audit = audit.views[index]; });

  const files: ZipEntry[] = [];
  const hasPrototype = Boolean(prototypeHtml?.trim());
  files.push({ path: `${folder}/README.md`, data: readme(blueprint, folder, views, hasPrototype, audit) });
  files.push({ path: `${folder}/build.md`, data: blueprintMarkdown(blueprint) });
  files.push({ path: `${folder}/blueprint.json`, data: JSON.stringify(blueprint, null, 2) });
  files.push({
    path: `${folder}/acceptance.js`,
    data: acceptanceScript({
      root: blueprint.request.placement === 'sdk-surface' ? `.${handoffSlug(blueprint.request.name)}, main` : 'main',
      minBound: Object.fromEntries(views.filter((view) => view.audit).map((view) => [(view.view || view.title).split(' › ').pop() || view.title, view.audit!.boundTotal])),
    }),
  });
  if (hasPrototype) files.push({ path: `${folder}/prototype.html`, data: prototypeHtml! });
  if (audit) files.push({ path: `${folder}/views/shared.css`, data: audit.sharedCss });
  for (const view of views) {
    const name = view.file;
    files.push({ path: `${folder}/views/${name}.html`, data: view.fragment });
    files.push({ path: `${folder}/views/${name}.preview.html`, data: view.page });
    if (view.original) files.push({ path: `${folder}/views/${name}.original.jpg`, data: bytesOf(view.original) });
  }
  return files;
}
