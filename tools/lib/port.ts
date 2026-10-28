// Runs the port headless and reports state in the same shape as the reference runner.
import { Runtime } from '../../src/engine/runtime.ts';
import { modules } from '../../src/game/generated/index.ts';
import { skins } from '../../src/game/assets.ts';
import { EFFECT_NAMES, type Target } from '../../src/engine/target.ts';
import { loadSilhouettes } from './silhouettes.ts';
import { pauseRule } from '../../src/game/pause.ts';

export const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

export function createPort(seed: number, tickCap = 8, username = '', t0 = T0): Runtime {
  const rt = new Runtime(modules, skins, { seed, t0, tickCap, pause: pauseRule });
  rt.username = username;
  loadSilhouettes(rt);
  rt.logPen = true;
  return rt;
}

const unsafe = (id: string) =>
  id.replace(/[<>&'"]/g, (c) => ({ '<': 'lt', '>': 'gt', '&': 'amp', "'": 'apos', '"': 'quot' })[c]!);

export function canon(v: unknown): string {
  if (typeof v === 'number') return Object.is(v, -0) ? 'n-0' : `n${v}`;
  if (typeof v === 'string') return `s${JSON.stringify(v)}`;
  if (typeof v === 'boolean') return v ? 'bT' : 'bF';
  if (v === undefined) return 'u';
  if (v === null) return 'z';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `o${JSON.stringify(v)}`;
}

export function hash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface TargetState {
  name: string;
  orig: boolean;
  x: number;
  y: number;
  dir: number;
  size: number;
  costume: number;
  vis: boolean;
  rot: string;
  vol: number;
  fx: number[];
  layer: number;
  vars: Record<string, unknown>;
  lists: Record<string, unknown[]>;
  pen: unknown[] | null;
  snd: unknown[] | null;
}

export interface FullState {
  frame: number;
  ticks: number;
  rng: number;
  rngCalls: number;
  targets: TargetState[];
  threads: unknown[][];
  pen: unknown[];
  sound: unknown[];
  answer: unknown;
}

function targetState(rt: Runtime, t: Target): TargetState {
  const vars: Record<string, unknown> = {};
  const lists: Record<string, unknown[]> = {};
  const d = t.sprite.def;
  for (const [prop, id] of Object.entries(d.varIds)) vars[unsafe(id)] = t.v[prop];
  for (const [prop, id] of Object.entries(d.listIds)) lists[unsafe(id)] = [...t.l[prop]];
  const p = t.pen;
  return {
    name: t.sprite.name,
    orig: t.isOriginal,
    x: t.x,
    y: t.y,
    dir: t.direction,
    size: t.size,
    costume: t.currentCostume,
    vis: t.visible,
    rot: t.rotationStyle,
    vol: t.volume,
    fx: EFFECT_NAMES.map((e) => t.effects[e]),
    layer: t.isStage ? -1 : rt.drawList.indexOf(t),
    vars,
    lists,
    pen: p ? [p.penDown, p.color, p.saturation, p.brightness, p.transparency, p.diameter] : null,
    snd: t.snd ? [t.snd.pitch, t.snd.pan] : null,
  };
}

export function fullState(rt: Runtime): FullState {
  return {
    frame: rt.frame,
    ticks: rt.ticks,
    rng: rt.rng.state,
    rngCalls: rt.rng.calls,
    targets: rt.executable.map((t) => targetState(rt, t)),
    threads: rt.threads.map((th) => [rt.executable.indexOf(th.target), th.script.top, th.status]),
    pen: rt.frameLog.pen,
    sound: rt.frameLog.sound,
    answer: rt.answer,
  };
}

/** Sorts each run of 'end' sound events, whose order between players carries no meaning. */
export function normalizeSound(log: unknown[]): unknown[] {
  const out: unknown[] = [];
  let run: unknown[] = [];
  const flush = () => {
    run.sort((a, b) => canon(a).localeCompare(canon(b)));
    out.push(...run);
    run = [];
  };
  for (const e of log) {
    if (Array.isArray(e) && e[0] === 'end') run.push(e);
    else {
      flush();
      out.push(e);
    }
  }
  flush();
  return out;
}

const sortedEntries = (o: Record<string, unknown>) => Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

export interface Digest {
  frame: number;
  ticks: number;
  rng: number;
  targets: string[];
  threads: string;
  pen: string;
  penCount: number;
  sound: string;
}

export function digest(s: FullState): Digest {
  return {
    frame: s.frame,
    ticks: s.ticks,
    rng: s.rng,
    targets: s.targets.map((t) =>
      hash(canon([t.name, t.orig, t.x, t.y, t.dir, t.size, t.costume, t.vis, t.rot, t.vol, t.fx, t.layer, t.pen, t.snd]) +
        canon(sortedEntries(t.vars)) + canon(sortedEntries(t.lists))),
    ),
    threads: hash(canon(s.threads.map((th) => [th[0], th[1], th[2]]))),
    pen: hash(canon(s.pen)),
    penCount: s.pen.length,
    sound: hash(canon(normalizeSound(s.sound))),
  };
}

export { InputTimeline, type Scenario, type ScenarioEvent } from '../../src/engine/scenario.ts';
