// Renders the same scenario frames in the reference and in the port and writes a side-by-side
// report with per-frame pixel differences.
// Usage: npx tsx tools/visual.ts <scenario-file> <frame,frame,...> [width] [height]
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { openReference, ROOT } from './lib/reference.ts';
import { T0, type Scenario } from './lib/port.ts';
import { STAGE_H, STAGE_W } from '../src/engine/defs.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const shotAt = process.argv[3].split(',').map(Number).sort((a, b) => a - b);
const width = Number(process.argv[4] ?? STAGE_W);
const height = Number(process.argv[5] ?? STAGE_H);
const outDir = path.join(ROOT, 'out', 'visual', `${sc.name}-${width}x${height}`);
fs.mkdirSync(outDir, { recursive: true });
const frames = shotAt[shotAt.length - 1];

// Port side.
const vite = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0 } });
await vite.listen();
const portUrl = vite.resolvedUrls!.local[0];
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: width + 40, height: height + 40 } });
page.on('pageerror', (e) => console.error('[port pageerror]', e.message));
await page.goto(`${portUrl}test.html`);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 120_000 });
await page.evaluate(([s, t0, w, h]) => (window as any).PORT.init(s, t0, w, h), [sc, T0, width, height] as const);
const portShots: Record<number, string> = await page.evaluate(([n, at]) => (window as any).PORT.run(n, at), [frames, shotAt] as const);

// Reference side.
const ref = await openReference();
await ref.page.evaluate(([w, h]) => (window as any).H.resize(w, h), [width, height] as const);
await ref.page.evaluate((s) => (window as any).H.start({ seed: s.seed, username: s.username ?? '' }), { seed: sc.seed, username: sc.username });
const byFrame: Record<number, unknown[]> = {};
for (const e of sc.events) (byFrame[e.f] ??= []).push(e);
const refRes = await ref.page.evaluate(([n, e, s]) => (window as any).H.run(n, e, { shotAt: s }), [frames, byFrame, shotAt] as const);
const refShots: Record<number, string> = refRes.shots;

// Pixel differences, computed in the page with canvases.
const rows: string[] = [];
const summary: string[] = [];
for (const f of shotAt) {
  const r = refShots[f];
  const p = portShots[f];
  const stats: { mean: number; over: number; diff: string } = await page.evaluate(([a, b]) => (window as any).PORT.diff(a, b), [r, p] as const);
  const save = (name: string, data: string) => fs.writeFileSync(path.join(outDir, name), Buffer.from(data.split(',')[1], 'base64'));
  save(`f${f}-ref.png`, r);
  save(`f${f}-port.png`, p);
  save(`f${f}-diff.png`, stats.diff);
  const line = `frame ${f}: mean diff ${stats.mean.toFixed(3)}, pixels off by >24: ${(stats.over * 100).toFixed(3)}%`;
  summary.push(line);
  rows.push(`<tr><td>${f}<br>${stats.mean.toFixed(3)}<br>${(stats.over * 100).toFixed(3)}%</td><td><img src="f${f}-ref.png"></td><td><img src="f${f}-port.png"></td><td><img src="f${f}-diff.png"></td></tr>`);
}
fs.writeFileSync(
  path.join(outDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Visual comparison</title>
<style>body{background:#111;color:#ddd;font:13px system-ui}img{width:${Math.min(width, STAGE_W)}px;image-rendering:pixelated}td{vertical-align:top;padding:4px}</style>
<h1>${sc.name} at ${width}x${height}</h1><table><tr><th>frame / mean / over</th><th>reference</th><th>port</th><th>difference</th></tr>${rows.join('')}</table>`,
);
console.log(summary.join('\n'));
console.log(`report: ${path.join(outDir, 'index.html')}`);
await ref.close();
await browser.close();
await vite.close();
