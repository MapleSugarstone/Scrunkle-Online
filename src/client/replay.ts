// Match replays. A recording keeps the whole game state from the frame a match starts, then every frame's input
// until the match ends, so playing it back gives the same match. It also keeps a hash of the state every
// 10 seconds, so playback can tell when it no longer matches.
import type { PlayerInput } from '../engine/io.ts';
import type { Runtime } from '../engine/runtime.ts';
import { saveSnapshot, type Snapshot } from '../engine/snapshot.ts';
import { STATUS_DONE } from '../engine/thread.ts';
import { snapshotHash } from '../net/rollback.ts';
import { matchInfo, type MatchView } from '../game/replays.ts';

/** What the Replays screen lists. */
export interface ReplayMeta {
  id: string;
  /** A name the player gave it, shown instead of the fighters. */
  name?: string;
  saved: number;
  mode: string;
  fighters: string[];
  stage: string;
  /** Length in frames. */
  frames: number;
  online: boolean;
  /** Seat names, for online matches. */
  names: string[];
  /** The build fingerprint. A replay plays the same only in the build that saved it. */
  build: string;
}

export interface ReplayBody {
  format: 1;
  /** The runtime's start time, which the date blocks read. */
  t0: number;
  start: Snapshot;
  /** The input for every frame after the start, as [frames, inputs] runs. */
  runs: [number, PlayerInput[]][];
  /** [frames played, state hash] pairs. */
  checks: [number, number][];
}

export type FinishedReplay = { meta: Omit<ReplayMeta, 'id' | 'saved'>; body: ReplayBody };

/** The state the recorder reads after a frame. */
export interface FrameState extends MatchView {
  snapshot(): Snapshot;
}

/** The live runtime's state, for play on one computer. */
export function runtimeState(rt: Runtime): FrameState {
  const def = rt.stage.sprite.def;
  return {
    v: (n) => rt.stage.v[def.varNames?.[n] ?? ''],
    l: (n) => rt.stage.l[def.listNames?.[n] ?? ''] ?? [],
    running: (msg) => rt.threads.some((th) => th.target === rt.stage && th.script.msg === msg && th.status !== STATUS_DONE && !th.isKilled),
    snapshot: () => saveSnapshot(rt),
  };
}

/** A snapshot's state, for online matches, where the confirmed frames are behind the live runtime. */
export function snapshotState(rt: Runtime, s: Snapshot): FrameState {
  const def = rt.stage.sprite.def;
  const index = rt.stage.sprite.index;
  const stage = s.targets.find((t) => t.isOriginal && t.sprite === index)!;
  const scripts = rt.stage.sprite.scripts;
  return {
    v: (n) => stage.v[def.varNames?.[n] ?? ''],
    l: (n) => stage.l[def.listNames?.[n] ?? ''] ?? [],
    running: (msg) => s.threads.some((th) => th.sprite === index && scripts[th.script]?.msg === msg && th.status !== STATUS_DONE && !th.isKilled),
    snapshot: () => s,
  };
}

/** A snapshot that can be stored: its pen commands are copied, because snapshots share the pen array. */
function detached(s: Snapshot): Snapshot {
  return { ...s, penCmds: s.penCmds.slice(0, s.penLength) };
}

const CHECK_EVERY = 300;
/** Matches longer than 30 minutes are not kept. */
const MAX_FRAMES = 30 * 60 * 30;
/** Matches shorter than 10 seconds are not offered. */
const MIN_FRAMES = 300;

interface Recording {
  body: ReplayBody;
  last: string;
  frames: number;
  mode: string;
  fighters: string[];
  stage: string;
}

export class ReplayRecorder {
  /** A match started, so an offer for the last one is out of date. */
  onStart: () => void = () => {};
  /** A match ended and can be saved. */
  onFinish: (r: FinishedReplay) => void = () => {};
  private rec: Recording | null = null;
  private wasMatch = false;

  constructor(
    private rt: Runtime,
    private t0: number,
    private about: { build: string; online: boolean; names: string[] },
  ) {}

  /** Call after every frame, in order, with the inputs that frame used and the state after it. */
  frame(inputs: PlayerInput[], s: FrameState): void {
    const info = matchInfo(this.rt, s);
    const rec = this.rec;
    if (rec) {
      if (!info) {
        this.rec = null;
        if (rec.frames >= MIN_FRAMES) this.finish(rec);
      } else if (rec.frames >= MAX_FRAMES) this.rec = null;
      else this.add(rec, inputs, s);
    } else if (info && !this.wasMatch) {
      this.rec = {
        body: { format: 1, t0: this.t0, start: detached(s.snapshot()), runs: [], checks: [] },
        last: '',
        frames: 0,
        ...info,
      };
      this.onStart();
    }
    this.wasMatch = !!info;
  }

  private add(rec: Recording, inputs: PlayerInput[], s: FrameState): void {
    const text = JSON.stringify(inputs);
    const runs = rec.body.runs;
    if (text === rec.last) runs[runs.length - 1][0]++;
    else {
      runs.push([1, JSON.parse(text) as PlayerInput[]]);
      rec.last = text;
    }
    rec.frames++;
    if (rec.frames % CHECK_EVERY === 0) rec.body.checks.push([rec.frames, snapshotHash(s.snapshot())]);
  }

  private finish(rec: Recording): void {
    this.onFinish({
      meta: { mode: rec.mode, fighters: rec.fighters, stage: rec.stage, frames: rec.frames, ...this.about },
      body: rec.body,
    });
  }
}

/** Every frame's inputs, expanded from the runs. */
export function replayFrames(body: ReplayBody): PlayerInput[][] {
  const out: PlayerInput[][] = [];
  for (const [n, inputs] of body.runs) for (let i = 0; i < n; i++) out.push(inputs);
  return out;
}

/** "Lemon vs Deli". */
export function replayTitle(m: Pick<ReplayMeta, 'fighters'>): string {
  return m.fighters.join(' vs ');
}

/** The player's name for a replay, or its fighters. */
export function replayName(m: ReplayMeta): string {
  return m.name || replayTitle(m);
}

export const REPLAY_NAME_MAX = 60;

/** "2:31" for a number of frames. */
export function clock(frames: number): string {
  const s = Math.floor(frames / 30);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
