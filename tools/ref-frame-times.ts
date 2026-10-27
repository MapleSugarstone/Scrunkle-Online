// Times every frame of a scenario in the original runtime and reports the slowest frames, to see what a script costs.
// Usage: npx tsx tools/ref-frame-times.ts <scenario.json> [project.sb3] [--out=times.txt]   (--out writes one time per frame)
import fs from 'node:fs';
import path from 'node:path';
import { openReference } from './lib/reference.ts';
import type { Scenario } from './lib/port.ts';

const sc = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8')) as Scenario;
const project = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined;
const ref = await openReference(project ? { sb3: path.resolve(project) } : {});
try {
  const ev: Record<number, unknown[]> = {};
  for (const e of sc.events) (ev[e.f] ??= []).push(e);
  await ref.page.evaluate((s) => (window as any).H.start({ seed: s.seed, username: s.username ?? '' }), { seed: sc.seed, username: sc.username });
  const times: number[] = [];
  for (let done = 0; done < sc.frames; done += 300) {
    const n = Math.min(300, sc.frames - done);
    times.push(...await ref.page.evaluate(async ([n2, e]) => {
      const H = (window as any).H;
      const out: number[] = [];
      for (let i = 0; i < n2; i++) {
        const t0 = performance.now();
        await H.step(e[H.frame + 1]);
        out.push(performance.now() - t0);
      }
      return out;
    }, [n, ev] as const));
  }
  const sorted = times.map((t, i) => [t, i + 1] as const).sort((a, b) => b[0] - a[0]);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`${sc.name}: ${times.length} frames, mean ${mean.toFixed(1)} ms, median ${[...times].sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(1)} ms`);
  console.log(`slowest frames: ${sorted.slice(0, 15).map(([t, f]) => `${f}:${t.toFixed(0)}ms`).join(' ')}`);
  const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
  if (out) fs.writeFileSync(out, times.join('\n'));
} finally {
  await ref.close();
}
