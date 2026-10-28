// Runs a scenario in the port's page in a headless browser and saves chosen frames as images.
// Usage: npx tsx tools/port-shots.ts <scenario-file> <frame,frame,...> [outdir]
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { ROOT } from './lib/reference.ts';
import { T0, type Scenario } from './lib/port.ts';
import { STAGE_H, STAGE_W } from '../src/engine/defs.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const shotAt = process.argv[3].split(',').map(Number).sort((a, b) => a - b);
const out = path.resolve(process.argv[4] ?? path.join(ROOT, 'out', 'shots', sc.name));
fs.mkdirSync(out, { recursive: true });

const vite = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0 } });
await vite.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: STAGE_W + 40, height: STAGE_H + 40 } });
page.on('pageerror', (e) => console.error('[port pageerror]', e.message));
await page.goto(`${vite.resolvedUrls!.local[0]}test.html`);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 120_000 });
await page.evaluate(([s, t0, w, h]) => (window as any).PORT.init(s, t0, w, h), [sc, T0, STAGE_W, STAGE_H] as const);
const shots: Record<number, string> = await page.evaluate(([n, at]) => (window as any).PORT.run(n, at), [shotAt[shotAt.length - 1], shotAt] as const);
for (const [f, data] of Object.entries(shots)) fs.writeFileSync(path.join(out, `port-${String(f).padStart(5, '0')}.png`), Buffer.from(data.split(',')[1], 'base64'));
console.log(`saved ${Object.keys(shots).length} frames to ${path.relative(ROOT, out)}`);
await browser.close();
await vite.close();
