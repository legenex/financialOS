#!/usr/bin/env node
// Generates the PNG/ICO identity assets in packages/ui/assets from the SVG sources, using Playwright Chromium
// screenshots (no image libraries). Re-run after changing an SVG:
//   PLAYWRIGHT_BROWSERS_PATH=$PWD/.tools/ms-playwright node packages/ui/scripts/generate-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, '../assets');
const read = (name) => readFileSync(path.join(assets, name), 'utf8');

const mark = read('logo-mark.svg');
const favicon = read('favicon.svg');
const maskable = read('icon-maskable.svg');
// Apple touch icons are shown full-bleed and rounded by the OS: reuse the maskable art (square, safe-zoned).
const jobs = [
  ...[16, 32, 48].map((size) => ({ svg: favicon, size, file: `icon-${size}.png` })),
  ...[128, 192, 512].map((size) => ({ svg: mark, size, file: `icon-${size}.png` })),
  { svg: maskable, size: 512, file: 'icon-maskable-512.png' },
  { svg: maskable, size: 192, file: 'icon-maskable-192.png' },
  { svg: maskable, size: 180, file: 'apple-touch-icon.png' },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const pngs = new Map();
for (const job of jobs) {
  await page.setViewportSize({ width: job.size, height: job.size });
  const sized = job.svg.replace(/width="\d+" height="\d+"/, `width="${job.size}" height="${job.size}"`);
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${sized}</body></html>`,
  );
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: job.size, height: job.size } });
  writeFileSync(path.join(assets, job.file), buf);
  pngs.set(job.file, buf);
  process.stdout.write(`wrote ${job.file}\n`);
}
await browser.close();

// favicon.ico with embedded PNG images (supported by all current browsers).
const entries = [16, 32, 48].map((size) => ({ size, data: pngs.get(`icon-${size}.png`) }));
const header = Buffer.alloc(6 + entries.length * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach((e, i) => {
  const base = 6 + i * 16;
  header.writeUInt8(e.size >= 256 ? 0 : e.size, base);
  header.writeUInt8(e.size >= 256 ? 0 : e.size, base + 1);
  header.writeUInt8(0, base + 2);
  header.writeUInt8(0, base + 3);
  header.writeUInt16LE(1, base + 4);
  header.writeUInt16LE(32, base + 6);
  header.writeUInt32LE(e.data.length, base + 8);
  header.writeUInt32LE(offset, base + 12);
  offset += e.data.length;
});
writeFileSync(path.join(assets, 'favicon.ico'), Buffer.concat([header, ...entries.map((e) => e.data)]));
process.stdout.write('wrote favicon.ico\n');

// Web manifest template for any surface that serves these assets from /icons/.
const manifest = {
  name: 'FinancialOS',
  short_name: 'FinancialOS',
  description: 'Private personal and business finance command centre.',
  start_url: '/today',
  scope: '/',
  display: 'standalone',
  background_color: '#f7f7f5',
  theme_color: '#0e6b62',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
writeFileSync(path.join(assets, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write('wrote manifest.webmanifest\n');
