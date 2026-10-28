// The player's display mode and hat option, kept in the browser. They change only the picture, so online players may differ.
import type { DisplayMode } from '../render/webgl.ts';
import { STORAGE_PREFIX } from '../game/page.ts';

const DISPLAY_KEY = `${STORAGE_PREFIX}.display`;
const HATS_KEY = `${STORAGE_PREFIX}.wearHats`;

/** Whether "Actually wear hats" is on. */
export function loadWearHats(): boolean {
  try {
    return localStorage.getItem(HATS_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveWearHats(on: boolean): void {
  try {
    localStorage.setItem(HATS_KEY, on ? '1' : '0');
  } catch {
    // Storage may be blocked.
  }
}

export const DISPLAY_MODES: DisplayMode[] = ['smooth', 'flash', 'handheld'];

export const DISPLAY_NAMES: Record<DisplayMode, string> = {
  smooth: 'Smooth',
  flash: 'Old flash game',
  handheld: 'Handheld',
};

export function loadDisplay(): DisplayMode {
  try {
    const v = localStorage.getItem(DISPLAY_KEY);
    if (DISPLAY_MODES.includes(v as DisplayMode)) return v as DisplayMode;
  } catch {
    // Storage may be blocked.
  }
  return 'smooth';
}

export function saveDisplay(mode: DisplayMode): void {
  try {
    localStorage.setItem(DISPLAY_KEY, mode);
  } catch {
    // Storage may be blocked.
  }
}

export function nextDisplay(mode: DisplayMode): DisplayMode {
  return DISPLAY_MODES[(DISPLAY_MODES.indexOf(mode) + 1) % DISPLAY_MODES.length];
}
