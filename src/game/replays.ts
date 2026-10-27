// Which frames make up a match a replay records, and what the Replays screen calls it.
import { toStr, type Value } from '../engine/cast.ts';
import type { Runtime } from '../engine/runtime.ts';

/** The game's state after one frame, read from the live runtime or from a snapshot of a confirmed online frame. */
export interface MatchView {
  /** A stage variable by its name in the project. */
  v(name: string): Value;
  /** A stage list by its name in the project. */
  l(name: string): Value[];
  /** Whether a stage script started by this broadcast (upper case) is running. */
  running(message: string): boolean;
}

export interface MatchInfo {
  mode: string;
  fighters: string[];
  stage: string;
}

/** The fighters' names, which the Text sprite keeps in a list that never changes. */
function fighterNames(rt: Runtime): Value[] {
  const text = rt.getSpriteTargetByName('Text');
  const prop = text?.sprite.def.listNames?.['!!!names'];
  return (text && prop !== undefined && text.l[prop]) || [];
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

/** The match running in `s`, or null while no match that a replay keeps is running. Training and tutorials are left out. */
export function matchInfo(rt: Runtime, s: MatchView): MatchInfo | null {
  if (!s.running('GAMELOOP')) return null;
  if (toStr(s.v('training?')) === '1' || toStr(s.v('tutorial?')) === '1') return null;
  const story = toStr(s.v('#storybattle?'));
  const mode =
    toStr(s.v('!RosterFight')) === '1' ? 'Roster fight'
    : story === '1' ? 'Story'
    : story === '2' ? 'Tower'
    : story === '3' || story === '4' ? 'Classic'
    : toStr(s.v('AIon?')) === '1' ? 'Against the CPU'
    : 'Versus';
  const names = fighterNames(rt);
  const chars = s.l('!P_Char').slice(0, 2);
  const fighters = chars.map((c) => titleCase(toStr(names[Number(c) - 1] ?? `Fighter ${toStr(c)}`)));
  // The stage list holds a name and a line about the stage for each stage.
  const stage = titleCase(toStr(s.l('#D_StageInfo')[(Number(s.v('stage')) - 1) * 2] ?? ''));
  return { mode, fighters, stage };
}
