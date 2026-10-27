// Times how long the built site takes from opening until Play is enabled, with an empty cache, in headless Edge.
// Run `npm run build` first. Usage: npx tsx tools/load-time.ts [runs]
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startStaticServer } from './lib/static-server.ts';
import { ROOT } from './lib/reference.ts';

const runs = Number(process.argv[2] ?? 1);
const server = await startStaticServer(path.join(ROOT, 'dist'));
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
for (let i = 0; i < runs; i++) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  // The browser keeps 250 resource timings unless told otherwise, and the game loads thousands of files.
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(20_000);
    // Adds up the time the renderer spends making each image's textures, from the moment the page creates it.
    const w = window as unknown as { __game?: { renderer: Record<string, unknown> }; __prepMs: number };
    w.__prepMs = 0;
    const hook = setInterval(() => {
      const r = w.__game?.renderer as { prepare?: (i: number) => void } | undefined;
      if (!r?.prepare) return;
      clearInterval(hook);
      const prepare = r.prepare.bind(r);
      r.prepare = (i: number) => {
        const s = performance.now();
        prepare(i);
        w.__prepMs += performance.now() - s;
      };
    }, 0);
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(`${server.url}/index.html`);
  await page.waitForFunction(() => [...document.querySelectorAll('.lobby-menu button')].some((b) => b.textContent === 'Play offline' && !(b as HTMLButtonElement).disabled), null, { timeout: 600_000, polling: 200 });
  const ms = Date.now() - t0;
  const progress = await page.evaluate(() => document.querySelector('.lobby-progress')?.textContent ?? '');
  // When the last image arrived, which separates network time from decoding and uploading.
  const images = await page.evaluate(() => {
    const list = performance.getEntriesByType('resource').filter((e) => e.name.includes('/assets/costumes/'));
    return { count: list.length, lastEnd: Math.max(...list.map((e) => (e as PerformanceResourceTiming).responseEnd)) };
  });
  const prepMs = await page.evaluate(() => (window as unknown as { __prepMs: number }).__prepMs);
  console.log(`run ${i + 1}: Play enabled after ${(ms / 1000).toFixed(1)} s, ${(prepMs / 1000).toFixed(1)} s of it making textures, the last of ${images.count} images arrived at ${(images.lastEnd / 1000).toFixed(1)} s${progress ? ` (${progress} still loading)` : ''}${errors.length ? `, errors: ${errors.join('; ')}` : ''}`);
  await context.close();
}
await browser.close();
server.close();
