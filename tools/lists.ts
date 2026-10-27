// Edits the game's list data outside the original editor, in data/lists (see tools/lib/lists.ts).
// Usage:
//   npx tsx tools/lists.ts export <list> [<list>...]   copy lists from the project into data/lists for editing
//                                                       (a sprite's own list is "<sprite>/<list>")
//   npx tsx tools/lists.ts status                       compare each edited list with the project
//   npx tsx tools/lists.ts pack                         write out/patched.sb3, the project with the edited lists
// The transpiler applies data/lists, and the reference runner loads out/patched.sb3 whenever data/lists has files.
import fs from 'node:fs';
import path from 'node:path';
import { fileNameFor, formatList, LIST_DIR, parseList, readOverrides, ROOT, writePatchedProject } from './lib/lists.ts';

const project = JSON.parse(fs.readFileSync(path.join(ROOT, 'sb3', 'project.json'), 'utf8'));
const [cmd, ...args] = process.argv.slice(2);

function findList(spec: string): { target: any; name: string; items: unknown[]; file: string } {
  const slash = spec.indexOf('/');
  const sprite = slash > 0 && project.targets.some((t: any) => !t.isStage && t.name === spec.slice(0, slash)) ? spec.slice(0, slash) : null;
  const target = sprite ? project.targets.find((t: any) => t.name === sprite) : project.targets.find((t: any) => t.isStage);
  const name = sprite ? spec.slice(slash + 1) : spec;
  const hit = Object.values<[string, unknown[]]>(target.lists).find(([n]) => n === name);
  if (!hit) {
    const elsewhere = project.targets.filter((t: any) => Object.values<[string]>(t.lists).some(([n]) => n === name)).map((t: any) => t.name);
    throw new Error(`no list "${name}" in ${target.name}${elsewhere.length ? `; found in ${elsewhere.join(', ')}` : ''}`);
  }
  const file = path.join(LIST_DIR, ...(sprite ? [sprite] : []), fileNameFor(name));
  return { target, name, items: hit[1], file };
}

if (cmd === 'export') {
  if (args.length === 0) throw new Error('name at least one list');
  for (const spec of args) {
    const l = findList(spec);
    if (fs.existsSync(l.file)) {
      console.log(`${path.relative(ROOT, l.file)} already exists; delete it first to export again`);
      continue;
    }
    fs.mkdirSync(path.dirname(l.file), { recursive: true });
    fs.writeFileSync(l.file, formatList(l.items));
    const back = parseList(formatList(l.items)).items;
    const exact = back.length === l.items.length && back.every((v, i) => v === String(l.items[i]));
    console.log(`${path.relative(ROOT, l.file)}: ${l.items.length} items${exact ? '' : ' (WARNING: does not read back unchanged)'}`);
  }
} else if (cmd === 'status') {
  const overrides = readOverrides(project);
  if (overrides.length === 0) console.log('data/lists has no edited lists.');
  for (const o of overrides) {
    const t = project.targets.find((x: any) => x.name === o.target);
    const orig = (t.lists[o.id][1] as unknown[]).map((v) => String(v));
    let changed = 0;
    for (let i = 0; i < Math.min(orig.length, o.items.length); i++) if (orig[i] !== o.items[i]) changed++;
    const same = changed === 0 && orig.length === o.items.length;
    const where = o.target === project.targets.find((x: any) => x.isStage).name ? '' : ` (${o.target})`;
    console.log(`${o.list}${where}: ${o.items.length} items, project has ${orig.length}, ${changed} changed${o.columns > 1 ? `, WARNING: the import would ask for one of ${o.columns} columns` : ''}${same ? ', same as the project: delete the file' : ''}`);
  }
} else if (cmd === 'pack') {
  console.log(`wrote ${path.relative(ROOT, await writePatchedProject())}`);
} else {
  console.log('Usage: npx tsx tools/lists.ts export <list>... | status | pack');
  process.exitCode = 1;
}
