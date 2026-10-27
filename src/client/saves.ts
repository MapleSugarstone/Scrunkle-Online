// The player's save, kept in this browser between visits: the stage lists and variables in src/game/saves.ts.
// Offline play loads it before the first frame and writes it back while the game runs. Online games run from the
// project's own data on every machine, so all of them start the same, and they never write a save.
import type { Value } from '../engine/cast.ts';
import type { Runtime } from '../engine/runtime.ts';
import { SAVE_LISTS, SAVE_VARS } from '../game/saves.ts';
import { STORAGE_PREFIX } from '../game/page.ts';

const KEY = `${STORAGE_PREFIX}.save`;
/** How often a running game's save is written, at most. */
const WRITE_EVERY_MS = 2000;

interface SaveFile {
  format: 1;
  lists: Record<string, Value[]>;
  vars: Record<string, Value>;
}

/** Only strings, numbers and booleans go into lists and variables. */
const isValue = (v: unknown): v is Value => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';

function read(): SaveFile | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as SaveFile | null;
    if (!v || v.format !== 1 || typeof v.lists !== 'object' || typeof v.vars !== 'object') return null;
    return v;
  } catch {
    return null;
  }
}

function capture(rt: Runtime): SaveFile {
  const def = rt.stage.sprite.def;
  const lists: Record<string, Value[]> = {};
  for (const name of SAVE_LISTS) {
    const prop = def.listNames?.[name];
    if (prop !== undefined) lists[name] = rt.stage.l[prop].slice();
  }
  const vars: Record<string, Value> = {};
  for (const name of SAVE_VARS) {
    const prop = def.varNames?.[name];
    if (prop !== undefined) vars[name] = rt.stage.v[prop];
  }
  return { format: 1, lists, vars };
}

/** Puts this browser's save into a runtime that has not run a frame yet. Values of the wrong kind are skipped. */
export function loadSave(rt: Runtime): void {
  const save = read();
  if (!save) return;
  const def = rt.stage.sprite.def;
  for (const name of SAVE_LISTS) {
    const prop = def.listNames?.[name];
    const items = save.lists[name];
    if (prop !== undefined && Array.isArray(items) && items.every(isValue)) rt.stage.l[prop].splice(0, Infinity, ...items);
  }
  for (const name of SAVE_VARS) {
    const prop = def.varNames?.[name];
    const v = save.vars[name];
    if (prop !== undefined && isValue(v)) rt.stage.v[prop] = v;
  }
}

/**
 * Keeps writing a running game's save: at most every two seconds while it changes, and when the page is hidden or
 * closed. Returns a function that writes once more and stops.
 */
export function keepSaving(game: () => Runtime): () => void {
  let last = JSON.stringify(capture(game()));
  const flush = () => {
    const text = JSON.stringify(capture(game()));
    if (text === last) return;
    last = text;
    try {
      localStorage.setItem(KEY, text);
    } catch {
      // Storage may be blocked or full.
    }
  };
  const timer = setInterval(flush, WRITE_EVERY_MS);
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);
  return () => {
    flush();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', flush);
  };
}
