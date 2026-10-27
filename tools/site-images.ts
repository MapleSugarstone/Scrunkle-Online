// Renders the site's favicon, touch icon and link preview image from the game's costumes.
// Usage: npx tsx tools/site-images.ts "<sprite>" "<costume>" [x,y,size] [--art "<sprite>" "<costume>"] [--clear-shadow]
// The icon shows the square at x,y (top-left, in the costume's own pixels) of the given size, or the whole costume.
// The preview shows the whole costume centered on white, or with --art over that costume filling the image under a
// dark vignette. --clear-shadow makes the costume's translucent pure black pixels transparent, which removes a shadow
// painted into it.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { allCostumes, skins } from '../src/game/assets.ts';
import { modules } from '../src/game/generated/index.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public');
const args = process.argv.slice(2);
const artAt = args.indexOf('--art');
const artArgs = artAt >= 0 ? args.splice(artAt, 3).slice(1) : null;
const shadowAt = args.indexOf('--clear-shadow');
const clearShadow = shadowAt >= 0 && args.splice(shadowAt, 1).length > 0;
const [sprite, costumeName, crop] = args;
const usage = 'usage: npx tsx tools/site-images.ts "<sprite>" "<costume>" [x,y,size] [--art "<sprite>" "<costume>"] [--clear-shadow]';
if (!sprite || !costumeName || (artArgs && artArgs.length < 2)) throw new Error(usage);

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

const logo = costume(sprite, costumeName);
const [cx, cy, cs] = crop ? crop.split(',').map(Number) : [0, 0, Math.max(logo.w, logo.h)];

function page(w: number, h: number, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:transparent"><div style="position:relative;width:${w}px;height:${h}px;overflow:hidden">${body}</div></body></html>`;
}

/** An image scaled by `scale` with its center at (x, y). */
function centered(img: { src: string; w: number; h: number }, x: number, y: number, scale: number): string {
  const w = img.w * scale;
  const h = img.h * scale;
  return `<img src="${img.src}" style="position:absolute;left:${x - w / 2}px;top:${y - h / 2}px;width:${w}px;height:${h}px">`;
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
      `<img src="${logo.src}" style="position:absolute;left:${-cx * s}px;top:${-cy * s}px;width:${logo.w * s}px;height:${logo.h * s}px"></div>`,
  );
}

/** The preview logo's visible pixels, in its own pixels, which the preview sizes and centers by. */
let box = { x: 0, y: 0, w: logo.w, h: logo.h };

function preview(): string {
  if (!artArgs) return page(1200, 630, `<div style="position:absolute;inset:0;background:#fff"></div>${centered(logo, 600, 315, Math.min(1100 / logo.w, 590 / logo.h))}`);
  const art = costume(artArgs[0], artArgs[1]);
  const s = Math.min(760 / box.w, 400 / box.h);
  const x = 600 - (box.x + box.w / 2 - logo.w / 2) * s;
  const y = 315 - (box.y + box.h / 2 - logo.h / 2) * s;
  return page(
    1200,
    630,
    centered(art, 600, 315, Math.max(1200 / art.w, 630 / art.h)) +
      '<div style="position:absolute;inset:0;background:radial-gradient(ellipse at center, rgba(22,18,40,0.25), rgba(10,10,18,0.75))"></div>' +
      centered(logo, x, y, s),
  );
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const tab = await browser.newPage();
// The page reads the logo's pixels, to clear its shadow and to find the box of what remains.
const prepared = await tab.evaluate(
  async ({ src, w, h, clear }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const d = data.data;
    let [x0, y0, x1, y1] = [w, h, -1, -1];
    for (let i = 0; i < d.length; i += 4) {
      if (clear && d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0 && d[i + 3] < 255) d[i + 3] = 0;
      if (d[i + 3] < 16) continue;
      const px = (i / 4) % w;
      const py = Math.floor(i / 4 / w);
      [x0, y0, x1, y1] = [Math.min(x0, px), Math.min(y0, py), Math.max(x1, px), Math.max(y1, py)];
    }
    if (!clear) return { src, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
    ctx.putImageData(data, 0, 0);
    return { src: c.toDataURL('image/png'), box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
  },
  { src: logo.src, w: Math.round(logo.w), h: Math.round(logo.h), clear: clearShadow },
);
logo.src = prepared.src;
if (prepared.box.w > 0) box = prepared.box;
const jobs: [string, number, number, string, boolean][] = [
  ['favicon.png', 64, 64, icon(64), true],
  ['apple-touch-icon.png', 180, 180, icon(180), true],
  ['preview.png', 1200, 630, preview(), false],
];
for (const [file, w, h, html, transparent] of jobs) {
  await tab.setViewportSize({ width: w, height: h });
  await tab.setContent(html);
  await tab.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await tab.screenshot({ path: path.join(OUT, file), clip: { x: 0, y: 0, width: w, height: h }, omitBackground: transparent });
  console.log(`wrote public/${file} (${w}x${h})`);
}
await browser.close();
