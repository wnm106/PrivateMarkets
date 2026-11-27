/**
 * What the CLO surface adds to the house kit, scoped to the surface root (.clo). One stylesheet
 * for every tab: each class is defined once and means one thing. The house classes (da-*, btn,
 * page-*) come from the host.
 *
 * Sizing rules this file holds to: no text below 12px; names wrap, never cut off; a tall table
 * scrolls inside its frame with its header in view; the page itself never scrolls sideways.
 */
export const CLO_CSS = `
.clo .da-fact > span, .clo .da-fact > small, .clo .da-grid small { font-size: 12px; }

/* ---- values: right-click for sources, or for how a figure is worked out ---- */
.clo .x-bound, .clo .x-derived { cursor: context-menu; border-bottom: 1px dotted transparent; }
.clo .x-bound:hover, .clo .x-derived:hover { border-bottom-color: var(--ink-3); }
.clo .x-nil { color: var(--ink-4); }
.clo .x-mut { color: var(--ink-3); }
.clo .x-up { color: #1b6f46; }
.clo .x-dn { color: #b3261e; }
.clo .x-pop { position: fixed; z-index: 60; width: 380px; overflow: auto; padding: 12px 14px; background: var(--surface); border: 1px solid var(--ink-3); border-radius: 8px; font-size: 13px; color: var(--ink); text-align: left; }
.clo .x-pop p { margin: 8px 0; color: var(--ink-2); line-height: 1.4; }
.clo .x-pophead { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.clo .x-pophead small { display: block; font-size: 12px; color: var(--ink-3); }
.clo .x-pophead b { font-weight: 600; }
.clo .x-pophead b span { font-weight: 400; color: var(--ink-2); }
.clo .x-poprows { width: 100%; border-collapse: collapse; }
.clo .x-poprows td { padding: 5px 0; border-top: 1px solid var(--line); vertical-align: top; }
.clo .x-poprows td:last-child { text-align: right; white-space: nowrap; padding-left: 12px; font-variant-numeric: tabular-nums; }
.clo .x-poprows small { display: block; font-size: 12px; color: var(--ink-3); }
.clo .x-pop .x-popmore { margin: 6px 0 0; font-size: 12px; color: var(--ink-3); }

/* ---- header, vehicle picker, ribbon, tabs ---- */
.clo .x-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; }
.clo .x-pick { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); }
.clo .x-pick select { font: inherit; font-size: 13px; padding: 5px 8px; min-width: 240px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); }
.clo .x-ribbon { margin-top: 10px; border-radius: 8px; }
.clo .x-ribbon .da-fact { flex: 1 1 104px; min-width: 104px; padding: 9px 12px; }
.clo .x-ribbon .da-fact strong { font-size: 17px; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; }
.clo .x-ribbon .da-fact strong small { font-size: 12px; font-weight: 400; color: var(--ink-3); }
.clo .x-ribbon .da-fact strong .x-derived, .clo .x-ribbon .da-fact strong .x-bound, .clo .x-ribbon .da-fact strong .x-nil { font-size: inherit; }
.clo .da-tabs.x-tabs { margin: 12px 0 0; }
.clo .da-tabs.x-tabs button { display: flex; align-items: center; gap: 6px; flex: none; white-space: nowrap; }
.clo .x-count { font-size: 12px; color: var(--ink-3); font-weight: 400; }
.clo .x-note { margin: 6px 0 0; font-size: 12px; color: var(--ink-3); line-height: 1.4; }
.clo .x-empty { padding: 28px 16px; text-align: center; color: var(--ink-3); font-size: 13px; }
.clo .x-error { margin: 10px 0; padding: 10px 12px; border: 1px solid #f0c2bd; border-radius: 8px; background: #fdf2f1; color: #8a1f17; font-size: 13px; }
.clo .x-pane[hidden] { display: none; }

/* ---- status, gauges, trends ---- */
.clo .x-st { display: inline-block; font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 999px; white-space: nowrap; }
.clo .x-st.ok { background: #e1f2e8; color: #1b6f46; }
.clo .x-st.near { background: #faefdb; color: var(--amber); }
.clo .x-st.breach { background: #fbe6e4; color: #b3261e; }
.clo .x-st.na { background: var(--bg-alt); color: var(--ink-3); }
.clo .x-gauge { display: inline-block; width: 72px; height: 6px; border-radius: 3px; background: var(--bg-alt); overflow: hidden; vertical-align: middle; }
.clo .x-gauge i { display: block; height: 100%; border-radius: 3px; }
.clo .x-gauge.ok i { background: #3f8f68; }
.clo .x-gauge.near i { background: #c58a1d; }
.clo .x-gauge.breach i { background: #c2412f; }
.clo .x-trend { display: block; }
.clo .x-trend-line { fill: none; stroke: #0b5d73; stroke-width: 2; }
.clo .x-trend-limit { fill: none; stroke: #b3261e; stroke-width: 1; stroke-dasharray: 4 3; }
.clo .x-trend-dot { fill: #0b5d73; }

/* ---- sections, cards ---- */
.clo .x-section { margin-top: 16px; }
.clo .x-section > h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
.clo .x-subhead { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--ink-2); }
.clo .x-section > p { margin: 0 0 8px; font-size: 13px; color: var(--ink-3); }
.clo .x-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.clo .x-cols > * { min-width: 0; }
.clo .x-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; margin-top: 10px; }
.clo .x-card { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
.clo .x-card.breach { border-top: 3px solid #c2412f; }
.clo .x-card.near { border-top: 3px solid #c58a1d; }
.clo .x-card.ok { border-top: 3px solid #3f8f68; }
.clo .x-card.na { border-top: 3px solid var(--line); }
.clo .x-card header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 13px; color: var(--ink-2); }
.clo .x-card header b { font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
.clo .x-card .x-big { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.clo .x-card dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; font-size: 13px; }
.clo .x-card dt { color: var(--ink-3); }
.clo .x-card dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }

/* ---- tables ---- */
.clo .x-frame { max-height: max(360px, calc(100vh - 260px)); overflow: auto; margin-top: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.clo .x-frame.x-short { max-height: none; }
.clo .x-table { min-width: 0; font-variant-numeric: tabular-nums; }
.clo .x-table thead th { position: sticky; top: 0; z-index: 2; white-space: normal; vertical-align: bottom; }
.clo .x-table th, .clo .x-table td { padding: 7px 8px; vertical-align: top; }
.clo .x-table td.num { white-space: nowrap; }
.clo .x-table td.x-name { min-width: 180px; }
.clo .x-table tbody td.x-name { position: sticky; left: 0; z-index: 1; background: var(--surface); }
.clo .x-table thead th.x-name { left: 0; z-index: 3; }
.clo .x-table tr.x-total td { background: var(--bg-alt); font-weight: 600; }
.clo .x-table tr.x-click { cursor: pointer; }
.clo .x-table tr.x-click:hover td { background: var(--bg-alt); }
.clo .x-table tr.x-on td { background: #e7f1f4; }
.clo .x-table tr.x-group td { background: var(--bg-alt); font-weight: 600; color: var(--ink-2); }
.clo .x-table .x-sep { border-left: 1px solid var(--line); }
.clo .x-namebox { display: flex; flex-direction: column; min-width: 0; }
.clo .x-namebox > a, .clo .x-namebox > b { overflow-wrap: anywhere; }
.clo .x-namebox small { color: var(--ink-3); font-size: 12px; }
.clo .x-rec { color: inherit; text-decoration: none; overflow-wrap: anywhere; }
.clo .x-rec:hover { text-decoration: underline; }
.clo .x-flags { display: flex; flex-wrap: wrap; gap: 4px; }
.clo .x-flag { font-size: 12px; padding: 0 6px; border-radius: 4px; background: var(--bg-alt); color: var(--ink-2); white-space: nowrap; }
.clo .x-flag.bad { background: #fbe6e4; color: #b3261e; }

/* ---- toolbar ---- */
.clo .x-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; margin-top: 12px; font-size: 13px; }
.clo .x-toolbar label { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); }
.clo .x-toolbar select, .clo .x-toolbar input { font: inherit; font-size: 13px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: inherit; }
.clo .x-search { width: 220px; }

/* ---- indenture: terms and the test drill-down ---- */
.clo .x-terms { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.clo .x-terms section { padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
.clo .x-terms h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-3); }
.clo .x-terms dl { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 3px 12px; margin: 0; font-size: 13px; }
.clo .x-terms dt { color: var(--ink-2); overflow-wrap: anywhere; }
.clo .x-terms dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.clo .x-drill { margin-top: 10px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--ink-4); border-radius: 8px; }
.clo .x-drill header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.clo .x-drill h3 { margin: 0; font-size: 15px; }
.clo .x-acts { display: flex; align-items: center; gap: 8px; }
.clo .x-drill p { margin: 6px 0; font-size: 13px; color: var(--ink-2); line-height: 1.45; }

/* ---- capital structure bar ---- */
.clo .x-stack { display: flex; height: 34px; border-radius: 6px; overflow: hidden; border: 1px solid var(--line); margin-top: 8px; }
.clo .x-stack > span { display: flex; align-items: center; justify-content: center; min-width: 0; color: #fff; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; }

/* ---- waterfall ---- */
.clo .x-flow { display: grid; grid-template-columns: minmax(180px, 260px) minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; font-size: 13px; }
.clo .x-flow .x-bar { height: 14px; border-radius: 3px; background: var(--bg-alt); position: relative; overflow: hidden; }
.clo .x-flow .x-bar i { position: absolute; top: 0; bottom: 0; border-radius: 3px; }
.clo .x-flow .x-bar i.expense { background: #7a868f; }
.clo .x-flow .x-bar i.fee { background: #9a7bb5; }
.clo .x-flow .x-bar i.interest { background: #0b5d73; }
.clo .x-flow .x-bar i.cure { background: #c2412f; }
.clo .x-flow .x-bar i.residual { background: #3f8f68; }
.clo .x-flow .x-label { overflow-wrap: anywhere; }
.clo .x-flow .x-amt { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

@media (max-width: 1100px) { .clo .x-cols { grid-template-columns: minmax(0, 1fr); } }
`;
