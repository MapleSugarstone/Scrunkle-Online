// Compares every top-level script of one sprite across several builds, given as unpacked project folders.
// Scripts are keyed by hat text (with a counter for repeats). Each row gives a letter per build; the same letter means the same code.
// Usage: node tools/sb3/sprite-versions.cjs <sprite> <label=folder>... [--all]
const path = require('path');
const L = require('./sb3.cjs');

const args = process.argv.slice(2).filter((a) => a !== '--all');
const sprite = args[0];
const showAll = process.argv.includes('--all');
const versions = args.slice(1).map((a) => (a.includes('=') ? a.split(/=(.*)/s).slice(0, 2) : [path.basename(a), a]));
if (!sprite || versions.length < 2) throw new Error('usage: node tools/sb3/sprite-versions.cjs <sprite> <label=folder> <label=folder>... [--all]');

function scripts(dir) {
  const p = L.loadProject(path.resolve(dir));
  const t = p.targets.find((x) => x.name === sprite || (sprite === 'Stage' && x.isStage));
  const out = new Map();
  if (!t) return out;
  const seen = new Map();
  for (const top of L.topScripts(t)) {
    const hat = L.hatText(t, top).replace(/ \[.*$/, '');
    if (!/^(WHEN|DEFINE)/.test(hat)) continue;
    const n = (seen.get(hat) ?? 0) + 1;
    seen.set(hat, n);
    out.set(n > 1 ? `${hat} #${n}` : hat, L.scriptText(t, top));
  }
  return out;
}

const maps = versions.map(([k, d]) => [k, scripts(d)]);
const keys = [...new Set(maps.flatMap(([, m]) => [...m.keys()]))];
const count = (s) => (s ? s.split('\n').length : 0);
console.log(`order: ${maps.map(([k]) => k).join(' ')}`);
for (const key of keys) {
  const texts = maps.map(([, m]) => m.get(key));
  if (!showAll && texts.every((t) => t === texts[texts.length - 1])) continue;
  const seen = [];
  const letters = texts.map((t) => {
    if (t === undefined) return '-';
    let i = seen.indexOf(t);
    if (i < 0) i = seen.push(t) - 1;
    return 'ABCDEFGH'[i];
  });
  console.log(`${key.slice(0, 70).padEnd(70)} ${letters.join('')}  ${maps.map(([k], i) => `${k} ${String(count(texts[i])).padStart(4)}`).join(' ')}`);
}
