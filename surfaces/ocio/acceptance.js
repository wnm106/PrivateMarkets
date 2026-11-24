// Run in the browser on the built surface, once per tab, at 1440x900 and at 1920x1080.
// It returns { tab, viewport, passed, lines }. Every line must pass before the surface is done.
// Put the returned tables in your hand-back, failing lines included.
(function surfaceAcceptance(expect) {
  var root = document.querySelector(expect.root) || document.querySelector('main') || document.body;
  var visible = function (el) { return !!(el.offsetParent || el.getClientRects().length); };
  var all = Array.prototype.slice.call(root.querySelectorAll('*')).filter(visible);
  var FIGURE = /^[≈~<>≤≥]?\s*[-(]?[$€£]?\d[\d,.]*\s?(%|x|bps|[kmb]|bn|mm|#)?\)?$/i;
  var HOUSE_CONTROL = '.btn, .cr-type, .cr-rule, .da-chip, .status-pill';
  var covered = function (el) { return !!el.closest('[data-attr], [data-derived]'); };
  var label = function (el) { return (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 48); };
  var sample = function (list) { return list.slice(0, 8).map(label); };

  // 1. Every figure opens something on right-click: its sources, or how it is worked out.
  // A figure is an element whose own text is a number and nothing else. A year is a label, and a
  // number inside a sentence ("7 rules", "$280M vs $238M") is read with the sentence, not on its own.
  var YEAR = /^(19|20)\d\d$/;
  var figures = [];
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (var node = walker.nextNode(); node; node = walker.nextNode()) {
    var parent = node.parentElement;
    if (!parent || !visible(parent) || figures.indexOf(parent) >= 0) continue;
    if (parent.closest('th, label, option, h1, h2, h3, h4, legend, caption, svg, style, script, [role=tab], ' + HOUSE_CONTROL)) continue;
    var own = Array.prototype.filter.call(parent.childNodes, function (child) { return child.nodeType === 3; })
      .map(function (child) { return child.nodeValue; }).join('').replace(/\s+/g, ' ').trim();
    if (FIGURE.test(own) && !YEAR.test(own)) figures.push(parent);
  }
  Array.prototype.forEach.call(root.querySelectorAll('input'), function (input) {
    if (visible(input) && input.value && FIGURE.test(input.value.trim())) figures.push(input);
  });
  var unbound = figures.filter(function (el) { return !covered(el); });
  var bound = root.querySelectorAll('[data-attr]').length;
  var derived = root.querySelectorAll('[data-derived]').length;

  // 2. Nothing is clipped inside an input: typed values and implied placeholders both fit.
  var ctx = document.createElement('canvas').getContext('2d');
  var clipped = Array.prototype.filter.call(root.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=date]), select'), function (input) {
    if (!visible(input) || input.tagName === 'SELECT') return false;
    var text = input.value || (/\d/.test(input.placeholder || '') ? input.placeholder : '');
    if (!text) return false;
    var style = getComputedStyle(input);
    ctx.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
    return ctx.measureText(text).width > input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 0.5;
  });

  // 3. No text is cut off with an ellipsis or a hidden overflow.
  var truncated = all.filter(function (el) {
    var style = getComputedStyle(el);
    return el.innerText && el.scrollWidth > el.clientWidth + 1 && (style.overflowX === 'hidden' || style.overflowX === 'clip');
  });

  // 4. No text below 12px, outside the house kit's own buttons and uppercase tags.
  var small = all.filter(function (el) {
    return el.children.length === 0 && el.innerText && parseFloat(getComputedStyle(el).fontSize) < 12 && !el.closest(HOUSE_CONTROL + ', svg');
  });

  // 5. A row with no value in it (no figure typed, implied or shown beside the boxes) does not draw a row of empty boxes.
  var emptyRows = Array.prototype.filter.call(root.querySelectorAll('tr'), function (row) {
    var boxes = Array.prototype.filter.call(row.querySelectorAll('input:not([type=checkbox]):not([type=radio])'), visible);
    if (boxes.length < 3 || /\d/.test(row.innerText || '')) return false;
    return boxes.every(function (input) { return !input.value && !/\d/.test(input.placeholder || ''); })
      && boxes.some(function (input) { var s = getComputedStyle(input); return parseFloat(s.borderTopWidth) > 0 && s.borderTopColor !== 'rgba(0, 0, 0, 0)' && s.borderTopColor !== 'transparent'; });
  });

  // 6. A table taller than the window keeps its header in view.
  var lostHeaders = Array.prototype.filter.call(root.querySelectorAll('table'), function (table) {
    var head = table.querySelector('thead th');
    return visible(table) && head && table.getBoundingClientRect().height > window.innerHeight * 0.8 && getComputedStyle(head).position !== 'sticky';
  });

  // 7. The surface's own styles define each selector once.
  var seen = {};
  var duplicates = [];
  Array.prototype.forEach.call(root.querySelectorAll('style'), function (tag) {
    var css = tag.textContent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    (css.match(/[^{}]+(?=\{)/g) || []).forEach(function (head) {
      head.split(',').forEach(function (part) {
        var selector = part.replace(/\s+/g, ' ').trim();
        if (!selector) return;
        if (seen[selector] && duplicates.indexOf(selector) < 0) duplicates.push(selector);
        seen[selector] = true;
      });
    });
  });

  // 8. The page does not scroll sideways.
  var sideways = document.documentElement.scrollWidth > window.innerWidth + 1;

  var tab = (root.querySelector('[role=tab][aria-selected=true]') || {}).innerText || '';
  var key = Object.keys(expect.minBound).filter(function (name) { return tab.toLowerCase().indexOf(name.toLowerCase()) === 0; })[0];
  var need = key ? expect.minBound[key] : 0;
  var line = function (name, pass, found, examples) { return { check: name, pass: pass, found: found, examples: examples || [] }; };
  var lines = [
    // An empty, loading or failed tab has nothing to fail, so it must not pass.
    line('The tab shows data', figures.length > 0, figures.length + ' figures on screen'),
    line('Every figure answers right-click (bound or derived)', unbound.length === 0, unbound.length + ' of ' + figures.length + ' figures do not', sample(unbound)),
    line('Bound values on this tab' + (need ? ' (the view has ' + need + ')' : ''), bound >= need, bound + ' bound, ' + derived + ' derived'),
    line('No value clipped in an input', clipped.length === 0, clipped.length, sample(clipped)),
    line('No text cut off', truncated.length === 0, truncated.length, sample(truncated)),
    line('No text below 12px', small.length === 0, small.length, sample(small)),
    line('No row of empty boxes', emptyRows.length === 0, emptyRows.length, sample(emptyRows)),
    line('Tall tables keep their header', lostHeaders.length === 0, lostHeaders.length),
    line('Each class defined once', duplicates.length === 0, duplicates.length, duplicates.slice(0, 8)),
    line('No sideways page scroll', !sideways, sideways ? 'scrolls' : 'fits'),
  ];
  return { tab: tab.replace(/\s+/g, ' ').trim(), viewport: window.innerWidth + 'x' + window.innerHeight, passed: lines.every(function (l) { return l.pass; }), lines: lines };
})({
  "root": ".ocio, main",
  "minBound": {
    "Mandate Target Manager Refined Host Surface": 4,
    "Region": 0,
    "Structure": 0,
    "Strategy": 53,
    "Pacing": 9,
    "Compliance": 9,
    "Commitments": 6,
    "Overview": 99,
    "Pipeline": 25
  }
});
