// Checks that restoring a snapshot and re-simulating reproduces the straight run exactly,
// including through a JSON round trip of the snapshot (used to send state to a peer).
// Usage: npx tsx tools/rollback-test.ts <scenario-file> [maxRollback]
import fs from 'node:fs';
import path from 'node:path';
import { canon, createPort, digest, fullState, InputTimeline, type Scenario } from './lib/port.ts';
import { saveSnapshot, loadSnapshot, snapshotFromJson, snapshotToJson, type Snapshot } from '../src/engine/snapshot.ts';
import { Rng } from '../src/engine/rng.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const maxBack = Number(process.argv[3] ?? 8);

const straight = createPort(sc.seed);
straight.greenFlag();
const tl = new InputTimeline(sc.events);
const inputs: ReturnType<InputTimeline["inputsFor"]>[] = [];
const expected: string[] = [];
for (let f = 1; f <= sc.frames; f++) {
  inputs[f] = tl.inputsFor(f);
  straight.stepFrame(inputs[f]);
  expected[f] = JSON.stringify(digest(fullState(straight)));
}

/** Prints what differs between a straight run at frame `g` and the given state. */
function explain(g: number, got: ReturnType<typeof fullState>): void {
  const ref = createPort(sc.seed);
  ref.greenFlag();
  for (let h = 1; h <= g; h++) ref.stepFrame(inputs[h]);
  const want = fullState(ref);
  const show = (v: unknown) => canon(v).slice(0, 300);
  for (const k of Object.keys(want) as (keyof typeof want)[]) {
    if (k === 'targets') continue;
    if (canon(want[k]) !== canon(got[k])) console.log(`  ${k}: straight ${show(want[k])}\n  ${' '.repeat(k.length)}  rollback ${show(got[k])}`);
  }
  want.targets.forEach((t, i) => {
    const o = got.targets[i];
    if (canon(Object.values(t)) === canon(Object.values(o ?? {}))) return;
    for (const k of Object.keys(t) as (keyof typeof t)[]) {
      if (canon(t[k]) !== canon(o?.[k])) console.log(`  #${i} ${t.name}.${k}: straight ${show(t[k])}\n      rollback ${show(o?.[k])}`);
    }
  });
}

const rt = createPort(sc.seed);
rt.greenFlag();
const snaps: Snapshot[] = [];
snaps[0] = saveSnapshot(rt);
const rng = new Rng(99);
let rollbacks = 0;
let jsonTrips = 0;
let snapMs = 0;
let loadMs = 0;
let f = 0;
while (f < sc.frames) {
  f++;
  rt.stepFrame(inputs[f]);
  let t0 = performance.now();
  snaps[f] = saveSnapshot(rt);
  snapMs += performance.now() - t0;
  const got = JSON.stringify(digest(fullState(rt)));
  if (got !== expected[f]) {
    console.log(`MISMATCH at frame ${f} after ${rollbacks} rollbacks`);
    process.exit(1);
  }
  // Roll back a random distance now and then, and simulate forward again.
  if (rng.next() < 0.2 && f > maxBack) {
    const back = 1 + Math.floor(rng.next() * maxBack);
    const target = f - back;
    t0 = performance.now();
    let snap = snaps[target];
    if (rng.next() < 0.05) {
      snap = snapshotFromJson(snapshotToJson(snap));
      jsonTrips++;
    }
    loadSnapshot(rt, snap);
    loadMs += performance.now() - t0;
    for (let g = target + 1; g <= f; g++) {
      rt.stepFrame(inputs[g]);
      snaps[g] = saveSnapshot(rt);
      const d = JSON.stringify(digest(fullState(rt)));
      if (d !== expected[g]) {
        console.log(`MISMATCH at frame ${g} replaying from ${target} (rollback ${rollbacks + 1})`);
        explain(g, fullState(rt));
        process.exit(1);
      }
    }
    rollbacks++;
  }
}
console.log(`OK ${sc.frames} frames, ${rollbacks} rollbacks (${jsonTrips} through JSON), snapshot ${(snapMs / sc.frames).toFixed(3)} ms/frame, load ${(loadMs / Math.max(1, rollbacks)).toFixed(3)} ms`);
