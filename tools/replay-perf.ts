// Times a saved replay frame by frame: simulation, saving a snapshot and loading one, as a rollback session does.
// Usage: npx tsx tools/replay-perf.ts <file.meow>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createPort } from './lib/port.ts';
import { replayFrames, type ReplayBody, type ReplayMeta } from '../src/client/replay.ts';
import { fromExactJson, loadSnapshot, saveSnapshot } from '../src/engine/snapshot.ts';

const file = path.resolve(process.argv[2]);
const { meta, body } = fromExactJson<{ meta: ReplayMeta; body: ReplayBody }>(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
const rt = createPort(0, undefined, '', body.t0);
rt.logPen = false;
loadSnapshot(rt, body.start);
const frames = replayFrames(body);
const step: number[] = [];
const save: number[] = [];
const load: number[] = [];
let changes = 0;
let prev = '';
for (const inputs of frames) {
  const key = JSON.stringify(inputs.map((p) => [...p.keys].sort()));
  if (key !== prev) changes++;
  prev = key;
  let t = performance.now();
  rt.stepFrame(inputs);
  step.push(performance.now() - t);
  t = performance.now();
  const s = saveSnapshot(rt);
  save.push(performance.now() - t);
  t = performance.now();
  loadSnapshot(rt, s);
  load.push(performance.now() - t);
}
const pct = (list: number[], p: number) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))].toFixed(2);
const row = (name: string, list: number[]) => console.log(`${name.padEnd(9)} median ${pct(list, 0.5)} ms, 90th ${pct(list, 0.9)} ms, 99th ${pct(list, 0.99)} ms, max ${pct(list, 1)} ms`);
console.log(`${meta.fighters.join(' vs ')} on ${meta.stage}: ${frames.length} frames, input changed on ${changes}`);
row('step', step);
row('save', save);
row('load', load);
const slow = step.map((ms, i) => ({ f: i + 1, ms })).sort((a, b) => b.ms - a.ms).slice(0, 8);
console.log(`slowest steps: ${slow.map((s) => `${s.ms.toFixed(1)} ms at ${s.f}`).join(', ')}`);
