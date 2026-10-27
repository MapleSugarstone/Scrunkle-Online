// Times the port on a scenario: milliseconds per frame overall, during play (inPlay in src/game/screens.ts), and the slowest frames.
// Usage: npx tsx tools/perf.ts <scenario-file>   (add --cpu-prof through NODE_OPTIONS to profile)
import fs from 'node:fs';
import path from 'node:path';
import { createPort, InputTimeline, type Scenario } from './lib/port.ts';
import { inPlay } from '../src/game/screens.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const rt = createPort(sc.seed);
rt.logPen = false;
rt.greenFlag();
const tl = new InputTimeline(sc.events);
const times: { f: number; ms: number; match: boolean }[] = [];
const t0 = performance.now();
for (let f = 1; f <= sc.frames; f++) {
  const s = performance.now();
  rt.stepFrame(tl.inputsFor(f));
  times.push({ f, ms: performance.now() - s, match: inPlay(rt) });
}
const total = performance.now() - t0;
const pct = (list: number[], p: number) => (list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))] : 0);
const all = times.map((t) => t.ms);
const match = times.filter((t) => t.match).map((t) => t.ms);
const slowest = [...times].sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log(`${sc.name}: ${sc.frames} frames in ${total.toFixed(0)} ms, ${(total / sc.frames).toFixed(2)} ms per frame, 99th ${pct(all, 0.99).toFixed(1)} ms`);
console.log(`  matches: ${match.length} frames, median ${pct(match, 0.5).toFixed(2)} ms, 90th ${pct(match, 0.9).toFixed(2)} ms, 99th ${pct(match, 0.99).toFixed(2)} ms`);
console.log(`  slowest: ${slowest.map((t) => `${t.ms.toFixed(1)} ms at ${t.f}${t.match ? ' (match)' : ''}`).join(', ')}`);
