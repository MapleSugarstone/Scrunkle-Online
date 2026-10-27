// Edited list data in data/lists. Each file holds one list in the form the original editor's list import reads:
// one item per line, every line in double quotes with inner quotes doubled, lines joined by CRLF.
// Stage lists sit in data/lists, and a sprite's own lists in data/lists/<sprite>.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);
const Papa = require('papaparse') as { parse: (text: string, opts: { header: boolean }) => { data: string[][] } };

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const LIST_DIR = path.join(ROOT, 'data', 'lists');
export const SOURCE_SB3 = path.join(ROOT, 'game.sb3');
export const PATCHED_SB3 = path.join(ROOT, 'out', 'patched.sb3');

/** A file name for a list name, with the characters file systems reject replaced. */
export function fileNameFor(name: string): string {
  return `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')}.txt`;
}

/** Writes items the way the editor's import reads them back unchanged. */
export function formatList(items: unknown[]): string {
  return items.map((v) => `"${String(v).replace(/"/g, '""')}"`).join('\r\n');
}

/** Reads a list file exactly as the editor's import does, with the column prompt answered 1. */
export function parseList(text: string): { items: string[]; columns: number } {
  const rows = Papa.parse(text, { header: false }).data;
  if (rows.length === 0) return { items: [], columns: 0 };
  return { items: rows.map((r) => r[0]).filter((x) => typeof x === 'string'), columns: rows[0].length };
}

export interface ListOverride {
  file: string;
  target: string;
  list: string;
  id: string;
  items: string[];
  /** Columns the import would find; more than 1 means it would ask which column to use. */
  columns: number;
}

type Project = { targets: { name: string; isStage: boolean; lists: Record<string, [string, unknown[]]> }[] };

/** Every edited list in data/lists, matched to its list in the project. */
export function readOverrides(project: Project): ListOverride[] {
  if (!fs.existsSync(LIST_DIR)) return [];
  const out: ListOverride[] = [];
  const stage = project.targets.find((t) => t.isStage)!;
  const scan = (dir: string, target: Project['targets'][number]) => {
    for (const f of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) {
        if (target !== stage) throw new Error(`${full}: sprite folders only go directly in data/lists`);
        const sprite = project.targets.find((t) => !t.isStage && t.name === f);
        if (!sprite) throw new Error(`${full}: no sprite named ${f}`);
        scan(full, sprite);
        continue;
      }
      if (!f.endsWith('.txt')) continue;
      const matches = Object.entries(target.lists).filter(([, [name]]) => fileNameFor(name) === f);
      if (matches.length !== 1) throw new Error(`${full}: ${matches.length === 0 ? 'no' : 'more than one'} list of ${target.name} has this file name`);
      const [id, [name]] = matches[0];
      const { items, columns } = parseList(fs.readFileSync(full, 'utf8'));
      out.push({ file: path.relative(ROOT, full), target: target.name, list: name, id, items, columns });
    }
  };
  scan(LIST_DIR, stage);
  return out;
}

/** Replaces each edited list's items in the project, as importing the files in the editor would. */
export function applyOverrides(project: Project, overrides: ListOverride[]): void {
  for (const o of overrides) {
    const t = project.targets.find((x) => x.name === o.target)!;
    t.lists[o.id][1] = o.items.slice();
  }
}

/** The project with every edited list applied, packed beside the source project for the reference runner. */
export async function writePatchedProject(): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(SOURCE_SB3));
  const project = JSON.parse(await zip.file('project.json')!.async('string')) as Project;
  applyOverrides(project, readOverrides(project));
  zip.file('project.json', JSON.stringify(project));
  fs.mkdirSync(path.dirname(PATCHED_SB3), { recursive: true });
  fs.writeFileSync(PATCHED_SB3, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return PATCHED_SB3;
}

/** A hash of every file in data/lists, empty when there are none, so cached and loaded references can be matched to the data. */
export function listsKey(): string {
  if (!hasOverrides()) return '';
  const hash = createHash('sha1');
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d).sort()) {
      const full = path.join(d, f);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (f.endsWith('.txt')) hash.update(path.relative(LIST_DIR, full)).update(fs.readFileSync(full));
    }
  };
  walk(LIST_DIR);
  return hash.digest('hex').slice(0, 12);
}

export function hasOverrides(): boolean {
  if (!fs.existsSync(LIST_DIR)) return false;
  const walk = (d: string): boolean => fs.readdirSync(d).some((f) => (fs.statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : f.endsWith('.txt')));
  return walk(LIST_DIR);
}
