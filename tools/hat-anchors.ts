// Finds the head in every fighter costume, for the page's "Actually wear hats" option.
// Each character's Idle costume gives the head: a disc under the point where the hat sits. Every other costume of
// that character is searched for the disc, turned and mirrored, and the hat point and turn follow the best match.
// Usage: npx tsx tools/hat-anchors.ts [--only <character>] [--sheets <dir>]
// --sheets draws every costume with a hat where its match puts it, one image per character. HAT_COSTS=1 prints each
// costume's match cost.
// Writes src/game/hat-anchors.json. Each costume name maps to [x, y, turn, mirrored]: the hat point in costume units
// from the rotation center with y up, the hat's turn in degrees clockwise, and 1 when the head faces the other way.
// Without --only it runs one child process per character, several at once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readPng, writePng, type Image } from './lib/png.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'src/game/hat-anchors.json');
/** Hat height above the fighter's position in the game's own code, before the per-character offset. */
const HAT_BASE = 52;
/** A match costing more than this (mean channel difference, 0 to 1) takes the hat point of a frame from the same move. */
const MAX_COST = 0.3;
/** Coarse search turns, in degrees. */
const COARSE_STEP = 15;
/** Cost added per degree of turn, so a hat stays upright unless the head is clearly tilted. */
const TURN_COST = 0.00015;
/**
 * How far (units) the hat point may move to rest on the head's outline, the band (units each side) it checks, and the
 * share of the band that must be solid. A pole or a glow above a head fills too little of the band to lift the hat.
 */
const SETTLE_MAX = 8;
const SETTLE_BAND = 4;
const SETTLE_FILL = 0.6;
/**
 * How far below the top of the hair the hat point sits, in head radii: the median of the game's own hat points. A
 * game hat point outside the range takes the median instead.
 */
const SINK = 0.45;
const SINK_RANGE = [0.3, 0.7];
/** Hat depth in units for characters whose hat rests on top instead: Frank (24) wears it on his shell. */
const RESTS_ON: Record<string, number> = { '24': 2 };

interface SkinDef { w: number; h: number; rcx: number; rcy: number; kind: string; file: string; res: number }
interface CostumeRef { name: string; skin: number }
const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/game/assets-data.json'), 'utf8')) as { skins: SkinDef[]; costumes: CostumeRef[][] };

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const only = opt('--only');
const sheets = opt('--sheets');
/** A child process writes its entries here instead of to the table. */
const part = opt('--part');

/** Premultiplied RGBA, 0 to 1, at `scale` pixels per costume unit. */
interface Layer { w: number; h: number; px: Float32Array; scale: number }

function premultiply(img: Image, scale: number): Layer {
  const px = new Float32Array(img.w * img.h * 4);
  for (let i = 0; i < img.w * img.h; i++) {
    const a = img.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) px[i * 4 + c] = (img.data[i * 4 + c] / 255) * a;
    px[i * 4 + 3] = a;
  }
  return { w: img.w, h: img.h, px, scale };
}

function half(l: Layer): Layer {
  const w = Math.ceil(l.w / 2), h = Math.ceil(l.h / 2), px = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = x * 2 + dx, sy = y * 2 + dy;
      if (sx >= l.w || sy >= l.h) continue;
      for (let c = 0; c < 4; c++) px[(y * w + x) * 4 + c] += l.px[(sy * l.w + sx) * 4 + c] / 4;
    }
  }
  return { w, h, px, scale: l.scale / 2 };
}

const loadImage = (skin: SkinDef) => readPng(fs.readFileSync(path.join(ROOT, 'public/assets', skin.file)));

/** Costume image layers at 1 and 0.5 pixels per unit, from a bitmap at 2 pixels per unit. */
function pyramid(skin: SkinDef): [Layer, Layer] {
  const l1 = half(premultiply(loadImage(skin), skin.res));
  return [l1, half(l1)];
}

const alphaAt = (l: Layer, x: number, y: number) => (x < 0 || y < 0 || x >= l.w || y >= l.h ? 0 : l.px[(y * l.w + x) * 4 + 3]);

/** The head disc of a reference layer: offsets from its center in pixels (y down) and the pixel values. */
interface Disc { dx: Float32Array; dy: Float32Array; v: Float32Array; n: number; r: number }

function disc(l: Layer, cx: number, cy: number, r: number): Disc {
  const dx: number[] = [], dy: number[] = [], v: number[] = [];
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
    const ox = x + 0.5 - cx, oy = y + 0.5 - cy;
    if (ox * ox + oy * oy > r * r) continue;
    dx.push(ox);
    dy.push(oy);
    for (let c = 0; c < 4; c++) v.push(x < 0 || y < 0 || x >= l.w || y >= l.h ? 0 : l.px[(y * l.w + x) * 4 + c]);
  }
  return { dx: Float32Array.from(dx), dy: Float32Array.from(dy), v: Float32Array.from(v), n: dx.length, r };
}

/** Disc offsets turned clockwise by `turn` degrees after an optional mirror, rounded down to whole pixels. */
function turned(d: Disc, turn: number, mirror: boolean): Int32Array {
  const c = Math.cos((turn * Math.PI) / 180), s = Math.sin((turn * Math.PI) / 180), out = new Int32Array(d.n * 2);
  for (let i = 0; i < d.n; i++) {
    const x = mirror ? -d.dx[i] : d.dx[i], y = d.dy[i];
    out[i * 2] = Math.floor(x * c - y * s);
    out[i * 2 + 1] = Math.floor(x * s + y * c);
  }
  return out;
}

/** Mean channel difference between the disc and the target with the disc centered on pixel (tx, ty); Infinity past `limit`. */
function cost(d: Disc, offs: Int32Array, t: Layer, tx: number, ty: number, limit: number): number {
  const stop = limit * d.n * 4;
  let sum = 0;
  for (let i = 0; i < d.n; i++) {
    const x = tx + offs[i * 2], y = ty + offs[i * 2 + 1], v = i * 4;
    if (x < 0 || y < 0 || x >= t.w || y >= t.h) {
      sum += d.v[v] + d.v[v + 1] + d.v[v + 2] + d.v[v + 3];
    } else {
      const p = (y * t.w + x) * 4;
      sum += Math.abs(d.v[v] - t.px[p]) + Math.abs(d.v[v + 1] - t.px[p + 1]) + Math.abs(d.v[v + 2] - t.px[p + 2]) + Math.abs(d.v[v + 3] - t.px[p + 3]);
    }
    if (sum > stop) return Infinity;
  }
  return sum / (d.n * 4);
}

interface Match { x: number; y: number; turn: number; mirror: boolean; cost: number }

/** A front view matches either way round, so a mirror has to win clearly. */
const MIRROR_COST = 0.01;
const extra = (turn: number, mirror: boolean) => Math.abs(turn) * TURN_COST + (mirror ? MIRROR_COST : 0);

/** The best place for the head disc in a target, as the disc center in level-1 pixels. */
function search(ref: { coarse: Disc; fine: Disc }, [t1, t2]: [Layer, Layer]): Match {
  const seeds: Match[] = [];
  for (const mirror of [false, true]) {
    for (let turn = -180; turn < 180; turn += COARSE_STEP) {
      const offs = turned(ref.coarse, turn, mirror);
      let best: Match = { x: 0, y: 0, turn, mirror, cost: Infinity };
      for (let y = 0; y < t2.h; y++) for (let x = 0; x < t2.w; x++) {
        if (alphaAt(t2, x, y) < 0.5) continue;
        const c = cost(ref.coarse, offs, t2, x, y, best.cost);
        if (c < best.cost) best = { x, y, turn, mirror, cost: c };
      }
      if (best.cost < Infinity) seeds.push(best);
    }
  }
  const ranked = (m: Match) => m.cost + extra(m.turn, m.mirror);
  seeds.sort((a, b) => ranked(a) - ranked(b));
  let best: Match = { x: 0, y: 0, turn: 0, mirror: false, cost: Infinity };
  for (const seed of seeds.slice(0, 6)) {
    let m: Match = { ...seed, x: seed.x * 2, y: seed.y * 2, cost: Infinity };
    let score = Infinity;
    for (const [span, step, reach] of [[12, 3, 3], [2, 1, 1]] as const) {
      const from = m;
      for (let turn = from.turn - span; turn <= from.turn + span; turn += step) {
        const offs = turned(ref.fine, turn, from.mirror);
        const add = extra(turn, from.mirror);
        for (let y = from.y - reach; y <= from.y + reach; y++) for (let x = from.x - reach; x <= from.x + reach; x++) {
          const c = cost(ref.fine, offs, t1, x, y, score - add);
          if (c + add < score) {
            score = c + add;
            m = { x, y, turn, mirror: from.mirror, cost: c };
          }
        }
      }
    }
    if (ranked(m) < ranked(best)) best = m;
  }
  return best;
}

/**
 * How far up from (x, y) the head's outline is, in pixels along `up`: the band across that line is walked up from
 * inside the head, and the outline is its last solid step before a gap. Null when the band is never solid.
 */
function outline(l: Layer, x: number, y: number, ux: number, uy: number): number | null {
  const band = SETTLE_BAND * l.scale;
  let last: number | null = null, gap = 0;
  for (let t = -12 * l.scale; t <= 24 * l.scale; t++) {
    let solid = 0;
    for (let b = -band; b <= band; b++) if (alphaAt(l, Math.round(x + ux * t - uy * b), Math.round(y + uy * t + ux * b)) >= 0.8) solid++;
    if (solid >= SETTLE_FILL * (2 * band + 1)) {
      last = t;
      gap = 0;
    } else if (last !== null && ++gap >= 3) break;
  }
  return last;
}

/** The topmost opaque row in the columns around x, or -1. */
function topAt(l: Layer, x: number, reach: number): number {
  for (let y = 0; y < l.h; y++) for (let dx = -reach; dx <= reach; dx++) if (alphaAt(l, Math.round(x) + dx, y) > 0.5) return y;
  return -1;
}

/** The hat point in a reference layer (pixels, y down): the game's own, or the top of the head when that one misses it. */
function hatPoint(l: Layer, skin: SkinDef, hatY: number): { x: number; y: number; own: boolean } {
  const own = { x: skin.rcx * l.scale, y: (skin.rcy - hatY) * l.scale };
  const top = topAt(l, own.x, 4);
  if (top >= 0 && own.y >= top - 8 && own.y <= top + 20) return { ...own, own: true };
  // The head is the opaque mass in the top 25 units, and the hat sits a little into its middle.
  const first = topAt(l, l.w / 2, Math.ceil(l.w / 2));
  let lo = Infinity, hi = -Infinity;
  for (let y = first; y < Math.min(l.h, first + 25); y++) for (let x = 0; x < l.w; x++) if (alphaAt(l, x, y) > 0.5) {
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  const x = (lo + hi + 1) / 2;
  return { x, y: topAt(l, x, 3) + 3, own: false };
}

/** Half the width of the widest opaque run under the hat point, as the head's radius in pixels. */
function headRadius(l: Layer, x: number, y: number): number {
  let widest = 0;
  for (let row = Math.round(y + 6); row < Math.min(l.h, y + 20); row++) {
    let a = Math.round(x), b = Math.round(x);
    if (alphaAt(l, a, row) < 0.5) continue;
    while (alphaAt(l, a - 1, row) >= 0.5) a--;
    while (alphaAt(l, b + 1, row) >= 0.5) b++;
    widest = Math.max(widest, b - a + 1);
  }
  return Math.min(30, Math.max(12, widest / 2));
}

/** The middle of the head across the rows just under the hat point: the median middle of the opaque run there. */
function headMiddle(l: Layer, x: number, y: number, r: number): number {
  const middles: number[] = [];
  for (let row = Math.round(y); row < Math.min(l.h, y + 0.4 * r); row++) {
    let a = Math.round(x), b = Math.round(x);
    if (alphaAt(l, a, row) < 0.5) continue;
    while (alphaAt(l, a - 1, row) >= 0.5) a--;
    while (alphaAt(l, b + 1, row) >= 0.5) b++;
    middles.push((a + b + 1) / 2);
  }
  middles.sort((a, b) => a - b);
  return middles.length ? middles[middles.length >> 1] : x;
}

/** The hat offsets from the stage's list `#MD_HatOffsets`, by character number. */
function hatOffsets(): string[] {
  const src = fs.readFileSync(path.join(ROOT, 'src/game/generated/Stage_.ts'), 'utf8');
  const m = /^\s*Num_MD_HatOffsets: (\[.*\]),$/m.exec(src);
  if (!m) throw new Error('no #MD_HatOffsets list in Stage_.ts');
  return JSON.parse(m[1]) as string[];
}

/** The sprite that draws the fighters and their hats: the one with both a "1Idle" and a "hat1" costume. */
const list = table.costumes.find((l) => l.some((c) => c.name === '1Idle') && l.some((c) => c.name === 'hat1'));
if (!list) throw new Error('no fighter sprite');
const byChar = new Map<string, CostumeRef[]>();
for (const c of list) {
  const m = /^(\d+)\D/.exec(c.name);
  if (!m || (only && m[1] !== only)) continue;
  if (!byChar.has(m[1])) byChar.set(m[1], []);
  byChar.get(m[1])!.push(c);
}

interface Cell { img: Image; skin: SkinDef; entry: number[]; cost: number; used: boolean }

function anchorsFor(char: string, costumes: CostumeRef[], offsets: string[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const refCostume = costumes.find((c) => c.name === `${char}Idle`);
  if (!refCostume) return out;
  const refSkin = table.skins[refCostume.skin];
  const ref = pyramid(refSkin);
  const p = hatPoint(ref[0], refSkin, HAT_BASE + (Number(offsets[Number(char) - 1]) || 0));
  const r = headRadius(ref[0], p.x, p.y);
  // The hat sits this far below the top of the hair (between the ears), so it rests on the head.
  const top = outline(ref[0], p.x, p.y, 0, -1);
  const hair = top === null ? p.y : p.y - top;
  if (top !== null) p.y = hair + (RESTS_ON[char] ?? (p.own && top >= SINK_RANGE[0] * r && top <= SINK_RANGE[1] * r ? top : SINK * r));
  // The game's hat point is the costume's rotation center, which is off the head's middle in a three-quarter view.
  p.x = headMiddle(ref[0], p.x, p.y, r);
  // The disc holds the head and a little of the air above it.
  const cx = p.x, cy = hair + r * 0.85;
  const discs = { coarse: disc(ref[1], cx / 2, cy / 2, r / 2), fine: disc(ref[0], cx, cy, r) };
  const fromCenter = { x: p.x - cx, y: p.y - cy };
  // Every match keeps the Idle costume's depth below the head's outline.
  const depth = outline(ref[0], p.x, p.y, 0, -1) ?? 0;
  const matched = new Map<string, { entry: number[]; cost: number }>();
  const cells = new Map<string, Cell>();
  for (const c of costumes) {
    const skin = table.skins[c.skin];
    if (skin.kind !== 'bitmap') continue;
    const layers = c === refCostume ? ref : pyramid(skin);
    const m = c === refCostume ? { x: cx, y: cy, turn: 0, mirror: false, cost: 0 } : search(discs, layers);
    const a = (m.turn * Math.PI) / 180, hx = (m.mirror ? -1 : 1) * fromCenter.x, hy = fromCenter.y;
    let px = m.x + hx * Math.cos(a) - hy * Math.sin(a), py = m.y + hx * Math.sin(a) + hy * Math.cos(a);
    const ux = Math.sin(a), uy = -Math.cos(a);
    const edge = outline(layers[0], px, py, ux, uy);
    if (edge !== null) {
      const move = Math.max(-SETTLE_MAX, Math.min(SETTLE_MAX, edge - depth));
      px += ux * move;
      py += uy * move;
    }
    const entry = [round(px - skin.rcx), round(skin.rcy - py), Math.round(((m.turn + 540) % 360) - 180), m.mirror ? 1 : 0];
    matched.set(c.name, { entry, cost: m.cost });
    if (process.env.HAT_COSTS) console.log(`${c.name} ${m.cost.toFixed(3)} ${entry.join(' ')}`);
    if (sheets) cells.set(c.name, { img: loadImage(skin), skin, entry, cost: m.cost, used: true });
  }
  // A frame with no head to find, such as a spin, takes the hat point of the frame from the same move whose name
  // shares the longest start with its own.
  const good = [...matched].filter(([, v]) => v.cost <= MAX_COST);
  const shared = (a: string, b: string) => {
    let n = 0;
    while (n < a.length && a[n] === b[n]) n++;
    return n;
  };
  let used = 0;
  for (const [name, v] of matched) {
    if (v.cost <= MAX_COST) {
      out[name] = v.entry;
      used++;
      continue;
    }
    let pick = refCostume.name, most = char.length + 1;
    for (const [other] of good) if (shared(name, other) > most) [pick, most] = [other, shared(name, other)];
    out[name] = good.length ? (matched.get(pick)?.entry ?? v.entry) : v.entry;
    const cell = cells.get(name);
    if (cell) Object.assign(cell, { entry: out[name], used: false });
  }
  if (sheets) writeSheet(path.resolve(sheets, `${char}.png`), [...cells.values()]);
  console.log(`${char}: ${costumes.length} costumes, ${used} matched; hat point ${p.own ? 'from the game' : 'found'}, head radius ${r.toFixed(1)}`);
  return out;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Every costume with hat 1 drawn where the match puts it, and the match cost as a bar, red when the match is not used. */
function writeSheet(file: string, cells: Cell[]): void {
  const hatSkin = table.skins[list!.find((c) => c.name === 'hat1')!.skin];
  const hat = loadImage(hatSkin);
  const CW = 300, CH = 260, cols = 8;
  const out: Image = { w: CW * cols, h: CH * Math.ceil(cells.length / cols), data: new Uint8Array(0) };
  out.data = new Uint8Array(out.w * out.h * 4).fill(255);
  const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= out.w || y >= out.h || a <= 0) return;
    const i = (y * out.w + x) * 4, k = a / 255;
    out.data[i] = out.data[i] * (1 - k) + r * k;
    out.data[i + 1] = out.data[i + 1] * (1 - k) + g * k;
    out.data[i + 2] = out.data[i + 2] * (1 - k) + b * k;
  };
  cells.forEach((c, k) => {
    const ox = (k % cols) * CW + 10, oy = Math.floor(k / cols) * CH + 30;
    const s = Math.min(1, (CW - 20) / c.img.w, (CH - 40) / c.img.h);
    for (let y = 0; y < c.img.h * s; y++) for (let x = 0; x < c.img.w * s; x++) {
      const i = (Math.floor(y / s) * c.img.w + Math.floor(x / s)) * 4;
      put(ox + x, oy + y, c.img.data[i], c.img.data[i + 1], c.img.data[i + 2], c.img.data[i + 3]);
    }
    // A costume pixel q from the hat point is hat pixel M R(-turn) q.
    const [ux, uy, turn, mirror] = c.entry;
    const res = c.skin.res, px = (ux + c.skin.rcx) * res, py = (c.skin.rcy - uy) * res;
    const a = (turn * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    for (let y = -80; y < 80; y++) for (let x = -80; x < 80; x++) {
      let hx = x * cos + y * sin;
      const hy = -x * sin + y * cos;
      if (mirror) hx = -hx;
      const ix = Math.floor(hx + hatSkin.rcx * hatSkin.res), iy = Math.floor(hy + hatSkin.rcy * hatSkin.res);
      if (ix < 0 || iy < 0 || ix >= hat.w || iy >= hat.h) continue;
      const i = (iy * hat.w + ix) * 4;
      put(ox + (px + x) * s, oy + (py + y) * s, hat.data[i], hat.data[i + 1], hat.data[i + 2], hat.data[i + 3] * 0.85);
    }
    const bar = Math.min(CW - 20, Math.round((c.cost / MAX_COST) * 100));
    for (let x = 0; x < bar; x++) for (let y = 0; y < 6; y++) put(ox + x, oy - 20 + y, c.used ? 40 : 230, c.used ? 160 : 30, 40, 255);
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, writePng(out));
}

/** Runs each character in its own process, several at once, and returns every entry. */
async function runAll(chars: string[]): Promise<Record<string, number[]>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hat-anchors-'));
  const queue = [...chars];
  const result: Record<string, number[]> = {};
  const worker = async () => {
    for (let char = queue.shift(); char !== undefined; char = queue.shift()) {
      const file = path.join(dir, `${char}.json`);
      const childArgs = ['--import', 'tsx', path.join(ROOT, 'tools/hat-anchors.ts'), '--only', char, '--part', file, ...(sheets ? ['--sheets', sheets] : [])];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, childArgs, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`character ${char} failed with code ${code}`))));
      });
      Object.assign(result, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, os.cpus().length - 2) }, worker));
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

const started = Date.now();
let entries: Record<string, number[]>;
if (only) {
  entries = anchorsFor(only, byChar.get(only) ?? [], hatOffsets());
  if (!part) entries = { ...(fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {}), ...entries };
} else {
  entries = await runAll([...byChar.keys()]);
}
if (part) {
  fs.writeFileSync(part, JSON.stringify(entries));
} else {
  // Costume order, so the file changes only where a match does.
  const sorted: Record<string, number[]> = {};
  for (const c of list) if (entries[c.name]) sorted[c.name] = entries[c.name];
  fs.writeFileSync(OUT, `${JSON.stringify(sorted)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${Object.keys(sorted).length} costumes in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
