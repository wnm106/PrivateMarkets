/**
 * What the Performance surface adds to the house kit, scoped to the surface root (.performance).
 * One stylesheet for every tab: each class is defined once and means one thing. The house
 * classes (da-*, btn, page-*) come from the host.
 *
 * Sizing rules this file holds to: no text below 12px except the kit's own tags; names wrap,
 * never cut off; a tall table scrolls inside its frame with its header in view; the page
 * itself never scrolls sideways.
 */
export const PERF_CSS = `
.performance .da-fact > span, .performance .da-fact > small, .performance .da-grid small { font-size: 12px; }

/* ---- values: right-click for sources, or for how a figure is worked out ---- */
.performance .x-bound, .performance .x-derived { cursor: context-menu; border-bottom: 1px dotted transparent; }
.performance .x-bound:hover, .performance .x-derived:hover { border-bottom-color: var(--ink-3); }
.performance .x-nil { color: var(--ink-4); }
.performance .x-mut { color: var(--ink-3); }
.performance .x-up { color: #1b6f46; }
.performance .x-dn { color: #b3261e; }
.performance .x-pop { position: fixed; z-index: 60; width: 380px; overflow: auto; padding: 12px 14px; background: var(--surface); border: 1px solid var(--ink-3); border-radius: 8px; font-size: 13px; color: var(--ink); text-align: left; }
.performance .x-pop p { margin: 8px 0; color: var(--ink-2); line-height: 1.4; }
.performance .x-pophead { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.performance .x-pophead small { display: block; font-size: 12px; color: var(--ink-3); }
.performance .x-pophead b { font-weight: 600; }
.performance .x-pophead b span { font-weight: 400; color: var(--ink-2); }
.performance .x-poprows { width: 100%; border-collapse: collapse; }
.performance .x-poprows td { padding: 5px 0; border-top: 1px solid var(--line); vertical-align: top; }
.performance .x-poprows td:last-child { text-align: right; white-space: nowrap; padding-left: 12px; font-variant-numeric: tabular-nums; }
.performance .x-poprows small { display: block; font-size: 12px; color: var(--ink-3); }
.performance .x-pop .x-popmore { margin: 6px 0 0; font-size: 12px; color: var(--ink-3); }

/* ---- header, period control, ribbon, tabs ---- */
.performance .x-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; }
.performance .x-period-seg { display: inline-flex; flex-wrap: wrap; gap: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.performance .x-period-seg button { padding: 6px 12px; border: 0; border-right: 1px solid var(--line); background: var(--surface); font: inherit; font-size: 13px; color: var(--ink-2); cursor: pointer; }
.performance .x-period-seg button:last-child { border-right: 0; }
.performance .x-period-seg button[aria-pressed="true"] { background: var(--bg-alt); color: var(--ink); font-weight: 600; }
.performance .x-ribbon { margin-top: 10px; border-radius: 8px; }
.performance .x-ribbon .da-fact { flex: 1 1 128px; min-width: 128px; padding: 9px 14px; }
.performance .x-ribbon .da-fact strong { font-size: 18px; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; }
.performance .x-ribbon .da-fact strong small { font-size: 12px; font-weight: 400; color: var(--ink-3); }
/* The kit sizes every span in a fact at 12px; the figure itself keeps the fact's size. */
.performance .x-ribbon .da-fact strong .x-derived, .performance .x-ribbon .da-fact strong .x-nil { font-size: inherit; }
.performance .da-tabs.x-tabs { margin: 12px 0 0; }
.performance .da-tabs.x-tabs button { display: flex; align-items: center; gap: 6px; flex: none; white-space: nowrap; }
.performance .x-count { font-size: 12px; color: var(--ink-3); font-weight: 400; }
.performance .x-note { margin: 6px 0 0; font-size: 12px; color: var(--ink-3); }
.performance .x-empty { padding: 28px 16px; text-align: center; color: var(--ink-3); font-size: 13px; }
.performance .x-error { margin: 10px 0; padding: 10px 12px; border: 1px solid #f0c2bd; border-radius: 8px; background: #fdf2f1; color: #8a1f17; font-size: 13px; }

/* ---- tables ---- */
.performance .x-frame { max-height: max(360px, calc(100vh - 240px)); overflow: auto; margin-top: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.performance .x-table { min-width: 0; font-variant-numeric: tabular-nums; }
.performance .x-table thead th { position: sticky; top: 0; z-index: 2; white-space: nowrap; }
.performance .x-table thead tr.x-sub th { top: 52px; }
.performance .x-table th, .performance .x-table td { padding: 7px 10px; }
.performance .x-table td.num { white-space: nowrap; }
.performance .x-table td:first-child { min-width: 220px; }
/* Row names stay in view when a wide table scrolls sideways inside its frame. */
.performance .x-table tbody td:first-child { position: sticky; left: 0; z-index: 1; background: var(--surface); }
.performance .x-table thead th:first-child { left: 0; z-index: 3; }
.performance .x-table .x-sep { border-left: 1px solid var(--line); }
.performance .x-table th.x-period { text-align: center; border-left: 1px solid var(--line); }
.performance .x-table tr.x-total td, .performance .x-table tbody tr.x-total td:first-child { background: var(--bg-alt); font-weight: 600; }
.performance .x-table tr.x-parent td { font-weight: 500; }
.performance .x-table tr.x-child td { color: var(--ink-2); }
.performance .x-block { display: block; font-weight: 400; color: var(--ink-3); }
.performance .x-namerow { display: flex; align-items: flex-start; gap: 4px; }
.performance .x-indent { padding-left: 26px; }
.performance .x-namebox { display: flex; flex-direction: column; min-width: 0; }
.performance .x-namebox > a, .performance .x-namebox > b { overflow-wrap: anywhere; }
.performance .x-namebox small { color: var(--ink-3); }
.performance .x-rec { color: inherit; text-decoration: none; overflow-wrap: anywhere; }
.performance .x-rec:hover { text-decoration: underline; }
.performance .x-caret { flex: none; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px; background: none; font-size: 13px; color: var(--ink-3); cursor: pointer; }
.performance .x-caret:hover { background: var(--bg-alt); color: var(--ink); }
.performance .x-sp { display: inline-block; flex: none; width: 22px; }

/* ---- toolbar and the ad hoc builder ---- */
.performance .x-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; margin-top: 12px; font-size: 13px; }
.performance .x-toolbar label { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); }
.performance .x-toolbar select, .performance .x-pick select, .performance .x-toolbar input, .performance .x-custom input { font: inherit; font-size: 13px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: inherit; }
.performance .x-search { width: 220px; }
.performance .x-builder { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); align-items: start; gap: 10px; margin-top: 12px; }
.performance .x-pick { display: flex; flex-direction: column; gap: 6px; min-width: 0; margin: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); font-size: 13px; }
.performance .x-pick legend { padding: 0 4px; font-size: 12px; font-weight: 600; color: var(--ink-3); text-transform: uppercase; letter-spacing: .04em; }
.performance .x-dd summary { cursor: pointer; color: var(--ink-2); }
.performance .x-ddlist { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; margin-top: 6px; padding: 6px; border: 1px solid var(--line); border-radius: 6px; }
.performance .x-ddlist label, .performance .x-checks label { display: flex; align-items: flex-start; gap: 6px; overflow-wrap: anywhere; }
.performance .x-checks { display: flex; flex-direction: column; gap: 4px; }
.performance .x-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.performance .x-chipx { margin-left: 2px; padding: 0 2px; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
.performance .x-custom { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.performance .x-custom label { display: inline-flex; align-items: center; gap: 4px; color: var(--ink-2); }
.performance .x-acts { display: flex; gap: 8px; }
`;
