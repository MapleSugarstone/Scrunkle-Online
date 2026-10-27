// Runs tools/parity.ts over every scenario in tests/scenarios (or the given ones), a few at a
// time, and prints a summary. Progress and results go to out/logs/parity-all.txt as runs finish.
// Usage: npx tsx tools/parity-all.ts [parallel] [scenario names...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const parallel = Number(process.argv[2] ?? 4);
const only = process.argv.slice(3);
const dir = path.join(ROOT, 'tests', 'scenarios');
const names = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.json') && !f.startsWith('explore'))
  .map((f) => f.slice(0, -5))
  .filter((n) => only.length === 0 || only.includes(n));
const logDir = path.join(ROOT, 'out', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const progress = path.join(logDir, 'parity-all.txt');
const results: Record<string, string> = {};
const started = Date.now();

function write(): void {
  const done = Object.keys(results).length;
  const lines = [`${done}/${names.length} done, ${((Date.now() - started) / 60000).toFixed(1)} min`];
  for (const n of names) lines.push(`${n.padEnd(16)} ${results[n] ?? '...'}`);
  fs.writeFileSync(progress, `${lines.join('\n')}\n`);
}

function run(name: string): Promise<void> {
  return new Promise((resolve) => {
    const log = fs.openSync(path.join(logDir, `${name}.log`), 'w');
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'tools', 'parity.ts'), path.join(dir, `${name}.json`)], {
      cwd: ROOT,
      stdio: ['ignore', log, log],
    });
    child.on('exit', () => {
      fs.closeSync(log);
      const text = fs.readFileSync(path.join(logDir, `${name}.log`), 'utf8');
      const line = text.split('\n').find((l) => l.startsWith('PARITY OK') || l.startsWith('FIRST DIFFERENCE')) ?? 'no result (see log)';
      results[name] = line;
      write();
      resolve();
    });
  });
}

write();
const queue = [...names];
await Promise.all(
  Array.from({ length: parallel }, async () => {
    for (;;) {
      const n = queue.shift();
      if (!n) return;
      await run(n);
    }
  }),
);
console.log(fs.readFileSync(progress, 'utf8'));
