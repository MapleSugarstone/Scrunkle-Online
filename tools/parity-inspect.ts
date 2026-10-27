// Prints the full state of chosen targets in the reference (via tools/ref-server.ts) and the port at chosen frames.
// Usage: npx tsx tools/parity-inspect.ts <scenario> <frames: 1749,1750> [target name filter]
import fs from 'node:fs';
import path from 'node:path';
import { createPort, fullState, InputTimeline, type FullState, type Scenario } from './lib/port.ts';
import { serverPost } from './lib/ref-client.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const frames = process.argv[3].split(',').map(Number);
const filter = process.argv[4];
const last = Math.max(...frames);

const ref = (await serverPost<{ fulls: Record<number, FullState> }>('/run', { scenario: { ...sc, frames: last }, fullAt: frames })).fulls;

const rt = createPort(sc.seed, 8, sc.username);
rt.greenFlag();
const tl = new InputTimeline(sc.events);
const port: Record<number, FullState> = {};
for (let f = 1; f <= last; f++) {
  rt.stepFrame(tl.inputsFor(f));
  if (frames.includes(f)) port[f] = fullState(rt);
}

const brief = (s: FullState, i: number) => {
  const t = s.targets[i];
  return JSON.stringify({ x: t.x, y: t.y, costume: t.costume, vis: t.vis, size: t.size, dir: t.dir, layer: t.layer, fx: t.fx, snd: t.snd, vars: t.vars });
};
for (const f of frames) {
  console.log(`=== frame ${f}  ticks ref ${ref[f].ticks} port ${port[f].ticks}`);
  ref[f].targets.forEach((t, i) => {
    if (filter && !t.name.includes(filter)) return;
    const a = brief(ref[f], i), b = port[f].targets[i] ? brief(port[f], i) : '(none)';
    console.log(`#${i} ${t.name}${t.orig ? '' : ' (clone)'} ${a === b ? 'same' : 'DIFF'}\n  ref  ${a}${a === b ? '' : `\n  port ${b}`}`);
  });
  const th = (s: FullState) => s.threads.filter((x) => !filter || s.targets[x[0] as number]?.name.includes(filter)).map((x) => x.slice(0, 4).join(':')).join(' ');
  console.log(`  threads ref : ${th(ref[f])}\n  threads port: ${th(port[f])}`);
}
