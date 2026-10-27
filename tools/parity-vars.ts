// Prints chosen stage variables and list items in the reference and the port at chosen frames, plus each
// side's running threads. Needs tools/ref-server.ts running.
// Usage: npx tsx tools/parity-vars.ts <scenario> <frame,frame,...> "<variable>|<list>#<item>,..."
import fs from 'node:fs';
import path from 'node:path';
import { serverPost } from './lib/ref-client.ts';
import { listsKey } from './lib/lists.ts';
import { canon, createPort, fullState, InputTimeline, type FullState, type Scenario } from './lib/port.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const frames = process.argv[3].split(',').map(Number);
const wanted = process.argv[4].split(',');
const last = Math.max(...frames);
const ref = (await serverPost<{ fulls: Record<number, FullState> }>('/run', { scenario: { ...sc, frames: last }, fullAt: frames, lists: listsKey() })).fulls;
const rt = createPort(sc.seed, 8, sc.username);
rt.greenFlag();
const tl = new InputTimeline(sc.events);
const port: Record<number, FullState> = {};
for (let f = 1; f <= last; f++) {
  rt.stepFrame(tl.inputsFor(f));
  if (frames.includes(f)) port[f] = fullState(rt);
}
const project = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../sb3/project.json'), 'utf8'));
const stage = project.targets.find((t: any) => t.isStage);
const idOf = (name: string, list: boolean) => Object.entries<any>(list ? stage.lists : stage.variables).find(([, v]) => v[0] === name)?.[0];
const read = (s: FullState, w: string) => {
  const hash = w.lastIndexOf('#');
  if (hash > 0) {
    const id = idOf(w.slice(0, hash), true);
    return id === undefined ? '(no list)' : canon(s.targets[0].lists[id]?.[Number(w.slice(hash + 1)) - 1]);
  }
  const id = idOf(w, false);
  return id === undefined ? '(no variable)' : canon(s.targets[0].vars[id]);
};
for (const f of frames) {
  console.log(`=== frame ${f}`);
  for (const w of wanted) {
    const a = read(ref[f], w), b = read(port[f], w);
    console.log(`  ${w}: ref ${a.slice(0, 80)}${a === b ? '' : `  port ${b.slice(0, 80)}  <-- differs`}`);
  }
  const th = (s: FullState) => s.threads.map((t) => `${s.targets[t[0] as number]?.name}:${t[1]}:${t[2]}`).join(' ');
  if (th(ref[f]) !== th(port[f])) console.log(`  threads ref:  ${th(ref[f])}\n  threads port: ${th(port[f])}`);
}
