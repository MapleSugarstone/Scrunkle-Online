// Plays the simulation's sound events through Web Audio. Long sounds (the music) are kept on the
// simulation's clock, so a track ends exactly when the game's "play until done" thinks it does
// and loops without a gap or a cut, even when an online game waits or skips frames.
import type { SoundEvent } from '../engine/sound-model.ts';
import type { Runtime } from '../engine/runtime.ts';

const FADE_S = 0.025;
/** Sounds at least this long follow the simulation clock. */
const FOLLOW_MIN_S = 4;
/** Drift under this is timing noise and is left alone. */
const DEADBAND_S = 0.03;
/** Drift over this is fixed by seeking rather than by playing slightly faster or slower. */
const SEEK_S = 0.35;
/** Playback rate change per second of drift, and the largest change (1% is about a sixth of a semitone). */
const RATE_GAIN = 0.1;
const RATE_MAX = 0.01;
/** Presents in a row without the simulation advancing before following sounds pause. */
const HOLD_AFTER = 3;

interface Voice {
  buffer: AudioBuffer;
  src: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  serial: number;
  volume: number;
  follow: boolean;
  /** Rate the simulation asked for. */
  rate: number;
  /** Buffer position in seconds at simulation time `simAt` (ms). */
  simPos: number;
  simAt: number;
  /** Buffer position in seconds at audio time `realAt`, and the rate actually playing. */
  realPos: number;
  realAt: number;
  playRate: number;
  held: boolean;
}

export class AudioOut {
  ctx: AudioContext;
  private master: GainNode;
  private buffers: (AudioBuffer | null)[][] = [];
  private voices = new Map<string, Voice>();
  private lastSim = -1;
  private still = 0;
  muted = false;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
  }

  private files: string[][] = [];
  private base = '';
  /** Per sound: 0 not requested, 1 queued or loading, 2 loaded. */
  private loadState: Uint8Array[] = [];
  private urgent: [number, number][] = [];
  private background: [number, number][] = [];
  private loading = 0;
  /** One decode per file, because sprites share sound files. */
  private decoded = new Map<string, Promise<AudioBuffer>>();
  /** Play events for sounds that had not loaded yet, by voice key. */
  private pending = new Map<string, SoundEvent>();
  private onProgress?: (done: number, total: number) => void;
  private loaded = 0;
  private total = 0;

  /**
   * Starts loading sounds in the background; the project has over a hundred megabytes of them.
   * A sound the game plays before it arrives loads next. A long one then starts where the game's
   * clock says it should be, and a short one plays only if it is still on time.
   */
  startLoading(rt: Runtime, base: string, onProgress?: (done: number, total: number) => void): void {
    this.base = base;
    this.onProgress = onProgress;
    this.total = rt.sprites.reduce((n, s) => n + s.sounds.length, 0);
    this.files = rt.sprites.map((s) => s.sounds.map((d) => d.file));
    this.buffers = rt.sprites.map((s) => s.sounds.map(() => null));
    this.loadState = rt.sprites.map((s) => new Uint8Array(s.sounds.length));
    // Short sounds load first: the page waits for them, and long ones can start late at the right place.
    this.durations = rt.sprites.map((s) => s.sounds.map((d) => d.sampleCount / d.rate));
    this.background = rt.sprites.flatMap((s, si) => s.sounds.map((_, i) => [si, i] as [number, number]));
    this.background.sort((a, b) => this.durations[a[0]][a[1]] - this.durations[b[0]][b[1]]);
    this.pump();
  }

  private durations: number[][] = [];

  /** Resolves once every sound shorter than `seconds` has loaded or failed. */
  shortLoaded(seconds: number): Promise<void> {
    const ready = () => this.loadState.every((list, si) => list.every((st, i) => st === 2 || this.durations[si][i] >= seconds));
    return ready() ? Promise.resolve() : new Promise((r) => this.waiters.push(() => (ready() ? (r(), true) : false)));
  }

  /** Each returns true once what it waits for has loaded, and is then dropped. */
  private waiters: (() => boolean)[] = [];

  private want(si: number, i: number): void {
    if (!this.loadState[si] || this.loadState[si][i] !== 0) return;
    this.loadState[si][i] = 1;
    this.urgent.push([si, i]);
    this.pump();
  }

  private pump(): void {
    while (this.loading < 6) {
      let job = this.urgent.shift();
      while (!job && this.background.length > 0) {
        const b = this.background.shift()!;
        if (this.loadState[b[0]][b[1]] === 0) {
          this.loadState[b[0]][b[1]] = 1;
          job = b;
        }
      }
      if (!job) return;
      const [si, i] = job;
      const file = this.files[si][i];
      this.loading++;
      let decoded = this.decoded.get(file);
      if (!decoded) {
        decoded = fetch(/^(blob|data|https?):/.test(file) ? file : `${this.base}${file}`)
          .then((res) => res.arrayBuffer())
          .then((data) => this.ctx.decodeAudioData(data));
        this.decoded.set(file, decoded);
      }
      void decoded
        .then((buf) => (this.buffers[si][i] = buf), () => (this.buffers[si][i] = null))
        .finally(() => {
          this.loadState[si][i] = 2;
          this.loading--;
          this.onProgress?.(++this.loaded, this.total);
          this.arrived(si, i);
          this.waiters = this.waiters.filter((w) => !w());
          if (this.loaded === this.total) for (const r of this.done.splice(0)) r();
          this.pump();
        });
    }
  }

  private done: (() => void)[] = [];

  /** Resolves once every sound has loaded or failed. */
  allLoaded(): Promise<void> {
    return this.loaded === this.total ? Promise.resolve() : new Promise((r) => this.done.push(r));
  }

  private arrived(si: number, i: number): void {
    const key = `${si}:${i}`;
    const e = this.pending.get(key);
    const buffer = this.buffers[si][i];
    this.pending.delete(key);
    if (!e || !buffer || this.muted) return;
    const lateMs = Math.max(0, this.lastSim - e.at);
    if (buffer.duration >= FOLLOW_MIN_S) {
      const offset = (lateMs / 1000) * e.rate;
      if (offset < buffer.duration) this.startVoice(key, e, buffer, offset);
    } else if (lateMs <= 150) this.startVoice(key, e, buffer, 0);
  }

  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  setVolume(v: number): void {
    this.master.gain.value = v;
  }

  private tap: MediaStreamAudioDestinationNode | null = null;

  /** Everything the game plays, as a new stream, for recording a video. `endCapture` stops feeding it. */
  capture(): MediaStream {
    this.endCapture();
    this.tap = this.ctx.createMediaStreamDestination();
    this.master.connect(this.tap);
    return this.tap.stream;
  }

  endCapture(): void {
    if (this.tap) this.master.disconnect(this.tap);
    this.tap = null;
  }

  /**
   * Stops every voice and starts the long sounds the simulation says are playing at their current place, as after
   * a replay jumps to another frame. Short sounds that are already playing are left out.
   */
  resync(rt: Runtime): void {
    this.stopAll();
    if (this.muted) return;
    const simMs = rt.currentMSecs;
    rt.players.forEach((list, si) =>
      list.forEach((p, i) => {
        const buffer = this.buffers[si]?.[i];
        if (!p.isPlaying || !buffer || buffer.duration < FOLLOW_MIN_S) return;
        const offset = (p.pos + (simMs - p.lastT) * p.rate) / 1000;
        if (offset < 0 || offset >= buffer.duration) return;
        const e: SoundEvent = { kind: 'play', sprite: si, sound: i, at: simMs, rate: p.rate, volume: p.owner?.volume ?? 100, pan: p.owner?.snd?.pan ?? 0, serial: p.serial };
        this.startVoice(`${si}:${i}`, e, buffer, offset);
        const v = this.voices.get(`${si}:${i}`)!;
        v.simPos = offset;
        v.simAt = simMs;
      }),
    );
  }

  /** Applies queued events and empties the queue. */
  apply(events: SoundEvent[]): void {
    for (const e of events) this.handle(e);
    events.length = 0;
  }

  /** Keeps following sounds on the simulation clock. Call once per presented frame with the simulation time. */
  sync(simMs: number): void {
    const now = this.ctx.currentTime;
    this.still = simMs === this.lastSim ? this.still + 1 : 0;
    this.lastSim = simMs;
    for (const v of this.voices.values()) {
      if (!v.follow) continue;
      if (this.still >= HOLD_AFTER) {
        // The game is waiting (for another player, usually), so the music waits too.
        if (!v.held) this.hold(v, now);
        continue;
      }
      const want = expected(v, simMs);
      if (want >= v.buffer.duration) continue;
      if (v.held) {
        this.restart(v, want, now);
        continue;
      }
      const drift = actual(v, now) - want;
      if (Math.abs(drift) > SEEK_S) this.restart(v, want, now);
      else {
        const factor = Math.abs(drift) < DEADBAND_S ? 1 : 1 - Math.max(-RATE_MAX, Math.min(RATE_MAX, drift * RATE_GAIN));
        setPlayRate(v, v.rate * factor, now);
      }
    }
  }

  private handle(e: SoundEvent): void {
    const key = `${e.sprite}:${e.sound}`;
    const now = this.ctx.currentTime;
    if (e.kind === 'play') {
      this.fadeOut(key, now);
      this.pending.delete(key);
      const buffer = this.buffers[e.sprite]?.[e.sound];
      if (this.muted) return;
      if (!buffer) {
        if (this.loadState[e.sprite]?.[e.sound] !== 2) {
          this.pending.set(key, e);
          this.want(e.sprite, e.sound);
        }
        return;
      }
      this.startVoice(key, e, buffer, 0);
    } else if (e.kind === 'stop') {
      const p = this.pending.get(key);
      if (p && p.serial === e.serial) this.pending.delete(key);
      const v = this.voices.get(key);
      if (v && v.serial === e.serial) this.fadeOut(key, now);
    } else {
      const v = this.voices.get(key);
      if (!v) return;
      v.simPos = expected(v, e.at);
      v.simAt = e.at;
      v.rate = e.rate;
      setPlayRate(v, e.rate, now);
      v.volume = e.volume / 100;
      if (!v.held) v.gain.gain.value = v.volume;
      v.pan.pan.value = (e.pan ?? 0) / 100;
    }
  }

  private startVoice(key: string, e: SoundEvent, buffer: AudioBuffer, offset: number): void {
    const now = this.ctx.currentTime;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = (e.pan ?? 0) / 100;
    pan.connect(this.master);
    const v: Voice = {
      buffer,
      src: null as unknown as AudioBufferSourceNode,
      gain: null as unknown as GainNode,
      pan,
      serial: e.serial,
      volume: e.volume / 100,
      follow: buffer.duration >= FOLLOW_MIN_S,
      rate: e.rate,
      simPos: 0,
      simAt: e.at,
      realPos: 0,
      realAt: now,
      playRate: e.rate,
      held: false,
    };
    this.startSource(v, offset, now, offset > 0);
    this.voices.set(key, v);
  }

  /** Starts the voice's buffer at `offset` seconds through a fresh source and gain. */
  private startSource(v: Voice, offset: number, now: number, fadeIn: boolean): void {
    const src = this.ctx.createBufferSource();
    src.buffer = v.buffer;
    src.playbackRate.value = v.rate;
    const gain = this.ctx.createGain();
    if (fadeIn) {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(v.volume, now + FADE_S);
    } else gain.gain.value = v.volume;
    src.connect(gain).connect(v.pan);
    src.start(now, offset);
    src.onended = () => {
      for (const [k, x] of this.voices) if (x === v && x.src === src && !x.held) this.voices.delete(k);
    };
    v.src = src;
    v.gain = gain;
    v.realPos = offset;
    v.realAt = now;
    v.playRate = v.rate;
  }

  private restart(v: Voice, offset: number, now: number): void {
    const old = { src: v.src, gain: v.gain };
    v.held = false;
    this.startSource(v, offset, now, true);
    fade(old.src, old.gain, now);
  }

  private hold(v: Voice, now: number): void {
    v.held = true;
    fade(v.src, v.gain, now);
  }

  private fadeOut(key: string, now: number): void {
    const v = this.voices.get(key);
    if (!v) return;
    this.voices.delete(key);
    fade(v.src, v.gain, now);
  }

  /** Fades out one sound, used when a correction removes a sound that already started. */
  stopSound(sprite: number, sound: number): void {
    this.fadeOut(`${sprite}:${sound}`, this.ctx.currentTime);
  }

  /** Stops every voice, used when a rollback replaces the timeline. */
  stopAll(): void {
    const now = this.ctx.currentTime;
    this.pending.clear();
    for (const key of [...this.voices.keys()]) this.fadeOut(key, now);
  }
}

function expected(v: Voice, simMs: number): number {
  return v.simPos + ((simMs - v.simAt) / 1000) * v.rate;
}

function actual(v: Voice, now: number): number {
  return v.realPos + (now - v.realAt) * v.playRate;
}

function setPlayRate(v: Voice, rate: number, now: number): void {
  if (Math.abs(rate - v.playRate) < 1e-5) return;
  v.realPos = actual(v, now);
  v.realAt = now;
  v.playRate = rate;
  v.src.playbackRate.value = rate;
}

function fade(src: AudioBufferSourceNode, gain: GainNode, now: number): void {
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(0, now + FADE_S);
  try {
    src.stop(now + FADE_S);
  } catch {
    // already stopped
  }
}
