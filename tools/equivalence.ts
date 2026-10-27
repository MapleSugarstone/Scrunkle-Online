// Plays scenarios in the original runtime with two versions of the project and checks that every frame shows, plays
// and holds the same things. Use it to confirm that a change that removes or rewrites blocks keeps the game's behavior.
// Usage: npx tsx tools/equivalence.ts <before.sb3> <after.sb3> [scenario names, files or folders...] [--ignore name,name]
// With no scenarios it plays every scenario in tests/scenarios. tests/equivalence holds longer random-click runs.
// Progress goes to out/equivalence.progress.txt and the report to out/equivalence.txt. The file out/equivalence.stop
// ends the run after the current chunk with a partial report.
import fs from 'node:fs';
import path from 'node:path';
import { openReference, ROOT, type RefSession } from './lib/reference.ts';
import type { Scenario } from './lib/port.ts';

const args = process.argv.slice(2);
const ignoreAt = args.indexOf('--ignore');
const ignore = ignoreAt >= 0 ? args.splice(ignoreAt, 2)[1].split(',') : [];
const [before, after, ...names] = args;
if (!before || !after) throw new Error('usage: npx tsx tools/equivalence.ts <before.sb3> <after.sb3> [scenario names...] [--ignore name,name]');
const dir = path.join(ROOT, 'tests', 'scenarios');
// A name is a scenario in tests/scenarios, and a path ending in .json or a folder names scenario files directly.
const files = (names.length ? names : [dir]).flatMap((n) => {
  if (n.endsWith('.json')) return [path.resolve(n)];
  if (fs.existsSync(n) && fs.statSync(n).isDirectory()) return fs.readdirSync(n).filter((f) => f.endsWith('.json')).map((f) => path.resolve(n, f));
  return [path.join(dir, `${n}.json`)];
});
const scenarios = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as Scenario);
const OUT = path.join(ROOT, 'out', 'equivalence.txt');
const PROGRESS = path.join(ROOT, 'out', 'equivalence.progress.txt');
const STOP = path.join(ROOT, 'out', 'equivalence.stop');
const CHUNK = 300;
if (fs.existsSync(STOP)) fs.unlinkSync(STOP);

const started = Date.now();
const totalFrames = scenarios.reduce((n, s) => n + s.frames, 0);
let framesDone = 0;
const lines: string[] = [];
let current = '';
function progress(): void {
  const elapsed = (Date.now() - started) / 1000;
  const left = framesDone ? (elapsed / framesDone) * (totalFrames - framesDone) : NaN;
  fs.writeFileSync(PROGRESS, [`frames done: ${framesDone} of ${totalFrames}`, `current: ${current}`, `elapsed: ${elapsed.toFixed(0)} s`,
    `estimated left: ${Number.isNaN(left) ? 'unknown' : `${left.toFixed(0)} s`}`, ...lines].join('\n') + '\n');
}

/** The names of the parts of two observed states that differ. */
function differences(a: any, b: any): string[] {
  const out: string[] = [];
  for (const k of ['rng', 'rngCalls', 'answer']) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(`${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`);
  if (JSON.stringify(a.pen) !== JSON.stringify(b.pen)) out.push(`pen: ${a.pen.length} vs ${b.pen.length} operations`);
  if (JSON.stringify(a.sound) !== JSON.stringify(b.sound)) out.push(`sound: ${JSON.stringify(a.sound).slice(0, 200)} vs ${JSON.stringify(b.sound).slice(0, 200)}`);
  if (a.targets.length !== b.targets.length) out.push(`targets: ${a.targets.length} vs ${b.targets.length}`);
  const fields = ['name', 'original', 'x', 'y', 'direction', 'size', 'costume', 'visible', 'rotation', 'volume', 'effects', 'layer'];
  a.targets.forEach((ta: any[], i: number) => {
    const tb = b.targets[i];
    if (!tb) return;
    fields.forEach((f, k) => { if (JSON.stringify(ta[k]) !== JSON.stringify(tb[k])) out.push(`${ta[0]} ${f}: ${JSON.stringify(ta[k])} vs ${JSON.stringify(tb[k])}`); });
    for (const [k, kind] of [[12, 'variable'], [13, 'list']] as const) {
      const ma = new Map<string, unknown>(ta[k]);
      const mb = new Map<string, unknown>(tb[k]);
      for (const n of new Set([...ma.keys(), ...mb.keys()])) {
        if (JSON.stringify(ma.get(n)) !== JSON.stringify(mb.get(n))) out.push(`${ta[0]} ${kind} ${n}: ${JSON.stringify(ma.get(n))?.slice(0, 160)} vs ${JSON.stringify(mb.get(n))?.slice(0, 160)}`);
      }
    }
  });
  return out;
}

const refs: RefSession[] = await Promise.all([openReference({ sb3: path.resolve(before) }), openReference({ sb3: path.resolve(after) })]);
let failed = 0;
let stopped = false;
try {
  for (const sc of scenarios) {
    if (stopped) break;
    current = sc.name;
    const ev: Record<number, unknown[]> = {};
    for (const e of sc.events) (ev[e.f] ??= []).push(e);
    await Promise.all(refs.map((r) => r.page.evaluate((s) => (window as any).H.start({ seed: s.seed, username: s.username ?? '' }), { seed: sc.seed, username: sc.username })));
    let frame = 0;
    let mismatch = 0;
    while (frame < sc.frames && !mismatch) {
      if (fs.existsSync(STOP)) { stopped = true; break; }
      const n = Math.min(CHUNK, sc.frames - frame);
      const [ha, hb] = await Promise.all(refs.map((r) => r.page.evaluate(([n2, e, ig]) => (window as any).H.runObserved(n2, e, ig), [n, ev, ignore] as const)));
      const at = ha.findIndex((h: string, i: number) => h !== hb[i]);
      if (at >= 0) mismatch = frame + at + 1;
      frame += n;
      framesDone += n;
      progress();
    }
    if (mismatch) {
      // Replay both up to the first differing frame and name what differs there.
      await Promise.all(refs.map((r) => r.page.evaluate((s) => (window as any).H.start({ seed: s.seed, username: s.username ?? '' }), { seed: sc.seed, username: sc.username })));
      for (let done = 0; done < mismatch; done += CHUNK) {
        const n = Math.min(CHUNK, mismatch - done);
        await Promise.all(refs.map((r) => r.page.evaluate(([n2, e, ig]) => (window as any).H.runObserved(n2, e, ig), [n, ev, ignore] as const)));
      }
      const [sa, sb] = await Promise.all(refs.map((r) => r.page.evaluate((ig) => (window as any).H.observed(ig), ignore)));
      failed++;
      lines.push(`${sc.name.padEnd(18)} DIFFERS at frame ${mismatch} of ${sc.frames}`, ...differences(sa, sb).slice(0, 20).map((d) => `    ${d}`));
    } else {
      lines.push(`${sc.name.padEnd(18)} ${frame < sc.frames ? `stopped at frame ${frame} of ${sc.frames}` : `SAME for ${sc.frames} frames`}`);
    }
    console.log(lines.slice(-1)[0]);
    progress();
  }
} finally {
  await Promise.all(refs.map((r) => r.close()));
}
const ran = lines.filter((l) => !l.startsWith(' ')).length;
const summary = `${ran - failed} of ${ran} scenarios the same, ${failed} differ${stopped || ran < scenarios.length ? ` (partial: stopped with ${ran} of ${scenarios.length} scenarios run)` : ''}`;
fs.writeFileSync(OUT, [`Equivalence of ${before} and ${after}, ${new Date().toISOString()}`, `ignored names: ${ignore.join(', ') || 'none'}`, '', ...lines, '', summary].join('\n') + '\n');
current = 'finished';
lines.push(summary);
progress();
console.log(summary);
if (fs.existsSync(STOP)) fs.unlinkSync(STOP);
process.exit(failed ? 1 : 0);
