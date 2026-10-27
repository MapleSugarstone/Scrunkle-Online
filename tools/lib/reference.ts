import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startStaticServer } from './static-server.ts';
import { hasOverrides, PATCHED_SB3, SOURCE_SB3, writePatchedProject } from './lists.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');

/** The project the reference runs: the source project, or with lists edited in data/lists, a copy that has them. */
export async function referenceProject(): Promise<string> {
  return hasOverrides() ? writePatchedProject() : SOURCE_SB3;
}

/** The project the reference would run, without writing anything, for cache keys. */
export function referenceProjectPath(): string {
  return hasOverrides() ? PATCHED_SB3 : SOURCE_SB3;
}

export interface RefSession {
  page: Page;
  browser: Browser;
  close: () => Promise<void>;
}

/** Opens the reference runner in a headless browser and waits until the project, or `opts.sb3`, is loaded. */
export async function openReference(opts: { headless?: boolean; sb3?: string } = {}): Promise<RefSession> {
  const server = await startStaticServer(ROOT);
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: opts.headless ?? true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  // The compiled date blocks read local time, so the page runs in UTC, where local time is the simulated clock.
  const page = await browser.newPage({ viewport: { width: 980, height: 760 }, timezoneId: 'UTC' });
  page.on('pageerror', (e) => console.error('[ref pageerror]', e.message));
  page.on('console', (m) => {
    const text = m.text();
    if (/Translation for|willReadFrequently/.test(text)) return;
    if (m.type() === 'error' || m.type() === 'warning') console.error(`[ref ${m.type()}]`, text.slice(0, 300));
  });
  const sb3 = path.relative(ROOT, opts.sb3 ?? await referenceProject()).replace(/\\/g, '/');
  await page.goto(`${server.url}/reference/index.html?p=/${encodeURI(sb3)}`);
  await page.waitForFunction(() => (window as any).H?.ready || (window as any).H?.error, null, { timeout: 1_200_000, polling: 500 });
  const err = await page.evaluate(() => (window as any).H.error);
  if (err) throw new Error(`reference failed to load: ${err}`);
  return {
    page,
    browser,
    close: async () => {
      await browser.close();
      server.close();
    },
  };
}
