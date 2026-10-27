// Renders the site's favicon, touch icon and link preview image from one of the game's costumes.
// Usage: npx tsx tools/site-images.ts "<sprite>" "<costume>" [x,y,size]
// The icon shows the square at x,y (top-left, in the costume's own pixels) of the given size, or the whole costume.
// The preview shows the whole costume centered on white.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { allCostumes, skins } from '../src/game/assets.ts';
import { modules } from '../src/game/generated/index.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public');
const [sprite, costumeName, crop] = process.argv.slice(2);
if (!sprite || !costumeName) throw new Error('usage: npx tsx tools/site-images.ts "<sprite>" "<costume>" [x,y,size]');

/** A costume as a data URL with its size in image pixels, with shared fonts put back into vector images. */
function costume(spriteName: string, name: string): { src: string; w: number; h: number } {
  const ti = modules.findIndex((m) => m.def.name === spriteName);
  const c = allCostumes[ti]?.find((x) => x.name === name);
  if (!c) throw new Error(`missing costume ${spriteName}/${name}`);
  const skin = skins[c.skin];
  const file = path.join(OUT, 'assets', skin.file);
  if (skin.kind === 'svg') {
    const svg = fs.readFileSync(file, 'utf8').replace(/cbfont:([0-9a-f]+)/g, (_m, id: string) => fs.readFileSync(path.join(OUT, 'assets/fonts', `${id}.txt`), 'utf8'));
    return { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, w: skin.w, h: skin.h };
  }
  const png = fs.readFileSync(file);
  return { src: `data:image/png;base64,${png.toString('base64')}`, w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

const art = costume(sprite, costumeName);
const [cx, cy, cs] = crop ? crop.split(',').map(Number) : [0, 0, Math.max(art.w, art.h)];

function page(w: number, h: number, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:transparent"><div style="position:relative;width:${w}px;height:${h}px;overflow:hidden">${body}</div></body></html>`;
}

/** The crop on a white rounded square, so dark outlines show on dark tab bars. */
function icon(size: number): string {
  const inner = size * 0.9;
  const s = inner / cs;
  const pad = (size - inner) / 2;
  return page(
    size,
    size,
    `<div style="position:absolute;inset:0;background:#fff;border-radius:${size * 0.18}px"></div>` +
      `<div style="position:absolute;left:${pad}px;top:${pad}px;width:${inner}px;height:${inner}px;overflow:hidden">` +
      `<img src="${art.src}" style="position:absolute;left:${-cx * s}px;top:${-cy * s}px;width:${art.w * s}px;height:${art.h * s}px"></div>`,
  );
}

const scale = Math.min(1100 / art.w, 590 / art.h);
const preview = page(
  1200,
  630,
  `<div style="position:absolute;inset:0;background:#fff"></div>` +
    `<img src="${art.src}" style="position:absolute;left:${(1200 - art.w * scale) / 2}px;top:${(630 - art.h * scale) / 2}px;width:${art.w * scale}px;height:${art.h * scale}px">`,
);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const tab = await browser.newPage();
const jobs: [string, number, number, string, boolean][] = [
  ['favicon.png', 64, 64, icon(64), true],
  ['apple-touch-icon.png', 180, 180, icon(180), true],
  ['preview.png', 1200, 630, preview, false],
];
for (const [file, w, h, html, transparent] of jobs) {
  await tab.setViewportSize({ width: w, height: h });
  await tab.setContent(html);
  await tab.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await tab.screenshot({ path: path.join(OUT, file), clip: { x: 0, y: 0, width: w, height: h }, omitBackground: transparent });
  console.log(`wrote public/${file} (${w}x${h})`);
}
await browser.close();
