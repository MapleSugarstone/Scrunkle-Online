// Compares costumes and sounds per sprite by name and by asset id.
const fs = require('fs');
const [, , aPath, bPath, verbose] = process.argv;
const A = JSON.parse(fs.readFileSync(aPath, 'utf8'));
const B = JSON.parse(fs.readFileSync(bPath, 'utf8'));
for (const tb of B.targets) {
  const ta = A.targets.find(t => t.name === tb.name);
  if (!ta) continue;
  for (const kind of ['costumes', 'sounds']) {
    const ma = new Map(ta[kind].map(c => [c.name, c])), mb = new Map(tb[kind].map(c => [c.name, c]));
    const onlyA = [...ma.keys()].filter(n => !mb.has(n));
    const onlyB = [...mb.keys()].filter(n => !ma.has(n));
    const changed = [...mb.keys()].filter(n => ma.has(n) && ma.get(n).assetId !== mb.get(n).assetId);
    const moved = [...mb.keys()].filter(n => ma.has(n) && ma.get(n).assetId === mb.get(n).assetId &&
      (ma.get(n).rotationCenterX !== mb.get(n).rotationCenterX || ma.get(n).rotationCenterY !== mb.get(n).rotationCenterY));
    if (!onlyA.length && !onlyB.length && !changed.length && !moved.length) continue;
    const show = l => verbose ? l.join(', ') : l.slice(0, 25).join(', ') + (l.length > 25 ? ` ... (${l.length})` : '');
    console.log(`## ${tb.name} ${kind}: ${onlyA.length} only CB, ${onlyB.length} only PK, ${changed.length} new image, ${moved.length} new center`);
    if (onlyA.length) console.log('  only CB:', show(onlyA));
    if (onlyB.length) console.log('  only PK:', show(onlyB));
    if (changed.length) console.log('  new image:', show(changed));
    if (moved.length) console.log('  new center:', show(moved));
  }
}
