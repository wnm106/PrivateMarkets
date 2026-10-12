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

// Plain-JS helper injected before the user's HTML. Kept ES5-style for simplicity.
const RUNTIME = String.raw`
(function () {
  var handlers = [];
  var last = null;
  var PALETTE = ['#1b3a4b', '#c2410c', '#047857', '#6d28d9', '#0369a1', '#b91c1c', '#a16207', '#475569'];

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
    var w = o.width || 560, h = o.height || 220, pad = { l: 8, r: 8, t: 20, b: 40 };
    var max = Math.max.apply(null, items.map(function (i) { return i.value; }).concat([1]));
    var n = items.length || 1, bw = (w - pad.l - pad.r) / n;
    var color = o.color || PALETTE[0];
    var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="max-width:' + w + 'px" role="img">';
    items.forEach(function (it, i) {
      var bh = Math.max(0, (it.value / max) * (h - pad.t - pad.b));
      var x = pad.l + i * bw + bw * 0.15, y = h - pad.b - bh;
      s += '<rect x="' + x + '" y="' + y + '" width="' + (bw * 0.7) + '" height="' + bh + '" fill="' + color + '"></rect>';
      s += '<text x="' + (x + bw * 0.35) + '" y="' + (y - 4) + '" font-size="10" text-anchor="middle" fill="#444">' + esc(fmt.number(it.value)) + '</text>';
      s += '<text x="' + (x + bw * 0.35) + '" y="' + (h - pad.b + 14) + '" font-size="10" text-anchor="middle" fill="#666">' + esc(it.label.length > 14 ? it.label.slice(0, 13) + '…' : it.label) + '</text>';
    });
    return s + '</svg>';
  }

  function line(items, o) {
    items = norm(items); o = o || {};
    var w = o.width || 560, h = o.height || 220, pad = { l: 36, r: 12, t: 16, b: 32 };
    var vals = items.map(function (i) { return i.value; });
    var max = Math.max.apply(null, vals.concat([1])), min = Math.min.apply(null, vals.concat([0]));
    var span = max - min || 1, n = items.length;
    var color = o.color || PALETTE[0];
    function px(i) { return pad.l + (n <= 1 ? 0 : i * (w - pad.l - pad.r) / (n - 1)); }
    function py(v) { return pad.t + (1 - (v - min) / span) * (h - pad.t - pad.b); }
    var pts = items.map(function (it, i) { return px(i) + ',' + py(it.value); }).join(' ');
    var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="max-width:' + w + 'px" role="img">';
    s += '<line x1="' + pad.l + '" y1="' + (h - pad.b) + '" x2="' + (w - pad.r) + '" y2="' + (h - pad.b) + '" stroke="#ccc"></line>';
    s += '<text x="4" y="' + (pad.t + 4) + '" font-size="10" fill="#666">' + esc(fmt.number(max)) + '</text>';
    s += '<text x="4" y="' + (h - pad.b) + '" font-size="10" fill="#666">' + esc(fmt.number(min)) + '</text>';
    if (n) s += '<polyline fill="none" stroke="' + color + '" stroke-width="2" points="' + pts + '"></polyline>';
    items.forEach(function (it, i) {
      s += '<circle cx="' + px(i) + '" cy="' + py(it.value) + '" r="3" fill="' + color + '"></circle>';
      if (n <= 12 || i % Math.ceil(n / 12) === 0) s += '<text x="' + px(i) + '" y="' + (h - pad.b + 14) + '" font-size="10" text-anchor="middle" fill="#666">' + esc(it.label.length > 10 ? it.label.slice(0, 9) + '…' : it.label) + '</text>';
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

  function table(el, rows, columns) {
    rows = rows || [];
    var cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
    var h = '<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr>';
    cols.forEach(function (c) { h += '<th style="text-align:left;border-bottom:2px solid #ddd;padding:6px 8px;font-weight:600">' + esc(c) + '</th>'; });
    h += '</tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr>';
      cols.forEach(function (c) {
        var v = r[c];
        var isN = typeof v === 'number';
        h += '<td style="border-bottom:1px solid #eee;padding:6px 8px;' + (isN ? 'text-align:right;font-variant-numeric:tabular-nums' : '') + '">' + esc(isN ? fmt.number(v) : v) + '</td>';
      });
      h += '</tr>';
    });
    if (!rows.length) h += '<tr><td colspan="' + (cols.length || 1) + '" style="padding:10px;color:#888">No data</td></tr>';
    h += '</tbody></table>';
    if (el) el.innerHTML = h;
    return h;
  }

  function report() {
    var h = Math.max(document.body ? document.body.scrollHeight : 0, 40);
    parent.postMessage({ type: 'tapestr:resize', height: h }, '*');
  }

  window.tapestr = {
    onData: function (cb) { handlers.push(cb); if (last) { try { cb(last); } catch (e) { console.error(e); } } },
    setParam: function (name, value) { parent.postMessage({ type: 'tapestr:setParam', name: name, value: value }, '*'); },
    fmt: fmt, esc: esc, table: table,
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
<style>html,body{margin:0;padding:0;background:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1c1c1c}</style>
<script>${RUNTIME}<\/script>
</head><body>${userHtml}</body></html>`;
}
