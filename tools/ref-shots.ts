// Runs a scenario on the reference and saves screenshots, to see what the original shows.
// Usage: npx tsx tools/ref-shots.ts <scenario-file> <frame,frame,...> [outdir]
import fs from 'node:fs';
import path from 'node:path';
import { openReference, ROOT } from './lib/reference.ts';
import type { Scenario } from './lib/port.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const shotAt = process.argv[3].split(',').map(Number);
const out = path.resolve(process.argv[4] ?? path.join(ROOT, 'out', 'shots', sc.name));
fs.mkdirSync(out, { recursive: true });
const frames = Math.max(...shotAt);

const ref = await openReference();
await ref.page.evaluate((s) => (window as any).H.start({ seed: s.seed, username: s.username ?? '' }), { seed: sc.seed, username: sc.username });
const byFrame: Record<number, unknown[]> = {};
for (const e of sc.events) (byFrame[e.f] ??= []).push(e);
const res = await ref.page.evaluate(([n, e, s]) => (window as any).H.run(n, e, { shotAt: s }), [frames, byFrame, shotAt] as const);
for (const [f, data] of Object.entries(res.shots as Record<string, string>)) {
  fs.writeFileSync(path.join(out, `ref-${String(f).padStart(5, '0')}.png`), Buffer.from(data.split(',')[1], 'base64'));
}
console.log('saved', Object.keys(res.shots).length, 'to', out);
await ref.close();
