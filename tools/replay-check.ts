// Plays a saved replay file back from its start snapshot and checks every state hash it kept.
// Usage: npx tsx tools/replay-check.ts <file.meow>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createPort } from './lib/port.ts';
import { replayFrames, type ReplayBody, type ReplayMeta } from '../src/client/replay.ts';
import { fromExactJson, loadSnapshot, saveSnapshot } from '../src/engine/snapshot.ts';
import { snapshotHash } from '../src/net/rollback.ts';

const file = path.resolve(process.argv[2]);
const data = fromExactJson<{ meta: ReplayMeta; body: ReplayBody }>(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
const { meta, body } = data;
console.log(`${meta.online ? 'Online ' : ''}${meta.mode}: ${meta.fighters.join(' vs ')} on ${meta.stage}, ${meta.frames} frames, build ${meta.build}`);
console.log(`players: ${meta.names.join(', ') || 'none'}, saved ${String(meta.saved)}, ${body.checks.length} checks`);
const play = createPort(0, undefined, '', body.t0);
play.logPen = false;
loadSnapshot(play, body.start);
const checks = new Map<number, number>(body.checks);
const failed: number[] = [];
replayFrames(body).forEach((inputs, i) => {
  play.stepFrame(inputs);
  const want = checks.get(i + 1);
  if (want !== undefined && snapshotHash(saveSnapshot(play)) !== want) failed.push(i + 1);
});
if (failed.length) console.log(`MISMATCH at ${failed.length} of ${checks.size} checks, first at frame ${failed[0]}: ${failed.slice(0, 12).join(', ')}`);
else console.log(`OK, all ${checks.size} checks match`);
