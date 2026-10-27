// Dumps costume metadata, normalized vector sources and touching masks from the reference renderer.
// Writes out/ref-meta.json, out/svg/<md5ext> and src/game/masks.bin.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { openReference, ROOT } from './lib/reference.ts';
import { MASK_FILE } from './lib/silhouettes.ts';
import { encodeMaskSet, packMask, type MaskSet } from '../src/engine/masks.ts';

// Masks only for sprites that test touching and the sprites they test, because the full set is too large.
const TOUCHING = ['Players', 'Stage', 'Border', 'costumes', 'Hitbox Engine', 'FX', 'UI', 'MenuUI'];

const ref = await openReference();
const H = (fn: string, ...args: unknown[]) => ref.page.evaluate(([f, a]) => (window as any).H[f as string](...(a as unknown[])), [fn, args] as const);
const meta = await H('meta');
fs.mkdirSync(path.join(ROOT, 'out', 'svg'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'out', 'ref-meta.json'), JSON.stringify(meta));

let svgs = 0;
for (let start = 0; ; start += 200) {
  const { total, items } = (await H('svgSources', start, 200)) as { total: number; items: { md5ext: string; src: string }[] };
  for (const it of items) {
    const comma = it.src.indexOf(',');
    const body = it.src.slice(0, comma).includes(';base64') ? Buffer.from(it.src.slice(comma + 1), 'base64').toString('utf8') : decodeURIComponent(it.src.slice(comma + 1));
    fs.writeFileSync(path.join(ROOT, 'out', 'svg', it.md5ext), body);
    svgs++;
  }
  if (start + 200 >= total) break;
}

const set: MaskSet = {};
for (const name of TOUCHING) {
  const got = (await H('silhouettes', [name])) as Record<string, { w: number; h: number; bits: string }[]>;
  for (const [sprite, list] of Object.entries(got)) set[sprite] = list.map((m) => packMask(m.w, m.h, new Uint8Array(Buffer.from(m.bits, 'base64'))));
}
fs.writeFileSync(MASK_FILE, zlib.gzipSync(encodeMaskSet(set), { level: 9 }));
console.log('meta targets', (meta as unknown[]).length, 'svg sources', svgs, 'masked sprites', Object.keys(set).length, 'mask file bytes', fs.statSync(MASK_FILE).size);
await ref.close();
