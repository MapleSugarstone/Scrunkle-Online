// Runs a scenario in the port and prints chosen stage variables, open questions and running scripts at chosen frames.
// Usage: npx tsx tools/port-state.ts <scenario-file> <frame,frame,...> [variable,variable,...]
import fs from 'node:fs';
import path from 'node:path';
import { createPort, InputTimeline, type Scenario } from './lib/port.ts';
import { describe } from '../src/game/screens.ts';

const sc: Scenario = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const at = new Set(process.argv[3].split(',').map(Number));
const names = (process.argv[4] ?? '').split(',').filter(Boolean);
const rt = createPort(sc.seed, 8, sc.username);
rt.logPen = false;
rt.greenFlag();
const tl = new InputTimeline(sc.events);
const last = Math.max(...at);
const stageNames = rt.stage.sprite.def.varNames ?? {};
for (let f = 1; f <= last; f++) {
  rt.stepFrame(tl.inputsFor(f));
  if (!at.has(f)) continue;
  console.log(`frame ${f}: ${describe(rt)} ticks=${rt.ticks} questions=${rt.questions.length}`);
  for (const n of names) {
    const prop = stageNames[n];
    const v = prop === undefined ? '(no such stage variable)' : String(rt.stage.v[prop]);
    console.log(`  ${n} = ${v.length > 120 ? `${v.slice(0, 120)}... (${v.length} chars)` : v}`);
  }
  const scripts = rt.threads.map((th) => `${th.target.name}:${th.script.hat}${th.script.msg ? `(${th.script.msg})` : ''}:${th.status}`);
  console.log(`  threads (${scripts.length}): ${scripts.join(' ')}`);
}
