// Renders the PWA icons from src/web/public/icons/icon.svg. Run once after changing the SVG; the PNGs are committed.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const svg = readFileSync('src/web/public/icons/icon.svg', 'utf8');
const maskable = svg.replace('rx="112"', 'rx="0"').replace('<path', '<g transform="translate(51.2 51.2) scale(0.8)"><path').replace('</svg>', '</g></svg>');
const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
const page = await browser.newPage();
for (const [name, size, source] of [['icon-192', 192, svg], ['icon-512', 512, svg], ['maskable-512', 512, maskable], ['apple-touch-icon', 180, maskable]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${source.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `src/web/public/icons/${name}.png`, omitBackground: true });
}
await browser.close();
