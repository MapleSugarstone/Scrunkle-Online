// Queues tests for a drive.cjs server: node tools/sb3/queue.cjs <serveDir> <test.cjs>... writes NN-<name>.cjs wrappers in order.
const fs = require('fs');
const path = require('path');

const [, , dir, ...tests] = process.argv;
fs.mkdirSync(dir, { recursive: true });
let n = fs.readdirSync(dir).filter(f => /^\d+-/.test(f)).length;
for (const t of tests) {
  const abs = path.resolve(t).split(path.sep).join('/');
  const file = path.join(dir, `${String(++n).padStart(2, '0')}-${path.basename(t, '.cjs')}.cjs`);
  // Fresh copies of the test and its helpers on every run, so edits apply without restarting the server.
  fs.writeFileSync(file, `for (const k of Object.keys(require.cache)) if (k.includes('tests')) delete require.cache[k];\nmodule.exports = require(${JSON.stringify(abs)});\n`);
  console.log(file);
}
