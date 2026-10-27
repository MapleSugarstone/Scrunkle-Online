// Prints every piece of one target's digest that differs between the reference and the port at one frame.
// Usage: npx tsx tools/parity-pieces.ts <scenario-file|idle> <frame> <target index>
// Needs tools/ref-server.ts running.
import fs from 'node:fs';
import path from 'node:path';
import { serverPost } from './lib/ref-client.ts';
import { listsKey } from './lib/lists.ts';
import { canon, createPort, fullState, InputTimeline, type FullState, type Scenario } from './lib/port.ts';

const arg = process.argv[2];
const frame = Number(process.argv[3]);
const ti = Number(process.argv[4] ?? 0);
const sc: Scenario = arg === 'idle' ? { name: 'idle', seed: 1, frames: frame, events: [] } : JSON.parse(fs.readFileSync(path.resolve(arg), 'utf8'));
sc.frames = frame;

const ref = (await serverPost<{ fulls: Record<number, FullState> }>('/run', { scenario: sc, fullAt: [frame], lists: listsKey() })).fulls[frame];
const rt = createPort(sc.seed, 8, sc.username);
rt.greenFlag();
const tl = new InputTimeline(sc.events);
for (let f = 1; f <= frame; f++) rt.stepFrame(tl.inputsFor(f));
const port = fullState(rt);

const a = ref.targets[ti];
const b = port.targets[ti];
console.log(`frame ${frame} target #${ti}: ref ${a.name} port ${b.name}`);
for (const k of ['name', 'orig', 'x', 'y', 'dir', 'size', 'costume', 'vis', 'rot', 'vol', 'fx', 'layer', 'pen', 'snd'] as const) {
  if (canon(a[k]) !== canon(b[k])) console.log(`  ${k}: ref ${canon(a[k])} port ${canon(b[k])}`);
}
const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
const ka = keys(a.vars), kb = keys(b.vars);
if (ka.join('|') !== kb.join('|')) console.log(`  var ids differ: only ref [${ka.filter((k) => !kb.includes(k)).join(', ')}] only port [${kb.filter((k) => !ka.includes(k)).join(', ')}]`);
for (const k of ka) if (canon(a.vars[k]) !== canon(b.vars[k])) console.log(`  var ${k}: ref ${canon(a.vars[k]).slice(0, 200)} port ${canon(b.vars[k]).slice(0, 200)}`);
const la = keys(a.lists), lb = keys(b.lists);
if (la.join('|') !== lb.join('|')) console.log(`  list ids differ: only ref [${la.filter((k) => !lb.includes(k)).join(', ')}] only port [${lb.filter((k) => !la.includes(k)).join(', ')}]`);
for (const k of la) {
  const x = a.lists[k] ?? [], y = b.lists[k] ?? [];
  if (canon(x) === canon(y)) continue;
  const i = x.findIndex((v, j) => canon(v) !== canon(y[j]));
  console.log(`  list ${k}: lengths ${x.length}/${y.length}, first difference at item ${i + 1}: ref ${canon(x[i])} port ${canon(y[i])}`);
}
