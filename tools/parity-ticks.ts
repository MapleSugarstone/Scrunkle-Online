// Compares the order of thread steps in the reference and the port over a frame range, tick by tick, and prints
// the first step where they differ. Finds scheduling differences that leave the end-of-frame state equal.
// Needs tools/ref-server.ts running. Usage: npx tsx tools/parity-ticks.ts <scenario> <from frame> <to frame>
import fs from 'node:fs';
import path from 'node:path';
import { serverPost, SERVER } from './lib/ref-client.ts';
import { listsKey } from './lib/lists.ts';
import { createPort, InputTimeline, type Scenario } from './lib/port.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const from = Number(process.argv[3]);
const to = Number(process.argv[4]);
const evalRef = async (code: string) => (await fetch(`${SERVER}/eval`, { method: 'POST', body: code })).text();
await evalRef(`H.trace = { from: ${from}, to: ${to}, log: [] }; 1`);
await serverPost('/run', { scenario: { ...sc, frames: to }, fullAt: [], lists: listsKey() });
// The original marks a thread that yielded as running again before its step returns.
const ref = (JSON.parse(await evalRef('H.trace.log')) as unknown[][]).map((e) => (e[4] === 2 ? [...e.slice(0, 4), 0] : e));
await evalRef('H.trace = null; 1');

const rt = createPort(sc.seed, 8, sc.username);
rt.logPen = false;
rt.greenFlag();
rt.trace = { from, to, log: [] };
const tl = new InputTimeline(sc.events);
for (let f = 1; f <= to; f++) rt.stepFrame(tl.inputsFor(f));
const port = rt.trace.log;

const n = Math.max(ref.length, port.length);
let first = -1;
for (let i = 0; i < n; i++) if (JSON.stringify(ref[i]) !== JSON.stringify(port[i])) { first = i; break; }
console.log(`ref ${ref.length} steps, port ${port.length} steps, first difference at step ${first}`);
if (first >= 0) for (let i = Math.max(0, first - 8); i < Math.min(n, first + 10); i++) {
  const a = JSON.stringify(ref[i]), b = JSON.stringify(port[i]);
  console.log(`${String(i).padStart(6)} ${a === b ? '    ' : 'DIFF'} ref ${a}${a === b ? '' : `\n                port ${b}`}`);
}
