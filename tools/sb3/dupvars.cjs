// For each sprite with two variables of the same name, counts the blocks bound to each copy, per script.
// Usage: node tools/sb3/dupvars.cjs <project folder> [sprite]
const path = require('path');
const L = require('./sb3.cjs');

if (!process.argv[2]) throw new Error('usage: node tools/sb3/dupvars.cjs <project folder> [sprite]');
const p = L.loadProject(path.resolve(process.argv[2]));
const only = process.argv[3];
for (const t of p.targets) {
  if (only && t.name !== only) continue;
  const byName = new Map();
  for (const [id, v] of Object.entries(t.variables)) { if (!byName.has(v[0])) byName.set(v[0], []); byName.get(v[0]).push(id); }
  const dups = [...byName].filter(([, ids]) => ids.length > 1);
  if (!dups.length) continue;
  // Which top-level script each block belongs to.
  const owner = new Map();
  for (const top of Object.keys(t.blocks).filter(id => L.isBlock(t.blocks[id]) && t.blocks[id].topLevel)) {
    const label = (L.hatText(t, top) || t.blocks[top].opcode).slice(0, 60);
    for (const id of L.scriptIds(t.blocks, top)) owner.set(id, label);
  }
  for (const [name, ids] of dups) {
    console.log(`${t.name} "${name}": ${ids.map(id => `${id}=${JSON.stringify(t.variables[id][1])}`).join(', ')}`);
    for (const vid of ids) {
      const uses = new Map();
      for (const [bid, b] of Object.entries(t.blocks)) {
        const refs = [];
        if (Array.isArray(b)) { if (b[0] === 12 && b[2] === vid) refs.push(bid); }
        else {
          if (b.fields.VARIABLE && b.fields.VARIABLE[1] === vid) refs.push(bid);
          for (const inp of Object.values(b.inputs)) for (const x of inp.slice(1)) if (Array.isArray(x) && x[0] === 12 && x[2] === vid) refs.push(bid);
        }
        for (const r of refs) { const o = owner.get(r) || '(loose)'; uses.set(o, (uses.get(o) || 0) + 1); }
      }
      console.log(`  ${vid}: ${[...uses].map(([o, n]) => `${o} x${n}`).join(' | ') || 'unused'}`);
    }
  }
}
