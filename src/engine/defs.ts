// Static definitions shared by the runtime and the generated game code.
import type { Value } from './cast.ts';
import type { Target } from './target.ts';
import type { Thread, Frame } from './thread.ts';
import target from '../game/runtime.json';

/**
 * True for a project made for the runtime that compiles scripts to JavaScript, false for the interpreter. Its compiled
 * code differs from the interpreter in a few rules the engine and transpiler follow (src/game/runtime.json, written by
 * tools/extract.mjs).
 */
export const COMPILED = target.runtime === 'turbowarp';

/** The stage size the project was made for, which the original's settings set. */
export const STAGE_W: number = target.stageWidth;
export const STAGE_H: number = target.stageHeight;
/** Half the stage size: the largest x and y on the stage. */
export const STAGE_X = STAGE_W / 2;
export const STAGE_Y = STAGE_H / 2;

/** Rasterization and placement data for one costume image, as the original renderer measured it. */
export interface SkinDef {
  /** Logical width and height in stage units. */
  w: number;
  h: number;
  /** Rotation center in skin space. */
  rcx: number;
  rcy: number;
  kind: 'svg' | 'bitmap';
  file: string;
  /** Pixels per stage unit for bitmaps. */
  res: number;
  /** Largest mip scale the vector rasterizer may use. */
  maxScale: number;
}

export interface CostumeDef {
  name: string;
  skin: number;
}

export interface SoundDef {
  name: string;
  file: string;
  rate: number;
  sampleCount: number;
}

export type HatKind = 'flag' | 'broadcast' | 'clone' | 'key' | 'click' | 'timer';

/** Control codes a resumable unit returns to the thread stepper. */
export enum Ctl {
  /** Suspend until the next tick; the thread stays active. */
  Yield = 0,
  /** Suspend until a promise-style operation resolves between frames. */
  Promise = 1,
  /** A callee frame was pushed; run it now. */
  Call = 2,
  /** The unit finished normally; resume the caller. */
  Return = 3,
  /** `stop this script` inside a procedure; resume the caller at its stop label. */
  StopReturn = 4,
  /** The script finished; the thread is done. */
  End = 5,
  /** Suspend until the next frame; the thread does not count as active (the original's yield-tick). */
  YieldTick = 6,
}

/** A resumable code unit (script body or procedure body) compiled to a state machine. */
export type UnitFn = (th: Thread, f: Frame) => Ctl;

export interface ScriptDef {
  hat: HatKind;
  /** Upper-cased broadcast name for broadcast hats, the key name for key hats, or the measured value for timer hats. */
  msg?: string;
  /** The threshold of a timer hat, as typed in the original. */
  value?: string;
  /** Block id of the hat, for parity reports. */
  top: string;
  /** Scripts that can never suspend run to completion as a plain function. */
  plain?: (t: Target) => void;
  /** Scripts that can suspend start this resumable unit. */
  unit?: number;
}

export interface SpriteDef {
  name: string;
  isStage: boolean;
  layerOrder: number;
  x: number;
  y: number;
  direction: number;
  size: number;
  currentCostume: number;
  visible: boolean;
  rotationStyle: string;
  draggable: boolean;
  volume: number;
  /** Property name to initial value. */
  vars: Record<string, Value>;
  lists: Record<string, Value[]>;
  /** Original variable name to property name, for `(variable) of (sprite)`. */
  varNames?: Record<string, string>;
  /** Property name to the original variable id, for parity reports. */
  varIds: Record<string, string>;
  listIds: Record<string, string>;
  /** Original list name to property name, for TypeScript that reads lists by name. */
  listNames?: Record<string, string>;
  costumes: CostumeDef[];
  sounds: SoundDef[];
  scripts: ScriptDef[];
}

export interface Monitors {
  /** List property name on the stage to visibility and placement. */
  lists: { prop: string; label: string; x: number; y: number; width: number; height: number; visible: boolean }[];
  /** Stage variable property name to label, display mode ('default', 'large' or 'slider'), position and visibility. */
  vars: { prop: string; label: string; mode: string; x: number; y: number; visible: boolean }[];
}
