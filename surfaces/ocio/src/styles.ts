/**
 * What the OCIO views add to the house kit, scoped to the surface root (.ocio).
 *
 * One stylesheet for the whole surface: every class is defined once and means the same thing
 * on every tab. It is written by hand from the views in surfaces/ocio/views, not put together
 * from their style blocks, which reuse class names with different rules. The house classes
 * (da-*, pipe-*, cr-*, fs-*) come from the host.
 *
 * Sizing rules this file holds to:
 *  - no text below 12px, except the host's uppercase level tags;
 *  - an input is as wide as the longest value it can show, implied values (≈$280M) included;
 *  - a level with no target and no commitments is one quiet line, not nine empty boxes;
 *  - names wrap, they are not cut off;
 *  - a tall grid scrolls inside its frame, so its header stays in view.
 */
export const OCIO_CSS = `
.ocio .da-st, .ocio .cr-n, .ocio .da-grid small, .ocio .da-fact span, .ocio .da-fact small, .ocio .fs-tile span { font-size: 12px; }

/* ---- values: right-click for sources, or for how a figure is worked out ---- */
.ocio .x-bound, .ocio .x-derived { cursor: context-menu; border-bottom: 1px dotted transparent; }
.ocio .x-bound:hover, .ocio .x-derived:hover { border-bottom-color: var(--ink-3); }
.ocio .x-editable { padding: 0; border: 0; border-bottom: 1px dashed var(--ink-4); background: none; font: inherit; color: inherit; cursor: text; }
.ocio .x-editable:hover { border-bottom-color: var(--accent-2); color: var(--accent-2); }
.ocio .x-inedit { font: inherit; width: 7em; padding: 0 4px; border: 1px solid var(--accent-2); border-radius: 4px; background: var(--surface); color: inherit; }
.ocio [aria-invalid="true"] { border-color: var(--red); }
.ocio .x-pop { position: fixed; z-index: 60; width: 360px; overflow: auto; padding: 12px 14px; background: var(--surface); border: 1px solid var(--ink-3); border-radius: 8px; font-size: 13px; color: var(--ink); text-align: left; }
.ocio .x-pop p { margin: 8px 0; color: var(--ink-2); line-height: 1.4; }
.ocio .x-pophead { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.ocio .x-pophead small { display: block; font-size: 12px; color: var(--ink-3); }
.ocio .x-pophead b { font-weight: 600; }
.ocio .x-pophead b span { font-weight: 400; color: var(--ink-2); }
.ocio .x-poprows { width: 100%; border-collapse: collapse; }
.ocio .x-poprows td { padding: 5px 0; border-top: 1px solid var(--line); vertical-align: top; }
.ocio .x-poprows td:last-child { text-align: right; white-space: nowrap; padding-left: 12px; font-variant-numeric: tabular-nums; }
.ocio .x-poprows small { display: block; font-size: 12px; color: var(--ink-3); }
.ocio .x-pop .x-popmore { margin: 6px 0 0; font-size: 12px; color: var(--ink-3); }

/* ---- shell: rail, main, assigned targets ---- */
.ocio .x-shell { display: grid; grid-template-columns: 232px minmax(0, 1fr) 272px; gap: 14px; align-items: start; margin-top: 10px; }
.ocio .x-shell.x-noside { grid-template-columns: 232px minmax(0, 1fr); }
.ocio .x-mainc { min-width: 0; }
.ocio .x-rail { position: sticky; top: 8px; display: flex; flex-direction: column; gap: 2px; max-height: calc(100vh - 16px); overflow: auto; padding: 8px 6px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
.ocio .x-rail h2 { margin: 2px 8px 6px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3); }
.ocio .x-ent { display: flex; flex-direction: column; align-items: stretch; gap: 4px; width: 100%; padding: 7px 8px; border: 1px solid transparent; border-radius: 8px; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.ocio .x-ent.mandate { padding-left: 18px; }
.ocio .x-ent:hover { background: var(--bg-alt); }
.ocio .x-ent[aria-current="true"] { background: var(--bg-alt); border-color: var(--accent-2); }
.ocio .x-entline { display: flex; align-items: flex-start; gap: 6px; }
.ocio .x-entline b { flex: 1; min-width: 0; font-weight: 600; line-height: 1.25; overflow-wrap: anywhere; }
.ocio .x-ent.mandate .x-entline b { font-weight: 500; }
.ocio .x-entsub { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; font-size: 12px; color: var(--ink-3); }
.ocio .x-lens { display: inline-flex; gap: 2px; margin-left: auto; }
.ocio .x-lens i { width: 12px; height: 4px; border-radius: 2px; background: var(--line); }
.ocio .x-lens i.on { background: var(--accent-2); }
.ocio .x-add { justify-content: center; margin-top: 8px; }
.ocio .x-side { position: sticky; top: 8px; max-height: calc(100vh - 16px); overflow: auto; padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
.ocio .x-side section { padding: 10px 0; border-top: 1px solid var(--line); }
.ocio .x-side .da-note { margin: 2px 0 4px; }
.ocio .x-sidehead { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
.ocio .x-sidehead h2 { margin: 0; font-size: 13px; font-weight: 600; color: var(--ink-2); }
.ocio .x-gh { display: flex; justify-content: space-between; align-items: baseline; width: 100%; padding: 0; border: 0; background: none; font: inherit; color: var(--ink); cursor: pointer; }
.ocio .x-gh span { font-size: 14px; font-weight: 600; }
.ocio .x-gh small { font-size: 12px; color: var(--ink-3); }
.ocio .x-srow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; align-items: baseline; padding: 5px 0; border-bottom: 1px solid var(--line); font-size: 12.5px; }
.ocio .x-sname { padding: 0; border: 0; background: none; font: inherit; font-weight: 500; color: inherit; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.ocio .x-vals { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px 7px; font-size: 12px; font-variant-numeric: tabular-nums; }
.ocio .x-typed { font-weight: 600; color: var(--ink); }
.ocio .x-imp { color: var(--ink-3); }
.ocio .x-rgl { grid-column: 1 / -1; padding-left: 14px; font-size: 12px; color: var(--ink-3); }
.ocio .x-legend { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-3); }

/* ---- status: green in range or at target, blue building toward a target, amber below a minimum, red above a maximum or over target ---- */
.ocio .x-dot { display: inline-block; flex: none; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: var(--ink-4); }
.ocio .x-dot.in, .ocio .x-dot.at { background: var(--green); }
.ocio .x-dot.under { background: var(--accent-2); }
.ocio .x-dot.below { background: var(--gold); }
.ocio .x-dot.above, .ocio .x-dot.over { background: var(--red); }

/* ---- ribbon and tabs ---- */
.ocio .x-ribbon { border-radius: 8px; }
.ocio .da-ribbon .x-title { flex: 1 1 100%; min-width: 0; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 10px 16px; border-right: 0; border-bottom: 1px solid var(--line); }
.ocio .x-title h1 { margin: 0; }
.ocio .x-actions { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-3); }
.ocio .x-facts { flex: 1 1 100%; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); margin: 0 -1px -1px 0; }
.ocio .x-facts .da-fact { padding: 9px 14px; }
.ocio .x-facts .x-wide { grid-column: span 2; }
.ocio .x-facts .da-fact strong { font-size: 18px; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; }
.ocio .x-facts .da-fact strong small { font-weight: 400; }
.ocio .x-facts .fs-track { height: 8px; margin: 4px 0 2px; }
.ocio .x-clk { cursor: pointer; }
.ocio .x-tabrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0 0; border-bottom: 1px solid var(--line); }
.ocio .da-tabs.x-tabs { flex: 1; min-width: 0; margin: 0; border-bottom: 0; }
.ocio .da-tabs.x-tabs button { display: flex; align-items: center; gap: 6px; flex: none; padding: 9px 12px; white-space: nowrap; }
.ocio .x-tabsep { flex: none; width: 1px; margin: 8px 6px; background: var(--line); }

/* ---- grids ---- */
.ocio .x-gridwrap { max-height: max(360px, calc(100vh - 150px)); overflow: auto; margin-top: 10px; }
.ocio .x-gridwrap thead th { position: sticky; top: 0; z-index: 2; }
.ocio .x-rowlink { cursor: pointer; }
.ocio .x-nil { color: var(--ink-4); }
.ocio .x-nw { white-space: nowrap; }
.ocio .x-mut { font-weight: 400; color: var(--ink-3); }
.ocio .x-sp { display: inline-block; flex: none; width: 22px; }

/* the target tree: Strategy, Region, Structure */
.ocio .x-grid { min-width: 1060px; font-variant-numeric: tabular-nums; }
.ocio .x-grid th, .ocio .x-grid td { padding: 6px 8px; }
.ocio .x-grid tbody tr { background: var(--surface); }
.ocio .x-grid tbody tr.x-root { background: var(--bg-alt); }
.ocio .x-grid .x-namecol { position: sticky; left: 0; z-index: 1; min-width: 232px; }
.ocio .x-grid thead .x-namecol { z-index: 3; }
.ocio .x-grid tr.x-has .x-namecol { box-shadow: inset 3px 0 0 var(--accent-2); }
.ocio .x-grid .da-name { gap: 5px; }
.ocio .x-grid .da-name b { min-width: 0; overflow-wrap: anywhere; }
.ocio .x-grid .da-caret { flex: none; width: 20px; height: 20px; margin-right: 2px; }
.ocio .x-m-usd { --mm: 64px; --tg: 70px; }
.ocio .x-m-n { --mm: 40px; --tg: 46px; }
.ocio .x-m-pct { --mm: 58px; --tg: 62px; }
/* Each group ($, #, %) is its own block: min on the left, target in the centre, max on the right, with a rule between groups. */
.ocio .x-grid .x-m { padding-left: 12px; padding-right: 12px; border-left: 1px solid var(--line); }
.ocio .x-grid .x-m-pct + th, .ocio .x-grid .x-m-pct + td { border-left: 1px solid var(--line); }
.ocio .x-grid th.x-m { text-align: center; }
.ocio .x-trio { display: grid; grid-template-columns: var(--mm) var(--tg) var(--mm); gap: 4px; justify-content: space-between; }
.ocio .x-mh { display: grid; grid-template-columns: var(--mm) var(--tg) var(--mm); gap: 4px; justify-content: space-between; margin-top: 2px; font-size: 12px; font-weight: 400; color: var(--ink-3); }
.ocio .x-mh i { font-style: normal; text-align: center; }
.ocio .x-trio input { width: 100%; min-width: 0; padding: 3px 5px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); font: inherit; font-size: 12.5px; color: var(--ink); text-align: right; }
.ocio .x-trio input.tgt { font-weight: 600; border-color: var(--ink-4); }
.ocio .x-trio input::placeholder { color: var(--ink-4); font-weight: 400; }
.ocio .x-trio input.quiet { border-color: transparent; background: transparent; }
.ocio .x-trio input.quiet:hover, .ocio .x-trio input.quiet:focus { border-color: var(--line); background: var(--surface); }
.ocio .x-trio input:disabled { background: var(--bg-alt); color: var(--ink-3); }
.ocio .x-band { display: flex; align-items: center; gap: 8px; min-height: 14px; margin-top: 4px; }
.ocio .x-trk { position: relative; flex: 1; height: 8px; border-radius: 4px; background: var(--bg-alt); }
.ocio .x-trk i { position: absolute; top: 0; bottom: 0; left: 0; }
.ocio .x-trk .r { background: var(--line); }
.ocio .x-trk .f { top: 2px; bottom: 2px; border-radius: 2px; background: var(--ink-4); }
.ocio .x-trk .t { width: 2px; top: -3px; bottom: -3px; margin-left: -1px; background: var(--ink); }
.ocio .x-av { min-width: 52px; font-size: 12px; text-align: right; white-space: nowrap; color: var(--ink-2); }
.ocio .x-band.in .f, .ocio .x-band.at .f { background: var(--green); }
.ocio .x-band.in .x-av, .ocio .x-band.at .x-av { color: var(--green); }
.ocio .x-band.under .f { background: var(--accent-2); }
.ocio .x-band.below .f { background: var(--gold); }
.ocio .x-band.below .x-av { color: var(--amber); }
.ocio .x-band.above .f, .ocio .x-band.over .f { background: var(--red); }
.ocio .x-band.above .x-av, .ocio .x-band.over .x-av { color: var(--red); }
.ocio .x-grid tr.x-bare td { padding-top: 4px; padding-bottom: 4px; }
.ocio .x-barecell { text-align: center; }
.ocio .x-addtarget { padding: 2px 4px; border: 0; background: none; font: inherit; font-size: 12px; color: var(--ink-3); cursor: pointer; }
.ocio tr:hover .x-addtarget, .ocio .x-addtarget:focus { color: var(--accent-2); text-decoration: underline; }
.ocio .x-sum { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.ocio .x-sum .da-st { white-space: nowrap; }
.ocio .x-grid td.x-cmp { font-size: 12.5px; color: var(--ink-2); white-space: nowrap; }
.ocio .x-clearcol { width: 36px; padding-left: 0; }

/* ---- add a sleeve ---- */
.ocio .x-dialog { margin: 12px 0; padding: 14px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
.ocio .x-dialog h2 { margin: 0 0 4px; font-size: 15px; }
.ocio .x-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px 14px; margin: 12px 0; }
.ocio .x-form label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--ink-3); }
.ocio .x-form input, .ocio .x-form select, .ocio .x-sel { padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); font: inherit; font-size: 13px; color: var(--ink); }
.ocio .x-formacts { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.ocio .x-formacts .da-note { margin-right: auto; }

/* ---- commitments ---- */
.ocio .x-hint { margin-left: auto; font-size: 12px; color: var(--ink-3); }
.ocio .x-hgrid { min-width: 0; }
.ocio .x-hgrid th, .ocio .x-hgrid td { padding: 6px 8px; white-space: nowrap; }
.ocio .x-grouprow td { background: var(--bg-alt); font-weight: 600; }
.ocio .da-grid .x-grouprow small { display: inline; margin-left: 10px; }
.ocio .x-tag { padding: 1px 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); font: inherit; font-size: 12px; color: var(--ink-2); cursor: pointer; }
.ocio .x-tag.na { border-style: dashed; background: none; color: var(--ink-4); cursor: default; }
.ocio .x-detail { margin: 12px 0 0; padding: 12px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
.ocio .x-detail small { color: var(--ink-3); font-size: 12px; }
.ocio .x-dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 0 20px; margin: 10px 0 0; font-size: 13px; }
.ocio .x-dl div { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px solid var(--line); }
.ocio .x-dl dt { color: var(--ink-3); }
.ocio .x-dl dd { margin: 0; text-align: right; }

/* ---- pacing ---- */
.ocio .x-set { margin: 0; }
.ocio .x-set label { flex-direction: column; align-items: flex-start; gap: 2px; font-size: 12px; }
.ocio .x-set input { width: 150px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); font: inherit; color: var(--ink); }
.ocio .x-set .da-note { max-width: 52ch; }
.ocio .x-charts { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 12px; margin: 12px 0; }
.ocio .x-charts h4 { margin: 0 0 2px; font-size: 13px; font-weight: 600; }
.ocio .x-charts svg { display: block; width: 100%; height: auto; margin-top: 6px; }
.ocio .x-gl { stroke: var(--line); stroke-width: 1; }
.ocio .x-ax { fill: var(--ink-3); font-size: 12px; }
.ocio .x-lb { fill: var(--ink); font-size: 12px; font-weight: 600; }
.ocio .x-bar { fill: var(--accent-2); }
.ocio .x-tk { stroke: var(--ink); stroke-width: 2; }
.ocio .x-tk.p { stroke: var(--ink-3); stroke-dasharray: 4 3; }
.ocio .x-ring { fill: var(--surface); stroke: var(--amber); stroke-width: 2; }
.ocio .x-area { fill: var(--accent-light); }
.ocio .x-dep { fill: none; stroke: var(--accent-2); stroke-width: 2; }
.ocio .x-tl { fill: none; stroke: var(--ink-3); stroke-width: 1.5; stroke-dasharray: 5 4; }
.ocio .x-pace th, .ocio .x-pace td { white-space: nowrap; }

/* ---- compliance ---- */
.ocio .x-tile { font: inherit; text-align: left; color: inherit; cursor: pointer; }
.ocio .x-tile[aria-pressed="true"] { border-color: var(--accent-2); }
.ocio .x-tile b.bad { color: var(--red); }
.ocio .x-tile b.soft { color: var(--amber); }
.ocio .x-tile b.warn { color: var(--gold); }
.ocio .x-tile b.pend { color: var(--accent-2); }
.ocio .x-tile b.ok { color: var(--green); }
.ocio .x-rules th, .ocio .x-rules td { padding: 6px 8px; }
.ocio .x-rules .da-caret { flex: none; width: 20px; height: 20px; margin-right: 2px; padding: 0; line-height: 1; }
.ocio .da-st.soft, .ocio .da-st.x-soft { background: var(--surface); color: var(--amber); border: 1px solid var(--amber); }
.ocio .da-st.pend, .ocio .da-st.x-st-info { background: var(--badge-info-bg, var(--bg-alt)); color: var(--badge-info-fg, var(--accent-2)); }

/* ---- overview ---- */
.ocio .x-intro .da-note { max-width: 86ch; margin-top: 4px; }
.ocio .x-over th, .ocio .x-over td { padding: 6px 10px; white-space: nowrap; }
.ocio .x-pills .da-st + .da-st { margin-left: 4px; }
.ocio .x-fig.ok { color: var(--green); }
.ocio .x-fig.warn { color: var(--amber); }
.ocio .x-fig.bad { color: var(--red); }
.ocio .x-cov { display: inline-flex; align-items: center; gap: 6px; }
.ocio .x-cov i { width: 14px; height: 6px; border-radius: 2px; background: var(--accent-2); }
.ocio .x-cov.nil { color: var(--ink-4); }
.ocio .x-cov.nil i { background: var(--line); }
.ocio .x-mx td.num { min-width: 128px; }
.ocio .x-mx td.nil { color: var(--ink-4); }

/* ---- pipeline ---- */
.ocio .pipe-mx thead th, .ocio .pipe-mx tbody th { padding: 9px 11px; }
.ocio .pipe-mx thead th:first-child { width: 190px; }
.ocio .pipe-mx th .sx { display: block; font-weight: 400; font-size: 12px; color: var(--ink-3); }
.ocio .pipe-mx .cb .at { font-size: 12px; }
.ocio .x-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 6px; font-size: 12px; color: var(--ink-3); }

@media (max-width: 1100px) {
  .ocio .x-shell, .ocio .x-shell.x-noside { grid-template-columns: minmax(0, 1fr); }
  .ocio .x-rail, .ocio .x-side { position: static; max-height: none; }
  .ocio .x-charts { grid-template-columns: minmax(0, 1fr); }
  .ocio .x-facts .x-wide { grid-column: auto; }
}
`;
