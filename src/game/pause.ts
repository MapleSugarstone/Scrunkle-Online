// The game pauses itself when Player 1 presses their Pause key, so the port adds no pause menu of its own.
import type { PauseRule } from '../engine/runtime.ts';

export const pauseRule: PauseRule | undefined = undefined;
