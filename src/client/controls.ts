// Each player's own keys, kept in this browser, and the keys the game reads for each seat. The game reads its keys
// from the `!G_Keybinds` list: items 1 to 8 are Player 1's buttons, items 9 to 16 Player 2's, and items 17 and 18
// change the song in menus. Online, each player's presses are translated to their own seat's keys before they are
// sent, so both players can use the same keys.
import { keyArgToName } from '../engine/io.ts';
import type { Value } from '../engine/cast.ts';
import type { Runtime } from '../engine/runtime.ts';
import { STORAGE_PREFIX } from '../game/page.ts';

/** The game's buttons in the order of each player's part of `!G_Keybinds`. */
export const ACTIONS = ['Up', 'Down', 'Left', 'Right', 'Attack', 'Special', 'Shield', 'Pause'];
/** The keys the game starts with for each seat, as the engine names them. */
export const DEFAULT_KEYS: string[][] = [
  ['up arrow', 'down arrow', 'left arrow', 'right arrow', 'N', 'M', 'B', 'V'],
  ['W', 'S', 'A', 'D', 'F', 'G', 'H', 'R'],
];

/**
 * Buttons of the standard controller layout, by button index, and the action each presses. A attacks and selects in
 * menus, B uses a special and goes back, X and Y jump, the shoulders and triggers shield, and Back and Start pause.
 * The D-pad and the left stick move.
 */
export const PAD_BUTTONS: [number, string][] = [
  [0, 'Attack'],
  [1, 'Special'],
  [2, 'Up'],
  [3, 'Up'],
  [4, 'Shield'],
  [5, 'Shield'],
  [6, 'Shield'],
  [7, 'Shield'],
  [8, 'Pause'],
  [9, 'Pause'],
];

/** The touch controls' buttons in place order: the face buttons top, left, right and bottom, then the small one. */
export const DEFAULT_TOUCH_BUTTONS = ['Up', 'Shield', 'Special', 'Attack', 'Pause'];

const KEYBINDS = '!G_Keybinds';
const BUTTONS = ACTIONS.length;
const STORE_KEY = `${STORAGE_PREFIX}.controls`;
const TOUCH_KEY = `${STORAGE_PREFIX}.touchButtons`;

/** The game's key list, which the in-game controls menu edits. */
function keybinds(rt: Runtime): Value[] | undefined {
  const prop = rt.stage.sprite.def.listNames?.[KEYBINDS];
  return prop === undefined ? undefined : rt.stage.l[prop];
}

const keyName = (v: Value | undefined): string => (v === '' || v === undefined ? '' : keyArgToName(v));

/** The keys the game reads for a seat right now, in `ACTIONS` order. */
export function seatKeys(rt: Runtime, seat: number): string[] {
  const list = keybinds(rt);
  if (!list) return DEFAULT_KEYS[seat] ?? [];
  const keys: string[] = [];
  for (let b = 0; b < BUTTONS; b++) keys.push(keyName(list[seat * BUTTONS + b]));
  return keys;
}

/**
 * Replaces each pressed key of the player's own controls with the seat's key for the same button.
 * Other pressed keys pass through, except keys the seat uses, which only count when bound in `own`.
 */
export function translateKeys(pressed: string[], own: string[], seat: string[]): string[] {
  const out = new Set<string>();
  own.forEach((k, i) => {
    if (k && seat[i] && pressed.includes(k)) out.add(seat[i]);
  });
  for (const k of pressed) if (!own.includes(k) && !seat.includes(k)) out.add(k);
  return [...out];
}

/** Makes this player's own keys Player 1's for play on one computer, where the in-game controls menu can still change them. */
export function applyToPlayerOne(rt: Runtime, keys: string[]): void {
  const list = keybinds(rt);
  if (!list) return;
  // The game stores letters in lower case, as its controls menu writes them.
  for (let b = 0; b < BUTTONS; b++) list[b] = keys[b].length === 1 ? keys[b].toLowerCase() : keys[b];
}

/** The keys this player set under Controls, or null when they never set any. */
export function savedControls(): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (Array.isArray(v) && v.length === BUTTONS && v.every((k) => typeof k === 'string')) return v;
  } catch {
    // Storage may be blocked or hold an older format.
  }
  return null;
}

export function loadControls(): string[] {
  return savedControls() ?? [...DEFAULT_KEYS[0]];
}

export function saveControls(keys: string[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(keys));
  } catch {
    // Storage may be blocked.
  }
}

/** Which action each touch button has, from `DEFAULT_TOUCH_BUTTONS` in the player's order. */
export function loadTouchButtons(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TOUCH_KEY) ?? 'null');
    if (Array.isArray(v) && v.length === DEFAULT_TOUCH_BUTTONS.length && DEFAULT_TOUCH_BUTTONS.every((a) => v.includes(a))) return v;
  } catch {
    // Storage may be blocked.
  }
  return [...DEFAULT_TOUCH_BUTTONS];
}

export function saveTouchButtons(buttons: string[]): void {
  try {
    localStorage.setItem(TOUCH_KEY, JSON.stringify(buttons));
  } catch {
    // Storage may be blocked.
  }
}
