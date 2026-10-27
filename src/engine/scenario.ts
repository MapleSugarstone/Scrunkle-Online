// Scripted input timelines, used by parity and visual tests.
import type { Value } from './cast.ts';
import type { PlayerInput } from './io.ts';

/**
 * Input events in scenario files. Keys and mouse belong to player slot 0 unless `p` is given. `cloud` is a cloud
 * variable write from another player. `var` sets a stage variable and `list` replaces the items of a list, found by
 * its target's name and the list's id, before the frame, for test setups only.
 */
export type ScenarioEvent =
  | { f: number; type: 'key'; key: string; down: boolean; p?: number }
  | { f: number; type: 'mouse'; x: number; y: number; down?: boolean }
  | { f: number; type: 'answer'; text: string }
  | { f: number; type: 'cloud'; name: string; value: string }
  | { f: number; type: 'var'; name: string; value: Value }
  | { f: number; type: 'list'; target: string; id: string; value: Value[] };

export interface Scenario {
  name: string;
  seed: number;
  frames: number;
  events: ScenarioEvent[];
  /** The player's account name, which saves are tied to. Empty when absent. */
  username?: string;
}

/** Turns scenario events into per-frame player inputs. */
export class InputTimeline {
  private held: Set<string>[] = [new Set(), new Set(), new Set(), new Set()];
  private mouse = { x: 0, y: 0, down: false };
  private byFrame = new Map<number, ScenarioEvent[]>();

  constructor(events: ScenarioEvent[]) {
    for (const e of events) {
      const list = this.byFrame.get(e.f) ?? [];
      list.push(e);
      this.byFrame.set(e.f, list);
    }
  }

  inputsFor(frame: number): PlayerInput[] {
    let answer: string | undefined;
    let mouseChanged = false;
    const cloud: [string, string][] = [];
    const vars: [string, Value][] = [];
    const lists: [string, string, Value[]][] = [];
    for (const e of this.byFrame.get(frame) ?? []) {
      if (e.type === 'key') {
        const s = this.held[e.p ?? 0];
        if (e.down) s.add(e.key);
        else s.delete(e.key);
      } else if (e.type === 'mouse') {
        this.mouse = { x: e.x, y: e.y, down: e.down ?? this.mouse.down };
        mouseChanged = true;
      } else if (e.type === 'cloud') cloud.push([e.name, e.value]);
      else if (e.type === 'var') vars.push([e.name, e.value]);
      else if (e.type === 'list') lists.push([e.target, e.id, e.value]);
      else answer = e.text;
    }
    return this.held.map((s, i) => {
      const inp: PlayerInput = { keys: [...s], mouse: i === 0 && mouseChanged ? { ...this.mouse } : undefined, answer: i === 0 ? answer : undefined };
      if (i === 0 && cloud.length) inp.cloud = cloud;
      if (i === 0 && vars.length) inp.vars = vars;
      if (i === 0 && lists.length) inp.lists = lists;
      return inp;
    });
  }
}
