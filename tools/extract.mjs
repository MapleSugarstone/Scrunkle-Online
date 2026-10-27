// Unzips the source project into sb3/ (project.json plus costume and sound files), and writes src/game/runtime.json:
// which runtime the project was made for and the stage it set, which the engine, transpiler and reference runner follow.
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, process.argv[2] ?? 'game.sb3');
const out = path.join(root, 'sb3');
const zip = await JSZip.loadAsync(fs.readFileSync(src));
fs.mkdirSync(out, { recursive: true });
let n = 0;
for (const [name, entry] of Object.entries(zip.files)) {
  if (entry.dir) continue;
  fs.writeFileSync(path.join(out, path.basename(name)), await entry.async('nodebuffer'));
  n++;
}
console.log(`extracted ${n} files to ${out}`);

// A project saved by the compiling runtime names it in meta.platform, and its settings live in a stage comment that
// ends in "_twconfig_". Older saves have only the comment.
const project = JSON.parse(fs.readFileSync(path.join(out, 'project.json'), 'utf8'));
const stage = project.targets.find((t) => t.isStage);
const comment = Object.values(stage.comments ?? {}).find((c) => typeof c.text === 'string' && c.text.trimEnd().endsWith('_twconfig_'));
const compiled = project.meta?.platform?.name === 'TurboWarp' || !!comment;
let config = {};
if (comment) {
  // The settings are the JSON on the line that ends in the marker, as the original reads them.
  const line = comment.text.split('\n').find((l) => l.endsWith('_twconfig_'));
  config = JSON.parse(line.slice(0, line.lastIndexOf('//')));
}
const runtime = {
  runtime: compiled ? 'turbowarp' : 'vanilla',
  stageWidth: config.width ?? 480,
  stageHeight: config.height ?? 360,
  framerate: config.framerate ?? 30,
};

// The port reproduces the default runtime options only. Anything else changes the simulation and needs engine work.
const problems = [];
if (runtime.framerate !== 30) problems.push(`framerate ${runtime.framerate} (the engine steps at 30 frames per second)`);
const options = config.runtimeOptions ?? {};
if (options.maxClones !== undefined && options.maxClones !== 300) problems.push(`maxClones ${options.maxClones}`);
if (options.miscLimits === false) problems.push('miscLimits off');
if (options.fencing === false) problems.push('fencing off');
if (config.turbo) problems.push('turbo mode');
if (config.interpolation) console.log('note: the project turns on interpolation, which only smooths drawing; the port draws without it');
if (config.hq) console.log('note: the project turns on high quality pen, which only changes how the pen layer is drawn');
fs.writeFileSync(path.join(root, 'src', 'game', 'runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`);
console.log(`runtime ${runtime.runtime}, stage ${runtime.stageWidth}x${runtime.stageHeight}, ${runtime.framerate} frames per second`);
if (problems.length) {
  console.error(`unsupported project settings: ${problems.join(', ')}`);
  process.exitCode = 1;
}
