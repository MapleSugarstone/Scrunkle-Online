// What the page keeps between visits so a player's progress survives a reload, and how save codes become files.
import type { Runtime } from '../engine/runtime.ts';
import { toStr, type Value } from '../engine/cast.ts';
import { GAME_TITLE } from './page.ts';

/**
 * The stage lists that hold the player's progress and settings. `!SAVE_DATA` is the whole save, the one the game's
 * save codes hold. The settings and keybinds lists are kept as well, because the settings menu changes them
 * without copying them into `!SAVE_DATA`.
 */
export const SAVE_LISTS = ['!SAVE_DATA', '!Global_GameSettings', '!G_Keybinds'];

/** Stage variables to keep. This game keeps its progress in lists only. */
export const SAVE_VARS: string[] = [];

/** The game asks only for save and art codes, so the question box also takes a text file as the answer. */
export const CODE_ANSWERS = true;

function stageList(rt: Runtime, name: string): { items: Value[]; visible: boolean } | null {
  const prop = rt.stage.sprite.def.listNames?.[name];
  if (prop === undefined) return null;
  return { items: rt.stage.l[prop] ?? [], visible: rt.monitorVisible[prop] ?? false };
}

/**
 * The code the game shows for the player to copy, with a file name for it, or null. Save on the save screen and
 * saving a piece in art mode both put "Copy This Code:" and the code in the shown `Save Code` list. The save screen
 * also shows `!SAVE_DATA`.
 */
export function shownCode(rt: Runtime): { code: string; name: string } | null {
  const list = stageList(rt, 'Save Code');
  if (!list?.visible || list.items.length !== 2 || toStr(list.items[0]) !== 'Copy This Code:') return null;
  const code = toStr(list.items[1]);
  if (!code) return null;
  const save = stageList(rt, '!SAVE_DATA')?.visible ?? false;
  return { code, name: `${GAME_TITLE} ${save ? 'save' : 'art'}.txt` };
}
