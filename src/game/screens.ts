// Which screen the game shows. The online key mapping, the touch controls and the tools' summaries read it.
import type { Runtime } from '../engine/runtime.ts';
import type { Target } from '../engine/target.ts';
import { STATUS_DONE } from '../engine/thread.ts';
import { toStr } from '../engine/cast.ts';

function costumeName(t: Target): string {
  return t.sprite.costumes[t.currentCostume]?.name ?? '';
}

function stageVar(rt: Runtime, name: string): string {
  const prop = rt.stage.sprite.def.varNames?.[name];
  return prop === undefined ? '' : toStr(rt.stage.v[prop]);
}

/** True while the stage's match loop ("Gameloop") runs, which it does from a match's start to its end. */
export function inMatch(rt: Runtime): boolean {
  return rt.threads.some((th) => th.target === rt.stage && th.script.msg === 'GAMELOOP' && th.status !== STATUS_DONE && !th.isKilled);
}

/** True on character select, where Player 2's chip follows Player 2's keys. */
export function characterSelect(rt: Runtime): boolean {
  const menu = rt.getSpriteTargetByName('MenuUI');
  return !!menu && menu.sprite.clones.some((c) => c.visible && costumeName(c) === 'p2chip');
}

/** True while a match runs and the game is not paused. */
export function inPlay(rt: Runtime): boolean {
  return inMatch(rt) && stageVar(rt, '?pause') !== '1';
}

/**
 * True on screens where each player's keys belong to their own seat: character select and matches. Elsewhere,
 * including the pause menu, every player's keys count as Player 1's, because menus read only Player 1's keys.
 */
export function seatScreen(rt: Runtime): boolean {
  return inPlay(rt) || characterSelect(rt);
}

/** One line about the game's state for tool output. */
export function describe(rt: Runtime): string {
  const backdrop = rt.stage.sprite.costumes[rt.stage.currentCostume]?.name;
  const shown = [...new Set(rt.drawList.filter((t) => t.visible).map((t) => t.name))];
  const where = inMatch(rt) ? (inPlay(rt) ? 'match' : 'paused') : characterSelect(rt) ? 'select' : 'menu';
  return `backdrop=${backdrop} ${where} shown=[${shown.join(',')}]`;
}
