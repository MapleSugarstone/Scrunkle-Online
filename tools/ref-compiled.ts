// Prints the JavaScript that the original's compiler made for scripts it has already run, for comparing with the
// port's generated code. Run a scenario through tools/parity.ts first so the scripts have compiled.
// Needs tools/ref-server.ts running. Usage: npx tsx tools/ref-compiled.ts <sprite> <hat block id or proccode text> [out file]
import fs from 'node:fs';
import { SERVER } from './lib/ref-client.ts';

const [sprite, key, outFile] = process.argv.slice(2);
const code = `(() => {
  const t = H.vm.runtime.targets.find((x) => x.isOriginal && x.sprite.name === ${JSON.stringify(sprite)});
  if (!t) return 'no sprite';
  const out = [];
  const cache = t.blocks._cache.compiledScripts;
  for (const [top, r] of Object.entries(cache)) {
    if (!r.success) { if (top === ${JSON.stringify(key)}) out.push('compile error: ' + r.value); continue; }
    const v = r.value;
    if (top === ${JSON.stringify(key)}) out.push('// script ' + top + '\\n' + v.startingFunction.toString());
    for (const [proc, f] of Object.entries(v.procedures)) {
      if (proc.includes(${JSON.stringify(key)})) out.push('// procedure ' + proc + ' (from script ' + top + ')\\n' + f.toString());
    }
  }
  return out.length ? out.join('\\n\\n') : 'not compiled yet';
})()`;
const res = await fetch(`${SERVER}/eval`, { method: 'POST', body: code });
const text = JSON.parse(await res.text()) as string;
if (outFile) {
  fs.writeFileSync(outFile, text);
  console.log(`wrote ${text.length} characters to ${outFile}`);
} else console.log(text);
