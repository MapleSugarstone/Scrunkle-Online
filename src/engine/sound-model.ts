// Deterministic model of per-sprite sound playback. It decides when "play until done" finishes;
// the audio output layer only follows its events.
import { pow2 } from './dmath.ts';
import type { Target } from './target.ts';
import type { Thread } from './thread.ts';


export interface SoundEvent {
  kind: 'play' | 'stop' | 'fx';
  sprite: number;
  sound: number;
  /** Simulation time of the event in ms. */
  at: number;
  /** Playback rate at start, or the new rate for 'fx'. */
  rate: number;
  /** Target volume 0..100. */
  volume: number;
  /** Pan -100..100. */
  pan?: number;
  /** Increments with each start of this player, so the output layer can match restarts. */
  serial: number;
}

/** One player per sound of a sprite, shared by all of the sprite's clones. */
export interface PlayerState {
  isPlaying: boolean;
  startingUntil: number;
  /** Buffer time consumed up to `lastT`, in ms. */
  pos: number;
  lastT: number;
  rate: number;
  /** Threads waiting for this player's next stop. */
  waiters: Thread[];
  /** The target that last played this sound. */
  owner: Target | null;
  /** Pitch effect value last applied to this sound's effect chain. */
  pitch: number;
  serial: number;
  /** Rank of this sound's first play among its sprite's sounds, or -1. Stopping all sounds goes in this order. */
  order: number;
}

export function newPlayer(): PlayerState {
  return { isPlaying: false, startingUntil: 0, pos: 0, lastT: 0, rate: 1, waiters: [], owner: null, pitch: 0, serial: 0, order: -1 };
}

export function pitchRatio(pitch: number): number {
  return pow2(pitch / 10 / 12);
}
