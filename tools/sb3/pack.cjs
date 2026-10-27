// Zips an unpacked project folder into an .sb3 holding project.json and only the assets it references.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const [, , dir, outFile] = process.argv;
const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const files = new Set();
for (const t of p.targets) for (const a of [...t.costumes, ...t.sounds]) files.add(a.md5ext || `${a.assetId}.${a.dataFormat}`);
const zip = new JSZip();
zip.file('project.json', fs.readFileSync(path.join(dir, 'project.json')));
let missing = 0;
for (const f of files) {
  const src = path.join(dir, f);
  if (!fs.existsSync(src)) { console.error(`missing ${f}`); missing++; continue; }
  zip.file(f, fs.readFileSync(src));
}
if (missing) process.exit(1);
zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }).then(buf => {
  fs.writeFileSync(outFile, buf);
  console.log(`${outFile}: ${files.size} assets, ${(buf.length / 1048576).toFixed(1)} MiB`);
});
