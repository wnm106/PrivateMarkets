#!/usr/bin/env node
/**
 * Builds the Excel add-in into the web app's public folder, so the web app serves
 * it at <origin>/excel/addin/ beside /api/graphql and the /excel/connect sign-in page.
 *
 *   node scripts/build.mjs            build once
 *   node scripts/build.mjs --watch    rebuild on change
 *
 * Environment:
 *   EXCEL_ADDIN_ORIGIN   the web app's origin the manifest points at.
 *                        Falls back to NEXT_PUBLIC_APP_URL, then https://localhost:3000.
 *   EXCEL_ADDIN_ID       the manifest's GUID. Give each environment its own so
 *                        staging and production can be installed side by side.
 *   EXCEL_ADDIN_NAME     the name shown in Excel (default "Tapestry").
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outdir = join(root, '..', 'web', 'public', 'excel', 'addin');
const watch = process.argv.includes('--watch');

/** The production add-in's id. Change it only to make Excel treat this as a different add-in. */
const DEFAULT_ADDIN_ID = '6e5d1e64-315a-483f-af6e-7a464e70d5dd';

function originFromEnv() {
  const raw = (process.env.EXCEL_ADDIN_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || 'https://localhost:3000').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`EXCEL_ADDIN_ORIGIN is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:') {
    console.warn(`excel-addin: ${url.origin} is not https. Excel loads add-ins only over https.`);
  }
  return url.origin;
}

function xml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const origin = originFromEnv();
const addinId = (process.env.EXCEL_ADDIN_ID || DEFAULT_ADDIN_ID).trim();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(addinId)) {
  throw new Error(`EXCEL_ADDIN_ID must be a GUID: ${addinId}`);
}
const displayName = (process.env.EXCEL_ADDIN_NAME || 'Tapestry').trim().slice(0, 125);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = `${pkg.version}.0`.split('.').slice(0, 4).join('.');

function writeStatic(buildId) {
  mkdirSync(join(outdir, 'assets'), { recursive: true });
  const fill = (text) => text
    .replaceAll('__BUILD__', buildId)
    .replaceAll('__ORIGIN__', origin)
    .replaceAll('__ADDIN_ID__', addinId)
    .replaceAll('__VERSION__', version)
    .replaceAll('__DISPLAY_NAME__', xml(displayName));
  for (const file of ['taskpane.html', 'help.html', 'taskpane.css', 'functions.json']) {
    writeFileSync(join(outdir, file), fill(readFileSync(join(root, 'static', file), 'utf8')));
  }
  writeFileSync(join(outdir, 'manifest.xml'), fill(readFileSync(join(root, 'static', 'manifest.template.xml'), 'utf8')));
  for (const icon of readdirSync(join(root, 'assets'))) {
    if (icon.endsWith('.png')) copyFileSync(join(root, 'assets', icon), join(outdir, 'assets', icon));
  }
}

const options = {
  entryPoints: [join(root, 'src', 'taskpane.ts')],
  outfile: join(outdir, 'taskpane.js'),
  bundle: true,
  format: 'iife',
  // Excel's web views: Edge WebView2 on Windows, WKWebView on Mac, the browser on the web.
  target: ['es2019'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
};

rmSync(outdir, { recursive: true, force: true });
const buildId = Date.now().toString(36);
writeStatic(buildId);

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log(`excel-addin: watching. Serving from ${origin}/excel/addin/`);
} else {
  await esbuild.build(options);
  console.log(`excel-addin: built for ${origin}. Manifest: ${origin}/excel/addin/manifest.xml`);
}
