// Finds the first thread step within one frame after which the reference and the port hold different state, and
// prints both sides' differences after that step. Use it when a frame's end state differs but its thread order agrees.
// Needs tools/ref-server.ts running. Usage: npx tsx tools/parity-steps.ts <scenario> <frame>
import fs from 'node:fs';
import path from 'node:path';
import { serverPost, SERVER } from './lib/ref-client.ts';
import { listsKey } from './lib/lists.ts';
import { canon, createPort, digest, fullState, InputTimeline, type FullState, type Scenario } from './lib/port.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const frame = Number(process.argv[3]);
const evalRef = async (code: string) => (await fetch(`${SERVER}/eval`, { method: 'POST', body: code })).text();

async function refTrace(fullAtStep: number): Promise<{ log: unknown[][]; full: FullState | null }> {
  await evalRef(`H.trace = { from: ${frame}, to: ${frame}, log: [], states: true, fullAtStep: ${fullAtStep} }; 1`);
  await serverPost('/run', { scenario: { ...sc, frames: frame }, fullAt: [], lists: listsKey() });
  const log = JSON.parse(await evalRef('H.trace.log')) as unknown[][];
  const full = JSON.parse(await evalRef('H.trace.full || null')) as FullState | null;
  await evalRef('H.trace = null; 1');
  return { log, full };
}

function portTrace(fullAtStep: number): { log: unknown[][]; full: FullState | null } {
  const rt = createPort(sc.seed, 8, sc.username);
  rt.logPen = false;
  rt.greenFlag();
  let full: FullState | null = null;
  const log: unknown[][] = [];
  rt.trace = {
    from: frame,
    to: frame,
    log,
    state: () => {
      const d = digest(fullState(rt));
      if (log.length === fullAtStep) full = fullState(rt);
      return [d.rng, ...d.targets];
    },
  };
  const tl = new InputTimeline(sc.events);
  for (let f = 1; f <= frame; f++) rt.stepFrame(tl.inputsFor(f));
  return { log, full };
}

// The original marks a thread that yielded as running again before its step returns.
const norm = (e: unknown[]) => (e[4] === 2 ? [...e.slice(0, 4), 0, ...e.slice(5)] : e);
const ref = (await refTrace(-1)).log.map(norm);
const port = portTrace(-1).log;
let first = -1;
for (let i = 0; i < Math.max(ref.length, port.length); i++) {
  if (JSON.stringify(ref[i]) !== JSON.stringify(port[i])) {
    first = i;
    break;
  }
}
console.log(`ref ${ref.length} steps, port ${port.length} steps, first differing step ${first}`);
if (first < 0) process.exit(0);
for (let i = Math.max(0, first - 3); i <= first; i++) {
  const show = (e: unknown[] | undefined) => (e ? JSON.stringify(e.slice(0, 5)) : 'none');
  console.log(`${String(i).padStart(6)} ref ${show(ref[i])} port ${show(port[i])}`);
}
const r = (await refTrace(first)).full;
const p = portTrace(first).full;
if (!r || !p) {
  console.log('no full state at that step');
  process.exit(0);
}
if (r.rng !== p.rng) console.log(`  rng calls: ref ${r.rngCalls} port ${p.rngCalls}`);
for (let i = 0; i < Math.max(r.targets.length, p.targets.length); i++) {
  const a = r.targets[i];
  const b = p.targets[i];
  if (!a || !b) {
    console.log(`  target #${i}: ref ${a?.name} port ${b?.name}`);
    continue;
  }
  const out: string[] = [];
  for (const k of ['x', 'y', 'dir', 'size', 'costume', 'vis', 'fx', 'layer'] as const) if (canon(a[k]) !== canon(b[k])) out.push(`${k}: ref ${canon(a[k])} port ${canon(b[k])}`);
  for (const k of new Set([...Object.keys(a.vars), ...Object.keys(b.vars)])) if (canon(a.vars[k]) !== canon(b.vars[k])) out.push(`var ${k}: ref ${canon(a.vars[k])} port ${canon(b.vars[k])}`);
  for (const k of new Set([...Object.keys(a.lists), ...Object.keys(b.lists)])) if (canon(a.lists[k]) !== canon(b.lists[k])) out.push(`list ${k}: ref ${canon(a.lists[k]).slice(0, 300)} port ${canon(b.lists[k]).slice(0, 300)}`);
  if (out.length) {
    console.log(`  target #${i} ${a.name}${a.orig ? '' : ' (clone)'}:`);
    for (const o of out.slice(0, 15)) console.log(`    ${o}`);
  }
}
