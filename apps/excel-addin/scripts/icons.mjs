#!/usr/bin/env node
/**
 * Draws the add-in's ribbon and store icons as PNGs in assets/.
 * Run it again only when the artwork changes: `npm run icons -w @tapestrai/excel-addin`.
 * Uses the Chromium that Playwright provides.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'assets');
mkdirSync(out, { recursive: true });

// A blue tile with a white T over three grid rows: a record's attributes, read into a cell.
const tap = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="2" y="2" width="60" height="60" rx="12" fill="#1f6fd1"/>
  <rect x="12" y="13" width="40" height="9" rx="2.5" fill="#ffffff"/>
  <rect x="27.5" y="13" width="9" height="38" rx="2.5" fill="#ffffff"/>
  <rect x="12" y="29" width="11" height="6" rx="1.5" fill="#9cc4f5"/>
  <rect x="41" y="29" width="11" height="6" rx="1.5" fill="#9cc4f5"/>
  <rect x="12" y="41" width="11" height="6" rx="1.5" fill="#9cc4f5"/>
  <rect x="41" y="41" width="11" height="6" rx="1.5" fill="#9cc4f5"/>
</svg>`;

// A circular arrow for Refresh TAP.
const refresh = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="M50 32a18 18 0 1 1-5.3-12.7" fill="none" stroke="#1f6fd1" stroke-width="7" stroke-linecap="round"/>
  <path d="M49 8v15H34" fill="none" stroke="#1f6fd1" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const icons = [
  ['icon', tap, [16, 32, 64, 80, 128]],
  ['refresh', refresh, [16, 32, 80]],
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [name, svg, sizes] of icons) {
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    writeFileSync(join(out, `${name}-${size}.png`), png);
  }
}
await browser.close();
console.log(`Icons written to ${out}`);
