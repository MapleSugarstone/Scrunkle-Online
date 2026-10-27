// Runs a scenario on the reference and on the port and reports the first frame where they differ.
// Usage: npx tsx tools/parity.ts <scenario-file|idle> [frames]
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { openReference, ROOT, type RefSession } from './lib/reference.ts';
import { serverPost, serverUp as isServerUp } from './lib/ref-client.ts';
import { listsKey, SOURCE_SB3 } from './lib/lists.ts';
import { canon, createPort, digest, fullState, InputTimeline, normalizeSound, type Digest, type FullState, type Scenario } from './lib/port.ts';

const arg = process.argv[2] ?? 'idle';
const scenario: Scenario =
  arg === 'idle'
    ? { name: 'idle', seed: 1, frames: Number(process.argv[3] ?? 600), events: [] }
    : JSON.parse(fs.readFileSync(path.resolve(arg), 'utf8'));
if (process.argv[3]) scenario.frames = Number(process.argv[3]);
const CHUNK = 300;

function refEvents(sc: Scenario): Record<number, unknown[]> {
  const byFrame: Record<number, unknown[]> = {};
  for (const e of sc.events) (byFrame[e.f] ??= []).push(e);
  return byFrame;
}

/** A reference server (tools/ref-server.ts) runs scenarios without reloading the project. */
const serverUp = await isServerUp();

async function runRef(ref: RefSession | null, sc: Scenario, fullAt: number[] = []): Promise<{ digests: Digest[]; fulls: Record<number, FullState> }> {
  if (serverUp) {
    return serverPost('/run', { scenario: sc, fullAt, lists: listsKey() });
  }
  if (!ref) throw new Error('no reference session');
  await ref.page.evaluate((s) => (window as any).H.start({ seed: s.seed, username: s.username ?? '' }), { seed: sc.seed, username: sc.username });
  const ev = refEvents(sc);
  const digests: Digest[] = [];
  const fulls: Record<number, FullState> = {};
  for (let done = 0; done < sc.frames; done += CHUNK) {
    const n = Math.min(CHUNK, sc.frames - done);
    const res = await ref.page.evaluate(([n2, e, fa]) => (window as any).H.run(n2, e, { fullAt: fa }), [n, ev, fullAt] as const);
    digests.push(...res.digests);
    Object.assign(fulls, res.fulls);
  }
  return { digests, fulls };
}

function runPort(sc: Scenario, fullAt: number[] = []): { digests: Digest[]; fulls: Record<number, FullState>; ms: number } {
  const rt = createPort(sc.seed, 8, sc.username);
  rt.greenFlag();
  const tl = new InputTimeline(sc.events);
  const digests: Digest[] = [];
  const fulls: Record<number, FullState> = {};
  const want = new Set(fullAt);
  const t0 = performance.now();
  for (let f = 1; f <= sc.frames; f++) {
    rt.stepFrame(tl.inputsFor(f));
    const s = fullState(rt);
    digests.push(digest(s));
    if (want.has(f)) fulls[f] = s;
  }
  return { digests, fulls, ms: performance.now() - t0 };
}

function firstDiff(a: Digest[], b: Digest[]): { frame: number; what: string[] } | null {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    const what: string[] = [];
    if (x.ticks !== y.ticks) what.push(`ticks ${x.ticks} vs ${y.ticks}`);
    if (x.rng !== y.rng) what.push('rng');
    if (x.threads !== y.threads) what.push('threads');
    if (x.pen !== y.pen) what.push(`pen (${x.penCount} vs ${y.penCount} ops)`);
    if (x.sound !== y.sound) what.push('sound');
    if (x.targets.length !== y.targets.length) what.push(`target count ${x.targets.length} vs ${y.targets.length}`);
    else x.targets.forEach((h, j) => { if (h !== y.targets[j]) what.push(`target #${j}`); });
    if (what.length) return { frame: x.frame, what };
  }
  return null;
}

function show(v: unknown): string {
  const s = canon(v);
  return s.length > 300 ? `${s.slice(0, 300)}...` : s;
}

function explain(r: FullState, p: FullState): void {
  if (r.ticks !== p.ticks) console.log(`  ticks: ref ${r.ticks} port ${p.ticks}`);
  if (r.rng !== p.rng) console.log(`  rng calls: ref ${r.rngCalls} port ${p.rngCalls}`);
  const rth = r.threads.map((t) => t.slice(0, 3).join(':'));
  const pth = p.threads.map((t) => t.slice(0, 3).join(':'));
  if (rth.join() !== pth.join()) {
    console.log(`  threads ref (${rth.length}): ${rth.join(' ')}`);
    console.log(`  threads port(${pth.length}): ${pth.join(' ')}`);
  }
  const n = Math.max(r.targets.length, p.targets.length);
  let shown = 0;
  for (let i = 0; i < n && shown < 6; i++) {
    const a = r.targets[i];
    const b = p.targets[i];
    if (!a || !b) {
      console.log(`  target #${i}: ref ${a?.name} port ${b?.name}`);
      shown++;
      continue;
    }
    const diffs: string[] = [];
    for (const k of ['name', 'orig', 'x', 'y', 'dir', 'size', 'costume', 'vis', 'rot', 'vol', 'fx', 'layer', 'pen', 'snd'] as const) {
      if (show(a[k]) !== show(b[k])) diffs.push(`${k}: ref ${show(a[k])} port ${show(b[k])}`);
    }
    for (const k of new Set([...Object.keys(a.vars), ...Object.keys(b.vars)])) {
      if (show(a.vars[k]) !== show(b.vars[k])) diffs.push(`var ${k}: ref ${show(a.vars[k])} port ${show(b.vars[k])}`);
    }
    for (const k of new Set([...Object.keys(a.lists), ...Object.keys(b.lists)])) {
      if (show(a.lists[k]) !== show(b.lists[k])) diffs.push(`list ${k}: ref ${show(a.lists[k])} port ${show(b.lists[k])}`);
    }
    if (diffs.length) {
      console.log(`  target #${i} ${a.name}${a.orig ? '' : ' (clone)'}:`);
      for (const d of diffs.slice(0, 12)) console.log(`    ${d}`);
      shown++;
    }
  }
  // canon() keeps NaN, Infinity and -0 apart, which JSON does not.
  for (let i = 0; i < Math.max(r.pen.length, p.pen.length); i++) {
    if (canon(r.pen[i]) !== canon(p.pen[i])) {
      console.log(`  pen op ${i}: ref ${canon(r.pen[i])}\n             port ${canon(p.pen[i])}`);
      break;
    }
  }
  const rs = show(normalizeSound(r.sound));
  const ps = show(normalizeSound(p.sound));
  if (rs !== ps) console.log(`  sound: ref ${rs}\n         port ${ps}`);
}

// Reference digests are cached per scenario, harness and project build.
const cacheDir = path.join(ROOT, 'out', 'ref-cache');
fs.mkdirSync(cacheDir, { recursive: true });
const sb3 = fs.statSync(SOURCE_SB3);
const cacheKey = createHash('sha1').update(`${sb3.size}:${sb3.mtimeMs}:${listsKey()}`).update(fs.readFileSync(path.join(ROOT, 'reference', 'harness.js'))).update(fs.readFileSync(path.join(ROOT, 'reference', 'index.html'))).update(fs.readFileSync(path.join(ROOT, 'reference', 'dmath.js'))).update(JSON.stringify(scenario)).digest('hex').slice(0, 12);
const cacheFile = path.join(cacheDir, `${scenario.name}-${cacheKey}.json`);
let ref: RefSession | null = null;
let refDigests: Digest[];
const t0 = Date.now();
if (fs.existsSync(cacheFile)) {
  refDigests = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
} else {
  if (!serverUp) ref = await openReference();
  refDigests = (await runRef(ref, scenario)).digests;
  fs.writeFileSync(cacheFile, JSON.stringify(refDigests));
}
const refMs = Date.now() - t0;
const portRun = runPort(scenario);
console.log(`${scenario.name}: ${scenario.frames} frames, reference ${refMs} ms${serverUp ? ' (server)' : ref ? '' : ' (cached)'}, port ${portRun.ms.toFixed(0)} ms`);
const diff = firstDiff(refDigests, portRun.digests);
if (!diff) {
  console.log('PARITY OK');
} else {
  console.log(`FIRST DIFFERENCE at frame ${diff.frame}: ${diff.what.slice(0, 10).join(', ')}`);
  const at = [diff.frame - 1, diff.frame].filter((f) => f >= 1);
  // Green flag does not reset variables, so the detailed rerun needs a freshly loaded project.
  if (!serverUp) {
    if (ref) await ref.close();
    ref = await openReference();
  }
  const r2 = await runRef(ref, { ...scenario, frames: diff.frame }, at);
  const p2 = runPort({ ...scenario, frames: diff.frame }, at);
  explain(r2.fulls[diff.frame], p2.fulls[diff.frame]);
  process.exitCode = 1;
}
if (ref) await ref.close();
