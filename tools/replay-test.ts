// Records the matches in a scenario with the page's replay recorder, plays each recording back from its start
// snapshot, and checks that every state hash it kept and the final state match the recorded run.
// Usage: npx tsx tools/replay-test.ts <scenario-file>
import fs from 'node:fs';
import path from 'node:path';
import { createPort, InputTimeline, type Scenario } from './lib/port.ts';
import { ReplayRecorder, replayFrames, runtimeState, type FinishedReplay, type FrameState, type ReplayBody } from '../src/client/replay.ts';
import { fromExactJson, loadSnapshot, saveSnapshot, toExactJson } from '../src/engine/snapshot.ts';
import { snapshotHash } from '../src/net/rollback.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const rt = createPort(sc.seed);
rt.logPen = false;
rt.greenFlag();
const finished: { replay: FinishedReplay; endHash: number }[] = [];
const recorder = new ReplayRecorder(rt, rt.t0, { build: 'test', online: false, names: [] });
let pending: FinishedReplay | null = null;
recorder.onFinish = (r) => (pending = r);
const tl = new InputTimeline(sc.events);
let lastHash = 0;
for (let f = 1; f <= sc.frames; f++) {
  const inputs = tl.inputsFor(f);
  rt.stepFrame(inputs);
  recorder.frame(inputs, runtimeState(rt));
  // The recording's last frame is the one before the match ended.
  if (pending) {
    finished.push({ replay: pending, endHash: lastHash });
    pending = null;
  }
  lastHash = snapshotHash(saveSnapshot(rt));
}
// A match still running when the scenario ends is finished by a state that shows no match.
const live = runtimeState(rt);
const ended: FrameState = { ...live, running: () => false };
recorder.frame([], ended);
if (pending) finished.push({ replay: pending, endHash: lastHash });

if (finished.length === 0) {
  console.log('no match of 10 seconds or more in this scenario');
  process.exit(1);
}
let ok = true;
for (const { replay, endHash } of finished) {
  // Stored replays go through the store's exact JSON.
  const body = fromExactJson<ReplayBody>(toExactJson(replay.body));
  const play = createPort(0);
  play.logPen = false;
  loadSnapshot(play, body.start);
  const checks = new Map<number, number>(body.checks);
  let bad = 0;
  const frames = replayFrames(body);
  frames.forEach((inputs, i) => {
    play.stepFrame(inputs);
    const want = checks.get(i + 1);
    if (want !== undefined && snapshotHash(saveSnapshot(play)) !== want && !bad) bad = i + 1;
  });
  const end = snapshotHash(saveSnapshot(play));
  const m = replay.meta;
  const line = `${m.mode}: ${m.fighters.join(' vs ')} on ${m.stage}, ${m.frames} frames, ${body.checks.length} checks, ${toExactJson(body).length} characters of JSON`;
  if (bad || end !== endHash) {
    ok = false;
    console.log(`MISMATCH ${line}${bad ? `, first failed check at frame ${bad}` : ', final state differs'}`);
  } else console.log(`OK ${line}`);
}
process.exit(ok ? 0 : 1);
