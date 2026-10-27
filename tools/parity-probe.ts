// Lists every custom block call with its arguments during one frame, in the reference and the port, and prints the
// first call that differs. It finds the block that computes differently inside a long warp procedure.
// Transpile with PROBE=1 first (PROBE=1 npm run transpile), and have tools/ref-server.ts running.
// Usage: npx tsx tools/parity-probe.ts <scenario> <frame>
import fs from 'node:fs';
import path from 'node:path';
import { serverPost, SERVER } from './lib/ref-client.ts';
import { listsKey } from './lib/lists.ts';
import { canon, createPort, InputTimeline, type Scenario } from './lib/port.ts';
import type { Value } from '../src/engine/cast.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const frame = Number(process.argv[3]);
const evalRef = async (code: string) => (await fetch(`${SERVER}/eval`, { method: 'POST', body: code })).text();

await evalRef(`H.probe = { frame: ${frame}, log: [] }; 1`);
await serverPost('/run', { scenario: { ...sc, frames: frame }, fullAt: [], lists: listsKey() });
// canon() keeps the types apart, which the comparison needs, so the page formats each call with the same rules.
const refCalls = JSON.parse(
  await evalRef(`H.probe.log.map(([p, a]) => p + ' ' + JSON.stringify(a.map((v) => typeof v === 'number' ? (Object.is(v, -0) ? 'n-0' : 'n' + v) : typeof v === 'string' ? 's' + JSON.stringify(v) : typeof v === 'boolean' ? (v ? 'bT' : 'bF') : v === undefined ? 'u' : 'o' + JSON.stringify(v))))`),
) as string[];
await evalRef('H.probe = null; 1');

const rt = createPort(sc.seed, 8, sc.username);
rt.logPen = false;
rt.greenFlag();
const portCalls: string[] = [];
rt.probe = (p: string, args: Value[]) => {
  if (rt.frame === frame) portCalls.push(`${p} ${JSON.stringify(args.map((v) => canon(v)))}`);
};
const tl = new InputTimeline(sc.events);
for (let f = 1; f <= frame; f++) rt.stepFrame(tl.inputsFor(f));

console.log(`ref ${refCalls.length} calls, port ${portCalls.length} calls`);
if (portCalls.length === 0) console.log('The port logged nothing. Transpile with PROBE=1.');
for (let i = 0; i < Math.max(refCalls.length, portCalls.length); i++) {
  if (refCalls[i] === portCalls[i]) continue;
  for (let j = Math.max(0, i - 4); j < Math.min(i + 3, Math.max(refCalls.length, portCalls.length)); j++) {
    const same = refCalls[j] === portCalls[j];
    console.log(`${String(j).padStart(5)} ${same ? '    ' : 'DIFF'} ref  ${refCalls[j]?.slice(0, 260)}`);
    if (!same) console.log(`${' '.repeat(10)} port ${portCalls[j]?.slice(0, 260)}`);
  }
  break;
}
