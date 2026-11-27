/**
 * Builds the `srcdoc` for a custom dashboard.
 *
 * Security model:
 *  - The iframe is sandboxed with `allow-scripts` ONLY (no allow-same-origin), so the
 *    dashboard runs in an opaque origin: no cookies, no localStorage, no access to the
 *    parent DOM or the user's auth token.
 *  - A CSP blocks all network access (fetch/XHR/websocket/img/script/style from anywhere
 *    except inline), so the page can only display what the host posts into it.
 *  - Data flows exclusively host -> iframe via postMessage.
 */

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
].join('; ');

/**
 * The house tokens and the few shared classes every dashboard uses, the same values as the
 * app's global stylesheet (apps/web/styles/globals.css :root). The frame cannot load that
 * stylesheet, so the tokens are copied here; a dashboard styles itself from var(--…) only and
 * puts what it adds in one block of x- classes, as a surface does (surfaces/README.md).
 */
export const DASHBOARD_BASE_CSS = `
:root{--bg:#f8fafc;--bg-alt:#f1f5f9;--surface:#ffffff;--ink:#0f172a;--ink-2:#334155;--ink-3:#475569;--ink-4:#64748b;
--line:#e2e8f0;--line-strong:#cbd5e1;--accent:#00334e;--accent-2:#0e7490;--accent-light:rgba(14,116,144,.18);
--green:#047857;--red:#b91c1c;--amber:#92400e;--badge-warn-bg:#fde8c0;--badge-warn-fg:#92400e;--badge-ok-bg:#dcfce7;
--badge-ok-fg:#166534;--badge-bad-bg:#fee2e2;--badge-bad-fg:#b91c1c;--badge-info-bg:#cffafe;--badge-info-fg:#0e7490;
--radius-sm:4px;--radius:6px;--radius-lg:8px;--focus-ring:0 0 0 3px rgba(14,116,144,.25);
--font:'Inter','Segoe UI',system-ui,-apple-system,sans-serif}
html,body{margin:0;padding:0;background:var(--surface);color:var(--ink);font:14px/1.45 var(--font)}
*{box-sizing:border-box}
.num{text-align:right;font-variant-numeric:tabular-nums}
[data-attr],[data-derived]{cursor:context-menu;text-decoration:underline dotted transparent;text-underline-offset:3px}
[data-attr]:hover,[data-derived]:hover{text-decoration-color:var(--ink-4)}
:focus-visible{outline:none;box-shadow:var(--focus-ring);border-radius:var(--radius-sm)}
.t-frame{max-height:480px;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-lg)}
.t-table{width:100%;border-collapse:collapse;font-size:13px}
.t-table th{position:sticky;top:0;z-index:1;background:var(--bg-alt);color:var(--ink-3);font-size:12px;font-weight:600;text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
.t-table td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
.t-table tbody tr:hover td{background:var(--bg)}
.t-empty,.t-loading{padding:10px 12px;color:var(--ink-3);font-size:13px}
.t-error{padding:10px 12px;border-radius:var(--radius);background:var(--badge-bad-bg);color:var(--badge-bad-fg);font-size:13px}
.t-panel{position:absolute;z-index:10;max-width:360px;min-width:220px;padding:10px 12px;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-lg);font-size:13px}
.t-panel-k{margin-top:6px;color:var(--ink-3);font-size:12px}
.t-panel-k:first-child{margin-top:0}
.t-panel-how{margin-top:2px}
.t-panel ul{list-style:none;margin:4px 0 0;padding:0;max-height:240px;overflow:auto}
.t-panel li{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px solid var(--line)}
`;
const BASE_CSS = DASHBOARD_BASE_CSS.replace(/\n/g, '');

// Plain-JS helper injected before the user's HTML. Kept ES5-style for simplicity.
const RUNTIME = String.raw`
(function () {
  var handlers = [];
  var last = null;
  var PALETTE = ['#00334e', '#0e7490', '#047857', '#b45309', '#6d28d9', '#be185d', '#0369a1', '#475569'];
  var ACCENT = '#00334e';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  var fmt = {
    number: function (v, d) {
      if (!isNum(Number(v)) || v === null || v === '') return v == null ? '' : String(v);
      return Number(v).toLocaleString(undefined, { maximumFractionDigits: d == null ? 2 : d, minimumFractionDigits: 0 });
    },
    currency: function (v, code) {
      if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '';
      try { return Number(v).toLocaleString(undefined, { style: 'currency', currency: code || 'USD', maximumFractionDigits: 0 }); }
      catch (e) { return String(v); }
    },
    percent: function (v, d) {
      if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '';
      return (Number(v) * 100).toFixed(d == null ? 1 : d) + '%';
    },
    date: function (v) {
      if (!v) return '';
      var dt = new Date(v);
      return isNaN(dt.getTime()) ? String(v) : dt.toLocaleDateString();
    }
  };

  function norm(items) {
    return (items || []).map(function (i) { return { label: String(i.label == null ? '' : i.label), value: Number(i.value) || 0 }; });
  }

  function bar(items, o) {
    items = norm(items); o = o || {};
    var w = o.width || 560, h0 = o.height || 220;
    var max = Math.max.apply(null, items.map(function (i) { return i.value; }).concat([1]));
    var n = items.length || 1, bw = (w - 16) / n;
    // Labels are 12px (about 7px a character). Narrow bars get slanted labels instead of
    // overlapping ones, and the figure moves into the hover title when it cannot fit above the bar.
    var fits = Math.floor(bw / 7.2);
    var slant = items.some(function (it) { return it.label.length > fits; });
    var longest = items.reduce(function (m, it) { return Math.max(m, Math.min(it.label.length, 28)); }, 0);
    var widest = items.reduce(function (m, it) { return Math.max(m, fmt.number(it.value).length); }, 0);
    var showValues = bw >= widest * 7.2 + 4;
    var drop = slant ? Math.ceil(longest * 7.2 * 0.64) + 24 : 40;
    var pad = { l: slant ? Math.min(140, Math.ceil(longest * 5.5)) : 8, r: 8, t: showValues ? 20 : 8, b: drop };
    var h = h0 + (slant ? drop - 40 : 0);
    bw = (w - pad.l - pad.r) / n;
    var color = o.color || ACCENT;
    var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="max-width:' + w + 'px" role="img">';
    items.forEach(function (it, i) {
      var bh = Math.max(0, (it.value / max) * (h - pad.t - pad.b));
      var x = pad.l + i * bw + bw * 0.15, y = h - pad.b - bh, cx = x + bw * 0.35;
      var chars = slant ? 28 : fits;
      var text = it.label.length > chars ? it.label.slice(0, chars - 1) + '…' : it.label;
      s += '<g><title>' + esc(it.label + ': ' + fmt.number(it.value)) + '</title>';
      s += '<rect x="' + x + '" y="' + y + '" width="' + (bw * 0.7) + '" height="' + bh + '" fill="' + color + '"></rect>';
      if (showValues) s += '<text x="' + cx + '" y="' + (y - 4) + '" font-size="12" text-anchor="middle" fill="#334155" style="font-variant-numeric:tabular-nums">' + esc(fmt.number(it.value)) + '</text>';
      if (slant) s += '<text x="' + cx + '" y="' + (h - pad.b + 14) + '" font-size="12" text-anchor="end" fill="#475569" transform="rotate(-40 ' + cx + ' ' + (h - pad.b + 14) + ')">' + esc(text) + '</text></g>';
      else s += '<text x="' + cx + '" y="' + (h - pad.b + 16) + '" font-size="12" text-anchor="middle" fill="#475569">' + esc(text) + '</text></g>';
    });
    return s + '</svg>';
  }

  function line(items, o) {
    items = norm(items); o = o || {};
    var w = o.width || 560, h = o.height || 220, pad = { l: 36, r: 12, t: 16, b: 32 };
    var vals = items.map(function (i) { return i.value; });
    var max = Math.max.apply(null, vals.concat([1])), min = Math.min.apply(null, vals.concat([0]));
    var span = max - min || 1, n = items.length;
    var color = o.color || ACCENT;
    function px(i) { return pad.l + (n <= 1 ? 0 : i * (w - pad.l - pad.r) / (n - 1)); }
    function py(v) { return pad.t + (1 - (v - min) / span) * (h - pad.t - pad.b); }
    var pts = items.map(function (it, i) { return px(i) + ',' + py(it.value); }).join(' ');
    var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="max-width:' + w + 'px" role="img">';
    s += '<line x1="' + pad.l + '" y1="' + (h - pad.b) + '" x2="' + (w - pad.r) + '" y2="' + (h - pad.b) + '" stroke="#e2e8f0"></line>';
    s += '<text x="4" y="' + (pad.t + 4) + '" font-size="12" fill="#475569">' + esc(fmt.number(max)) + '</text>';
    s += '<text x="4" y="' + (h - pad.b) + '" font-size="12" fill="#475569">' + esc(fmt.number(min)) + '</text>';
    if (n) s += '<polyline fill="none" stroke="' + color + '" stroke-width="2" points="' + pts + '"></polyline>';
    items.forEach(function (it, i) {
      s += '<circle cx="' + px(i) + '" cy="' + py(it.value) + '" r="3" fill="' + color + '"><title>' + esc(it.label + ': ' + fmt.number(it.value)) + '</title></circle>';
      if (n <= 12 || i % Math.ceil(n / 12) === 0) s += '<text x="' + px(i) + '" y="' + (h - pad.b + 16) + '" font-size="12" text-anchor="middle" fill="#475569">' + esc(it.label.length > 10 ? it.label.slice(0, 9) + '…' : it.label) + '</text>';
    });
    return s + '</svg>';
  }

  function donut(items, o) {
    items = norm(items).filter(function (i) { return i.value > 0; }); o = o || {};
    var size = o.height || 200, r = size / 2 - 12, c = 2 * Math.PI * r;
    var total = items.reduce(function (a, i) { return a + i.value; }, 0) || 1;
    var s = '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">';
    s += '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" role="img"><g transform="rotate(-90 ' + size / 2 + ' ' + size / 2 + ')">';
    var off = 0;
    items.forEach(function (it, i) {
      var len = (it.value / total) * c;
      s += '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="' + PALETTE[i % PALETTE.length] + '" stroke-width="22" stroke-dasharray="' + len + ' ' + (c - len) + '" stroke-dashoffset="' + (-off) + '"></circle>';
      off += len;
    });
    s += '</g></svg><div style="font-size:12px">';
    items.forEach(function (it, i) {
      s += '<div style="margin:2px 0"><span style="display:inline-block;width:10px;height:10px;background:' + PALETTE[i % PALETTE.length] + ';margin-right:6px"></span>' + esc(it.label) + ' — ' + esc(fmt.number(it.value)) + ' (' + (it.value / total * 100).toFixed(1) + '%)</div>';
    });
    return s + '</div></div>';
  }

  // ---- Bindings: every value answers right-click (surfaces/README.md) ----
  // data-attr="CODE" marks a value read from an attribute. data-entity / data-domain name the
  // record it belongs to; without them it belongs to the record the dashboard is open on.
  // data-derived="how it is worked out" marks a figure computed from others; data-query and
  // data-column name the rows behind it, so the panel can list them, each bound in turn.
  function attrName(code) {
    return String(code || '').toLowerCase().replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }
  function bindAttr(code, row, name) {
    if (!code) return '';
    var r = row || {};
    var s = ' data-attr="' + esc(code) + '"';
    if (r.entity_id) s += ' data-entity="' + esc(r.entity_id) + '"';
    if (r.domain_code) s += ' data-domain="' + esc(r.domain_code) + '"';
    if (r.entity_name) s += ' data-entity-name="' + esc(r.entity_name) + '"';
    if (name) s += ' data-attr-name="' + esc(name) + '"';
    return s;
  }
  function bindDerived(how, queryKey, column) {
    var s = ' data-derived="' + esc(how || 'Worked out from other values') + '"';
    if (queryKey) s += ' data-query="' + esc(queryKey) + '"';
    if (column) s += ' data-column="' + esc(column) + '"';
    return s;
  }
  var ATTR_CODE = /^[A-Z][A-Z0-9_]*$/;

  function table(el, rows, columns) {
    rows = rows || [];
    var cols = (columns || (rows[0] ? Object.keys(rows[0]).filter(function (k) { return !/^(entity_id|domain_code)$/.test(k); }) : []))
      .map(function (c) { return typeof c === 'string' ? { key: c, label: c } : c; });
    var h = '<div class="t-frame"><table class="t-table"><thead><tr>';
    cols.forEach(function (c) {
      var kind = c.align === 'right' ? 'num' : '';
      if (!kind) {
        for (var i = 0; i < rows.length; i++) {
          var v = rows[i][c.key];
          if (v == null || v === '') continue;
          var next = typeof v === 'number' ? 'num' : (/^\d{4}-\d{2}-\d{2}/.test(String(v)) ? 'num' : 'text');
          if (!kind) kind = next;
          else if (kind !== next) { kind = 'text'; break; }
        }
      }
      c._num = kind === 'num';
      h += '<th' + (c._num ? ' class="num"' : '') + '>' + esc(c.label == null ? c.key : c.label) + '</th>';
    });
    h += '</tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr>';
      cols.forEach(function (c) {
        var v = r[c.key];
        var shown = c.format ? c.format(v, r) : (typeof v === 'number' ? fmt.number(v) : v);
        // A column read from an attribute binds each cell; a derived column says how it is worked out.
        var code = c.attr || (ATTR_CODE.test(c.key) ? c.key : '');
        var bind = c.derived ? bindDerived(c.derived) : (code && r.entity_id ? bindAttr(code, r, c.label) : '');
        if (!bind && (c.key === 'entity_name' || c.key === 'entity_code') && r.entity_id) bind = bindAttr('ENTITY_NAME', r, 'Name');
        if (!bind && typeof v === 'number') bind = bindDerived(c.label ? c.label + ' for this row' : 'From the data query');
        h += '<td' + (c._num ? ' class="num"' : '') + bind + '>' + esc(shown) + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    if (!rows.length) h = '<div class="t-empty">Nothing matched at this As Of date.</div>';
    if (el) el.innerHTML = h;
    return h;
  }

  function anchor() { return (last && last.entity) || {}; }
  function closePanel() { var p = document.getElementById('t-derived'); if (p) p.parentNode.removeChild(p); }
  function derivedPanel(el, x, y) {
    closePanel();
    var p = document.createElement('div');
    p.id = 't-derived';
    p.className = 't-panel';
    var body = '<div class="t-panel-k">How it is worked out</div><div class="t-panel-how">' + esc(el.getAttribute('data-derived')) + '</div>';
    var key = el.getAttribute('data-query'), col = el.getAttribute('data-column');
    var set = key && last && last.data ? last.data[key] : null;
    var rows = set && set.rows ? set.rows : [];
    if (rows.length) {
      body += '<div class="t-panel-k">Records behind it (' + rows.length + ')</div><ul>';
      rows.slice(0, 25).forEach(function (r) {
        var label = r.entity_name || r.label || r.entity_code || '';
        var val = col ? r[col] : (r.value != null ? r.value : '');
        var bind = col && ATTR_CODE.test(col) && r.entity_id ? bindAttr(col, r) : '';
        body += '<li><span>' + esc(label) + '</span><span class="num"' + bind + '>' + esc(typeof val === 'number' ? fmt.number(val) : val) + '</span></li>';
      });
      body += '</ul>';
      if (rows.length > 25) body += '<div class="t-panel-k">and ' + (rows.length - 25) + ' more</div>';
    }
    p.innerHTML = body;
    document.body.appendChild(p);
    var w = document.documentElement.clientWidth;
    p.style.left = Math.max(8, Math.min(x, w - p.offsetWidth - 8)) + 'px';
    p.style.top = (y + window.scrollY + 4) + 'px';
  }
  document.addEventListener('contextmenu', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var bound = t.closest('[data-attr]');
    var derived = t.closest('[data-derived]');
    // The innermost marking wins, so a bound cell inside a derived block opens its own sources.
    if (bound && (!derived || derived.contains(bound))) {
      if (bound.matches('input, textarea') && document.activeElement === bound) return;
      e.preventDefault();
      closePanel();
      var a = anchor();
      parent.postMessage({
        type: 'tapestr:inspect',
        target: {
          entityId: bound.getAttribute('data-entity') || a.entityId || null,
          entityName: bound.getAttribute('data-entity-name') || (bound.getAttribute('data-entity') ? undefined : a.entityName),
          domainCode: bound.getAttribute('data-domain') || (bound.getAttribute('data-entity') ? undefined : a.domainCode),
          attributeCode: bound.getAttribute('data-attr'),
          attributeName: bound.getAttribute('data-attr-name') || attrName(bound.getAttribute('data-attr')),
          value: bound.value != null && bound.matches('input, textarea, select') ? String(bound.value) : (bound.textContent || '').trim()
        }
      }, '*');
      return;
    }
    if (derived) { e.preventDefault(); derivedPanel(derived, e.clientX, e.clientY); }
  });
  document.addEventListener('click', function (e) {
    var p = document.getElementById('t-derived');
    if (p && !p.contains(e.target)) closePanel();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePanel(); });

  function report() {
    var h = Math.max(document.body ? document.body.scrollHeight : 0, 40);
    parent.postMessage({ type: 'tapestr:resize', height: h }, '*');
  }

  window.tapestr = {
    onData: function (cb) { handlers.push(cb); if (last) { try { cb(last); } catch (e) { console.error(e); } } },
    setParam: function (name, value) { parent.postMessage({ type: 'tapestr:setParam', name: name, value: value }, '*'); },
    fmt: fmt, esc: esc, table: table,
    bind: { attr: bindAttr, derived: bindDerived },
    charts: { bar: bar, line: line, donut: donut }
  };

  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'tapestr:data') return;
    last = e.data.payload;
    handlers.forEach(function (h) {
      try { h(last); } catch (err) { parent.postMessage({ type: 'tapestr:error', message: String(err && err.message || err) }, '*'); }
    });
    setTimeout(report, 30);
  });
  window.addEventListener('error', function (e) {
    parent.postMessage({ type: 'tapestr:error', message: String(e.message) }, '*');
  });
  if (typeof ResizeObserver !== 'undefined') {
    window.addEventListener('DOMContentLoaded', function () { new ResizeObserver(report).observe(document.body); });
  }
  // Signal readiness only after the user's HTML/scripts have run, so onData handlers are registered.
  window.addEventListener('load', function () { parent.postMessage({ type: 'tapestr:ready' }, '*'); });
})();
`;

export function buildDashboardSrcDoc(userHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${BASE_CSS}</style>
<script>${RUNTIME}<\/script>
</head><body>${userHtml}</body></html>`;
}
