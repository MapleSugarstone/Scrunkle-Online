import type { Value } from './cast.ts';
import type { ScriptDef } from './defs.ts';
import type { Target } from './target.ts';

export const STATUS_RUNNING = 0;
export const STATUS_PROMISE_WAIT = 1;
export const STATUS_YIELD_TICK = 3;
export const STATUS_DONE = 4;

/** One level of a resumable call stack. Plain data, so snapshots can deep-copy it. */
export interface Frame {
  /** Unit index into the runtime's unit table. */
  u: number;
  /** Resume label inside the unit. */
  pc: number;
  /** Current warp flag of this unit's top level. */
  warp: boolean;
  /** Warp flag of the caller's level, inherited after a promise continuation at this unit's top level. */
  pw: boolean;
  /** Procedure arguments. */
  a: Value[];
  /** Loop counters, wait timers and other per-level state. */
  l: (number | undefined)[];
  /** Label to resume at when a callee finishes through a promise continuation. */
  pcp: number;
  /** Label to resume at when a callee returns through `stop this script`. */
  pcs: number;
  /** Ids of the threads a `broadcast and wait` started, while it waits. */
  w?: number[];
  /** Branches around this unit's pending call, which the original's recursion test counts as block stack entries. */
  cd?: number;
}

/** Marks a frame label that falls off the end of its unit after a promise continuation. */
export const PC_FALL_OFF = -2;

export class Thread {
  id: number;
  target: Target;
  script: ScriptDef;
  status = STATUS_RUNNING;
  isKilled = false;
  frames: Frame[] = [];
  /** A plain-function script that has not run yet. */
  fresh = false;
  /** The script fell off its end through a promise continuation; it finishes on its next step. */
  nullPending = false;
  /** Replaced in the thread list by a restart; nothing it does is observable any more. */
  orphan = false;

  constructor(id: number, target: Target, script: ScriptDef) {
    this.id = id;
    this.target = target;
    this.script = script;
  }

  /** True when the thread has no more work, matching an empty block stack. */
  get stackEmpty(): boolean {
    return !this.fresh && !this.nullPending && this.frames.length === 0;
  }
}

export function newFrame(u: number, warp: boolean, pw: boolean, a: Value[]): Frame {
  return { u, pc: 0, warp, pw, a, l: [], pcp: PC_FALL_OFF, pcs: 0 };
}
