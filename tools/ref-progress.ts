// Runs a scenario on a freshly loaded reference a few frames at a time and logs how long each chunk takes,
// to find where the original is slow or stuck. Progress goes to out/logs/ref-progress.txt.
// Creating out/logs/ref-progress.stop ends the run after the current chunk.
// Usage: npx tsx tools/ref-progress.ts <scenario-file> [chunk frames] [stage variable]
import fs from 'node:fs';
import path from 'node:path';
import { openReference, ROOT } from './lib/reference.ts';
import type { Scenario } from './lib/port.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const chunk = Number(process.argv[3] ?? 10);
const watch = process.argv[4] ?? 'scene';
const logDir = path.join(ROOT, 'out', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'ref-progress.txt');
const stopFile = path.join(logDir, 'ref-progress.stop');
fs.rmSync(stopFile, { force: true });
const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  console.log(s);
  fs.writeFileSync(logFile, `${lines.join('\n')}\n`);
};

const t0 = Date.now();
const ref = await openReference();
log(`loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${sc.frames} frames in chunks of ${chunk}`);
await ref.page.evaluate((s) => (window as any).H.start({ seed: s.seed, username: s.username ?? '' }), { seed: sc.seed, username: sc.username });
const byFrame: Record<number, unknown[]> = {};
for (const e of sc.events) (byFrame[e.f] ??= []).push(e);
const started = Date.now();
for (let done = 0; done < sc.frames; done += chunk) {
  if (fs.existsSync(stopFile)) {
    log(`stopped at frame ${done} (partial)`);
    break;
  }
  const n = Math.min(chunk, sc.frames - done);
  const ev: Record<number, unknown[]> = {};
  for (let f = done + 1; f <= done + n; f++) if (byFrame[f]) ev[f] = byFrame[f];
  const c0 = Date.now();
  await ref.page.evaluate(([n2, e]) => (window as any).H.run(n2, e, {}), [n, ev] as const);
  const value = await ref.page.evaluate((name) => {
    const v = Object.values((window as any).H.vm.runtime.getTargetForStage().variables).find((x: any) => x.name === name) as any;
    return v ? String(v.value).slice(0, 60) : '(none)';
  }, watch);
  const elapsed = (Date.now() - started) / 1000;
  const rate = (done + n) / elapsed;
  log(`frames ${done + 1}-${done + n}: ${((Date.now() - c0) / 1000).toFixed(1)} s, ${watch}=${value}, elapsed ${elapsed.toFixed(0)} s, about ${((sc.frames - done - n) / rate).toFixed(0)} s left`);
}
await ref.close();
