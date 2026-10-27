// Keyboard, mouse and text-answer state as the simulation sees it.
import type { Value } from './cast.ts';

const KEY_NAMES = ['space', 'left arrow', 'up arrow', 'right arrow', 'down arrow', 'enter'];

/** Converts a browser `KeyboardEvent.key` to the key name the game uses, or '' for keys it ignores. */
export function browserKeyToName(key: string): string {
  switch (key) {
    case ' ': return 'space';
    case 'ArrowLeft': case 'Left': return 'left arrow';
    case 'ArrowUp': case 'Up': return 'up arrow';
    case 'ArrowRight': case 'Right': return 'right arrow';
    case 'ArrowDown': case 'Down': return 'down arrow';
    case 'Enter': return 'enter';
  }
  if (key.length > 1) return '';
  return key.toUpperCase();
}

/** Normalizes a key argument from game code to a key name. */
export function keyArgToName(arg: Value): string {
  if (typeof arg === 'number') {
    if (arg >= 48 && arg <= 90) return String.fromCharCode(arg);
    switch (arg) {
      case 32: return 'space';
      case 37: return 'left arrow';
      case 38: return 'up arrow';
      case 39: return 'right arrow';
      case 40: return 'down arrow';
    }
  }
  let k = String(arg);
  if (KEY_NAMES.includes(k)) return k;
  if (k.length > 1) k = k[0];
  if (k === ' ') return 'space';
  return k.toUpperCase();
}

/** Input for one player for one frame. */
export interface PlayerInput {
  /** Key names held this frame. */
  keys: string[];
  /** Mouse position in stage coordinates (integers) and button state, if this player drives the mouse. */
  mouse?: { x: number; y: number; down: boolean };
  /** Text submitted to an open question. */
  answer?: string;
  /** Cloud variable values other players set since the last frame, as name and value pairs in arrival order. */
  cloud?: [string, string][];
  /** Stage variables a test sets before the frame runs, by name. The page never sends these. */
  vars?: [string, Value][];
  /** Lists a test replaces before the frame runs, as target name, list id and items. The page never sends these. */
  lists?: [string, string, Value[]][];
}

export class IoState {
  /** Keys held per player slot. Slot 0 is the local keyboard in single-machine play. */
  keys: Set<string>[] = [new Set(), new Set(), new Set(), new Set()];
  /** When true, player rows of the controls table only see their own slot's keys. */
  netMode = false;
  mouseX = 0;
  mouseY = 0;
  mouseDown = false;

  anyKey(): boolean {
    for (const s of this.keys) if (s.size > 0) return true;
    return false;
  }

  keyPressed(arg: Value): boolean {
    if (arg === 'any') return this.anyKey();
    const name = keyArgToName(arg);
    for (const s of this.keys) if (s.has(name)) return true;
    return false;
  }

  /** Key test for one row of the controls table (row 0 is shared, rows 1 to 4 are players). */
  keyPressedForRow(row: number, arg: Value): boolean {
    if (!this.netMode || row < 1 || row > 4) return this.keyPressed(arg);
    if (arg === 'any') return this.keys[row - 1].size > 0;
    return this.keys[row - 1].has(keyArgToName(arg));
  }
}
