// Pairs the scripts of two projects by sprite and hat, and writes the scripts each side lacks and a line diff of each changed one.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');
const { makePrinter } = require('./decompile.cjs');

const [, , aPath, bPath, outDir] = process.argv;
const A = JSON.parse(fs.readFileSync(aPath, 'utf8'));
const B = JSON.parse(fs.readFileSync(bPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

function scripts(t, stage) {
  const pr = makePrinter(t, stage);
  const list = [];
  for (const [id, b] of Object.entries(t.blocks)) {
    if (Array.isArray(b) || !b.topLevel) continue;
    const h = pr.hat(b);
    if (!h) continue;
    const body = [];
    pr.stmts(b.next, '  ', body);
    list.push({ id, hat: h, body, text: body.join('\n') });
  }
  return list;
}

// Shared lines over total lines, for pairing scripts that share a hat.
function similarity(x, y) {
  const s = new Map();
  for (const l of x.body) s.set(l, (s.get(l) || 0) + 1);
  let common = 0;
  for (const l of y.body) if (s.get(l) > 0) { common++; s.set(l, s.get(l) - 1); }
  return (2 * common) / (x.body.length + y.body.length || 1);
}

function pair(xs, ys) {
  const byHat = new Map();
  for (const y of ys) { if (!byHat.has(y.hat)) byHat.set(y.hat, []); byHat.get(y.hat).push(y); }
  const pairs = [], onlyA = [];
  const used = new Set();
  // Identical bodies pair first, then the most similar remaining script with the same hat.
  for (const x of xs) {
    const c = (byHat.get(x.hat) || []).find(y => !used.has(y) && y.text === x.text);
    if (c) { used.add(c); pairs.push([x, c]); x.done = true; }
  }
  for (const x of xs) {
    if (x.done) continue;
    let best = null, bs = -1;
    for (const y of byHat.get(x.hat) || []) {
      if (used.has(y)) continue;
      const s = similarity(x, y);
      if (s > bs) { bs = s; best = y; }
    }
    if (best) { used.add(best); pairs.push([x, best]); } else onlyA.push(x);
  }
  const onlyB = ys.filter(y => !used.has(y));
  return { pairs, onlyA, onlyB };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdiff-'));
function lineDiff(a, b) {
  const fa = path.join(tmp, 'a'), fb = path.join(tmp, 'b');
  fs.writeFileSync(fa, a + '\n'); fs.writeFileSync(fb, b + '\n');
  try { execFileSync('diff', ['-U2', fa, fb]); return ''; }
  catch (e) { return e.stdout.toString().split('\n').slice(2).join('\n'); }
}

const summary = [];
const names = [...new Set([...A.targets, ...B.targets].map(t => t.name))];
for (const name of names) {
  const ta = A.targets.find(t => t.name === name), tb = B.targets.find(t => t.name === name);
  if (!ta || !tb) { summary.push(`${name}: only in ${ta ? 'A' : 'B'}`); continue; }
  const sa = scripts(ta, A.targets.find(x => x.isStage)), sb = scripts(tb, B.targets.find(x => x.isStage));
  // A B procedure that extends an A proccode prints as the A call when its extra arguments are empty.
  const procA = sa.map(s => /^DEFINE "(.*)" args/.exec(s.hat)).filter(Boolean).map(m => m[1]);
  const procB = sb.map(s => /^DEFINE "(.*)" args/.exec(s.hat)).filter(Boolean).map(m => m[1]);
  for (const p of procB) {
    if (procA.includes(p)) continue;
    const q = procA.find(q => !procB.includes(q) && p.startsWith(q + ' '));
    if (!q) continue;
    const extra = (p.slice(q.length).match(/%[sbn]/g) || []).length;
    const tail = new RegExp(`call "${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\((.*)${', ""'.repeat(extra).replace(/[()]/g, '\\$&')}\\)$`);
    for (const s of sb) {
      s.body = s.body.map(l => l.replace(tail, (_, args) => `call "${q}"(${args})`));
      s.text = s.body.join('\n');
    }
    summary.push(`${name}: re-signatured "${q}" -> +${extra} args`);
  }
  const { pairs, onlyA, onlyB } = pair(sa, sb);
  const changed = pairs.filter(([x, y]) => x.text !== y.text);
  const out = [];
  for (const s of onlyA) out.push(`=== ONLY IN A: ${s.hat} [${s.body.length} lines]\n${s.text}\n`);
  for (const s of onlyB) out.push(`=== ONLY IN B: ${s.hat} [${s.body.length} lines]\n${s.text}\n`);
  for (const [x, y] of changed) out.push(`=== CHANGED: ${x.hat} [${x.body.length} -> ${y.body.length} lines]\n${lineDiff(x.text, y.text)}`);
  summary.push(`${name}: ${pairs.length - changed.length} same, ${changed.length} changed, ${onlyA.length} only A, ${onlyB.length} only B`);
  if (out.length) fs.writeFileSync(path.join(outDir, name.replace(/[^\w+-]/g, '_') + '.diff'), out.join('\n'));
}
fs.rmSync(tmp, { recursive: true });
fs.writeFileSync(path.join(outDir, '_summary.txt'), summary.join('\n') + '\n');
console.log(summary.join('\n'));
