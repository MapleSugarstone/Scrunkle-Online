// The game runtime: targets, clones, the thread scheduler, broadcasts, pen and sound models.
// Every rule here mirrors the original block runtime closely enough that the same inputs
// produce the same state frame by frame.
import { type Value, compare, toNumber, toStr, isInt, clamp, setListRandom } from './cast.ts';
import { COMPILED, Ctl, STAGE_H, STAGE_W, STAGE_X, STAGE_Y, type HatKind, type ScriptDef, type SkinDef, type SpriteDef, type UnitFn } from './defs.ts';
import { IoState, type PlayerInput } from './io.ts';
import { RenderModel, type Rect } from './render-model.ts';
import { Rng } from './rng.ts';
import { newPlayer, pitchRatio, type PlayerState, type SoundEvent } from './sound-model.ts';
import { Sprite, Target, type PenState, type Effects, type EffectName } from './target.ts';
import { Thread, newFrame, type Frame, STATUS_RUNNING, STATUS_PROMISE_WAIT, STATUS_YIELD_TICK, STATUS_DONE, PC_FALL_OFF } from './thread.ts';
import { atan2, cos, sin } from './dmath.ts';
import { keyArgToName } from './io.ts';

/**
 * Time between frames, both on the simulation clock and in real time. The original steps from an
 * interval of 1000 / 30 ms, which browsers truncate to 33, and its timer reads real time, so its
 * frames are 33 ms apart in both senses.
 */
export const FRAME_MS = 33;
const MAX_CLONES = 300;
const DECAY_MS = 25;

/** Thrown to abandon the current thread after it deleted its own clone. */
export const KILLED = { killed: true };

/** A color to paint a sprite in: red, green and blue from 0 to 1, then the strength from 0 to 1. */
export type Tint = readonly [number, number, number, number];

export type PenCmd =
  | { op: 'stamp'; skin: number; x: number; y: number; sx: number; sy: number; dir: number; fx: Effects; tint?: Tint; clip?: Rect }
  | { op: 'line'; c4: [number, number, number, number]; d: number; x0: number; y0: number; x1: number; y1: number; point: boolean };

export interface PenLayer {
  /** Commands drawn since the last clear. Never mutated except by appending; a clear starts a new array. */
  cmds: PenCmd[];
  /** Bumped on every clear. */
  gen: number;
}

export interface Question {
  text: string;
  thread: Thread;
  target: Target;
}

/** Per-sprite module produced by the code generator. */
export interface SpriteModule {
  def: SpriteDef;
  build: (rt: Runtime) => { scripts: ScriptDef[] };
}

export interface RuntimeOptions {
  seed: number;
  /** Simulation start time in ms since the epoch; also the base of the "current date" sensing block. */
  t0: number;
  tickCap?: number;
  pause?: PauseRule;
}

/**
 * A pause menu the original lacks, driven by ordinary key input so every player's simulation pauses on the
 * same frame. While paused no scripts run and the game clock stands still.
 */
export interface PauseRule {
  /** Pressing this key toggles the pause when `canPause` allows it. */
  pauseKey: string;
  /** Pressing this key while paused resumes and calls `quit`. */
  quitKey: string;
  /** What the quit button says, such as "Character select". */
  quitLabel: string;
  canPause(rt: Runtime): boolean;
  quit(rt: Runtime): void;
}

export class Runtime {
  // ---------------------------------------------------------------- static data
  sprites: Sprite[] = [];
  units: UnitFn[] = [];
  unitNames: string[] = [];
  render: RenderModel;

  // ---------------------------------------------------------------- state
  stage!: Target;
  targets: Target[] = [];
  executable: Target[] = [];
  /** Sprite layer group of the draw list, back to front. */
  drawList: Target[] = [];
  penCreated = false;
  threads: Thread[] = [];
  activeThread: Thread | null = null;
  frame = 0;
  t0: number;
  currentMSecs: number;
  timerStart: number;
  redrawRequested = false;
  tickCap: number;
  ticks = 0;
  capHits = 0;
  cloneCount = 0;
  nextTargetId = 1;
  nextThreadId = 1;
  rng: Rng;
  io = new IoState();
  answer = '';
  questions: Question[] = [];
  pen: PenLayer = { cmds: [], gen: 0 };
  /** Bumped when a snapshot is loaded, so the renderer redraws the whole pen layer. */
  penEpoch = 0;
  players: PlayerState[][] = [];
  /** Threads whose promise-style wait resolves at the start of the next frame. */
  pending: Thread[] = [];
  monitorVisible: Record<string, boolean> = {};
  pauseRule: PauseRule | null;
  /** Whether the pause menu is open; see `PauseRule`. */
  paused = false;
  /** Frames spent paused, which the game clock leaves out. */
  pausedFrames = 0;

  /** For tools: every thread step in a frame range as frame, tick, sprite, hat block id and status after the step. */
  trace: { from: number; to: number; log: unknown[][]; state?: () => unknown } | null = null;

  /** Per-frame logs for parity reports and the audio output layer. */
  frameLog: { pen: unknown[]; sound: unknown[] } = { pen: [], sound: [] };
  soundEvents: SoundEvent[] = [];
  logPen = false;

  constructor(modules: SpriteModule[], skins: SkinDef[], opts: RuntimeOptions) {
    this.render = new RenderModel(skins);
    this.rng = new Rng(opts.seed);
    this.t0 = opts.t0;
    this.currentMSecs = opts.t0;
    this.timerStart = opts.t0;
    this.tickCap = opts.tickCap ?? 8;
    this.pauseRule = opts.pause ?? null;
    setListRandom(() => this.rng.next());

    modules.forEach((m, i) => {
      const sprite = new Sprite(m.def, i);
      this.sprites.push(sprite);
    });
    this.players = this.sprites.map((s) => s.sounds.map(() => newPlayer()));

    // Targets in pane order; execution and draw order follow the saved layer order.
    for (const sprite of this.sprites) {
      const t = this.makeOriginal(sprite);
      this.targets.push(t);
      if (sprite.def.isStage) this.stage = t;
    }
    const byLayer = [...this.targets].sort((a, b) => a.sprite.def.layerOrder - b.sprite.def.layerOrder);
    this.executable = byLayer;
    this.drawList = byLayer.filter((t) => !t.isStage);

    modules.forEach((m, i) => {
      const { scripts } = m.build(this);
      this.sprites[i].setScripts(scripts);
    });
  }

  /** The procedure each unit runs, or null for a script, by unit index. */
  unitProcs: (string | null)[] = [];

  /** Registers a resumable unit; generated modules call this while building. */
  unit(name: string, proc: string | null, fn: UnitFn): number {
    this.units.push(fn);
    this.unitNames.push(name);
    this.unitProcs.push(proc);
    return this.units.length - 1;
  }

  private makeOriginal(sprite: Sprite): Target {
    const d = sprite.def;
    const t = new Target(this, sprite, this.nextTargetId++, true);
    t.x = d.x;
    t.y = d.y;
    t.direction = d.direction;
    t.size = d.size;
    t.currentCostume = d.currentCostume;
    t.visible = d.visible;
    t.rotationStyle = d.rotationStyle;
    t.draggable = d.draggable;
    t.volume = d.volume;
    t.updateDrawPosition(t.x, t.y);
    t.v = { ...d.vars };
    t.l = {};
    for (const k of Object.keys(d.lists)) t.l[k] = sprite.fixedLists.has(k) ? Object.freeze(d.lists[k].slice()) : d.lists[k].slice();
    sprite.clones.push(t);
    sprite.original = t;
    return t;
  }

  random(): number {
    return this.rng.next();
  }

  // ---------------------------------------------------------------- frame loop

  /** Runs one frame with the given per-player inputs. */
  stepFrame(inputs: PlayerInput[]): void {
    this.frame++;
    this.frameLog = { pen: [], sound: [] };
    this.cloudOut = [];
    if (this.pauseRule && this.updatePause(this.pauseRule, inputs)) {
      this.pausedFrames++;
      // Keys held during the pause are not new presses when it ends.
      for (let p = 0; p < 4; p++) {
        this.io.keys[p].clear();
        for (const k of inputs[p]?.keys ?? []) this.io.keys[p].add(k);
      }
      return;
    }
    const lastMSecs = this.currentMSecs;
    this.currentMSecs = this.t0 + (this.frame - this.pausedFrames) * FRAME_MS;
    this.checkSoundEnds();
    this.resolvePending();
    this.applyInputs(inputs);
    this.threads = this.threads.filter((th) => !th.isKilled);
    this.startTimerHats(lastMSecs);
    this.redrawRequested = false;
    this.stepThreads();
    // Promise-style waits settle between frames, right after the frame that started them.
    this.resolvePending();
  }

  /** Applies this frame's pause and quit presses; true while the game stays paused. */
  private updatePause(rule: PauseRule, inputs: PlayerInput[]): boolean {
    const pressed = (key: string) => inputs.some((inp, p) => inp?.keys.includes(key) && !this.io.keys[p].has(key));
    if (this.paused && pressed(rule.quitKey)) {
      this.paused = false;
      rule.quit(this);
    } else if (pressed(rule.pauseKey) && (this.paused || rule.canPause(this))) this.paused = !this.paused;
    return this.paused;
  }

  applyInputs(inputs: PlayerInput[]): void {
    for (let p = 0; p < 4; p++) {
      const inp = inputs[p];
      const set = this.io.keys[p];
      const before = new Set(set);
      set.clear();
      if (!inp) continue;
      for (const k of inp.keys) {
        set.add(k);
        if (!before.has(k)) this.keyDown(k);
      }
      if (inp.mouse) {
        const wasDown = this.io.mouseDown;
        // The original clamps the pointer to the stage edges, and its y works out to -0 at the vertical center.
        this.io.mouseX = clamp(inp.mouse.x, -STAGE_X, STAGE_X);
        const y = clamp(inp.mouse.y, -STAGE_Y, STAGE_Y);
        this.io.mouseY = y === 0 ? -0 : y;
        this.io.mouseDown = inp.mouse.down;
        if (wasDown !== inp.mouse.down) this.mouseButton(inp.mouse.down);
      }
    }
    for (let p = 0; p < 4; p++) {
      const a = inputs[p]?.answer;
      if (a !== undefined) this.submitAnswer(a);
    }
    for (const [name, value] of inputs[0]?.cloud ?? []) this.cloudReceive(name, value);
    for (const [name, value] of inputs[0]?.vars ?? []) this.cloudReceive(name, value);
    for (const [target, id, items] of inputs[0]?.lists ?? []) {
      const t = target === 'Stage' ? this.stage : this.getSpriteTargetByName(target);
      const prop = t && Object.entries(t.sprite.def.listIds).find(([, v]) => v === id)?.[0];
      // A new array, because snapshots may share the old one.
      if (t && prop) t.l[prop] = t.sprite.fixedLists.has(prop) ? Object.freeze([...items]) : [...items];
    }
  }

  /**
   * Click hats, as the original's mouse handler starts them: for the sprite the renderer picks under the pointer,
   * on the press for a sprite that is not draggable and on the release for one that is. Clicks off the stage do nothing.
   */
  private mouseButton(down: boolean): void {
    const x = this.io.mouseX, y = this.io.mouseY;
    if (!(x > -STAGE_X && x < STAGE_X && y > -STAGE_Y && y < STAGE_Y)) return;
    const t = this.pickTarget(x, y);
    if (t.draggable ? !down : down) this.startHats('click', null, t);
  }

  /** The renderer's pick: the topmost shown, not fully ghosted sprite whose mask covers the point, else the stage. */
  private pickTarget(x: number, y: number): Target {
    for (let i = this.drawList.length - 1; i >= 0; i--) {
      const t = this.drawList[i];
      if (!t.visible || t.effects.ghost >= 100) continue;
      const b = this.render.fastBounds(t);
      if (x < b.left || x > b.right || y < b.bottom || y > b.top) continue;
      if (this.render.touchingPoint(t, x, y)) return t;
    }
    return this.stage;
  }

  /** `reset timer`. */
  resetTimer(): void {
    this.timerStart = this.currentMSecs;
  }

  /** The original starts key hats for the key and for "any" on every key-down event. */
  private keyDown(name: string): void {
    this.startHats('key', keyArgToName(name).toUpperCase());
    this.startHats('key', 'ANY');
  }

  greenFlag(): void {
    this.stopAll();
    this.answer = '';
    for (const t of this.targets) this.clearSoundEffects(t);
    this.timerStart = this.currentMSecs;
    for (const t of this.targets) t.edgeValues.clear();
    for (const t of this.targets) t.clearEffects();
    this.startHats('flag', null);
  }

  /**
   * Timer hats, which the original starts at the start of every frame and tests at once. A hat whose script is
   * still running is skipped. A test that is not newly true retires its thread before any thread steps.
   * The original tests them before it advances its clock, so the test reads the previous frame's time.
   */
  private startTimerHats(lastMSecs: number): void {
    for (let i = this.executable.length - 1; i >= 0; i--) {
      const t = this.executable[i];
      for (const s of t.sprite.timerScripts) {
        const si = t.sprite.scriptIndex.get(s)!;
        const existing = t.scriptThreads[si];
        if (existing && existing.status !== STATUS_DONE) continue;
        const th = this.pushThread(t, s, si);
        const value = (lastMSecs - this.timerStart) / 1000 > toNumber(s.value);
        const had = t.edgeValues.has(s.top);
        const old = t.edgeValues.get(s.top);
        t.edgeValues.set(s.top, value);
        if (had ? !old && value : value) continue;
        th.fresh = false;
        th.frames.length = 0;
        th.status = STATUS_DONE;
      }
    }
  }

  // ---------------------------------------------------------------- cloud variables

  /** Cloud variable values this simulation set during the frame, for the page to send. */
  cloudOut: [string, string][] = [];

  /** Records a cloud variable's new value after a set or change block. */
  cloudSet(name: string, value: Value): void {
    this.cloudOut.push([name, toStr(value)]);
  }

  /** Sets a stage variable by name, as a cloud message from another player does when it arrives. */
  private cloudReceive(name: string, value: Value): void {
    const prop = this.stage.sprite.def.varNames?.[name];
    if (prop !== undefined) this.stage.v[prop] = value;
  }

  stopAll(): void {
    this.stopAllSounds();
    for (const t of this.targets) this.clearSoundEffects(t);
    this.questions = [];
    const keep: Target[] = [];
    for (const t of this.targets) {
      t.clearEffects();
      if (!t.isOriginal) this.disposeTarget(t);
      else keep.push(t);
    }
    this.targets = keep;
    if (this.activeThread) this.stopThread(this.activeThread);
    for (const th of this.threads) this.forgetThread(th);
    this.threads = [];
  }

  requestRedraw(): void {
    this.redrawRequested = true;
  }

  timer(): number {
    return (this.currentMSecs - this.timerStart) / 1000;
  }

  // ---------------------------------------------------------------- scheduler

  stepThreads(): void {
    let numActive = Infinity;
    let ranFirstTick = false;
    this.ticks = 0;
    while (this.threads.length > 0 && numActive > 0 && this.ticks < this.tickCap && !this.redrawRequested) {
      this.ticks++;
      numActive = 0;
      let stopped = false;
      const threads = this.threads;
      for (let i = 0; i < threads.length; i++) {
        const th = (this.activeThread = threads[i]);
        if (th.stackEmpty || th.status === STATUS_DONE) {
          stopped = true;
          continue;
        }
        if (th.status === STATUS_YIELD_TICK && !ranFirstTick) th.status = STATUS_RUNNING;
        if (th.status === STATUS_RUNNING) {
          this.stepThread(th);
          if (this.trace && this.frame >= this.trace.from && this.frame <= this.trace.to) this.trace.log.push([this.frame, this.ticks, th.target.sprite.name, th.script.top, th.status, ...(this.trace.state ? [this.trace.state()] : [])]);
          if (th.isKilled) i--;
        }
        if (th.status === STATUS_RUNNING) numActive++;
        if (th.stackEmpty || th.status === STATUS_DONE) stopped = true;
      }
      ranFirstTick = true;
      if (stopped) {
        let next = 0;
        for (let i = 0; i < this.threads.length; i++) {
          const th = this.threads[i];
          if (!th.stackEmpty && th.status !== STATUS_DONE) this.threads[next++] = th;
          else this.forgetThread(th);
        }
        this.threads.length = next;
      }
    }
    if (this.ticks >= this.tickCap && this.threads.length > 0 && numActive > 0 && !this.redrawRequested) this.capHits++;
    this.activeThread = null;
  }

  private stepThread(th: Thread): void {
    if (th.nullPending) {
      th.nullPending = false;
      th.status = STATUS_DONE;
      return;
    }
    if (th.fresh) {
      th.fresh = false;
      try {
        th.script.plain!(th.target);
      } catch (e) {
        if (e !== KILLED) throw e;
        return;
      }
      th.status = STATUS_DONE;
      return;
    }
    const frames = th.frames;
    for (;;) {
      const f = frames[frames.length - 1];
      if (f === undefined) {
        th.status = STATUS_DONE;
        return;
      }
      let c: Ctl;
      try {
        c = this.units[f.u](th, f);
      } catch (e) {
        if (e !== KILLED) throw e;
        return;
      }
      switch (c) {
        case Ctl.Yield:
          return;
        case Ctl.YieldTick:
          th.status = STATUS_YIELD_TICK;
          return;
        case Ctl.Promise:
          th.status = STATUS_PROMISE_WAIT;
          return;
        case Ctl.Call:
          continue;
        case Ctl.Return:
          frames.pop();
          continue;
        case Ctl.StopReturn: {
          frames.pop();
          const top = frames[frames.length - 1];
          if (top) top.pc = top.pcs;
          continue;
        }
        case Ctl.End:
          frames.length = 0;
          th.status = STATUS_DONE;
          return;
      }
    }
  }

  /**
   * Pushes a callee frame from resumable code. `pc`, `pcp` and `pcs` are the caller's resume labels, and `depth`
   * is the number of branches around the call inside the caller. A non-warp call yields before the callee starts when
   * the original's recursion test says so.
   */
  call(th: Thread, f: Frame, unit: number, args: Value[], warp: boolean, pc: number, pcp: number, pcs: number, depth = 0): Ctl {
    f.pc = pc;
    f.pcp = pcp;
    f.pcs = pcs;
    f.cd = depth;
    const proc = this.unitProcs[unit];
    const recursive = COMPILED
      ? // The compiled code yields before a non-warp custom block calls itself directly, and on no other call.
        !f.warp && proc !== null && proc === this.unitProcs[f.u]
      : !warp && this.isRecursiveCall(th, proc, depth);
    th.frames.push(newFrame(unit, warp, f.warp, args));
    return recursive ? Ctl.Yield : Ctl.Call;
  }

  /**
   * The interpreter's test: whether one of the 6 block stack entries below the call is a call to the same procedure.
   * Each branch around a call holds one entry, and each frame below holds the call block that started the frame above.
   */
  private isRecursiveCall(th: Thread, proc: string | null, depth: number): boolean {
    if (proc === null) return false;
    let left = 6 - depth;
    for (let i = th.frames.length - 1; i >= 1 && left > 0; i--) {
      if (this.unitProcs[th.frames[i].u] === proc) return true;
      left -= 1 + (th.frames[i - 1].cd ?? 0);
    }
    return false;
  }

  /** Suspends the thread until the next frame starts (promise-style blocks). */
  suspend(th: Thread): Ctl {
    this.pending.push(th);
    return Ctl.Promise;
  }

  private resolvePending(): void {
    const list = this.pending;
    this.pending = [];
    for (const th of list) this.resolveThread(th);
  }

  /** Applies a promise continuation: the thread resumes at the label its top frame set when it suspended. */
  private resolveThread(th: Thread): void {
    if (th.isKilled || th.orphan) return;
    th.status = STATUS_RUNNING;
    const frames = th.frames;
    for (;;) {
      const f = frames[frames.length - 1];
      if (!f) {
        th.nullPending = true;
        return;
      }
      if (f.pc !== PC_FALL_OFF) return;
      frames.pop();
      const caller = frames[frames.length - 1];
      if (!caller) {
        th.nullPending = true;
        return;
      }
      caller.pc = caller.pcp;
    }
  }

  // ---------------------------------------------------------------- hats and broadcasts

  /** Broadcast and key hat names any sprite listens for, by kind, made on first use. */
  private listened: Record<'broadcast' | 'key', Set<string>> | null = null;

  startHats(kind: HatKind, msg: string | null, optTarget?: Target): Thread[] {
    const started: Thread[] = [];
    if (kind === 'broadcast' || kind === 'key') {
      this.listened ??= {
        broadcast: new Set(this.sprites.flatMap((s) => [...s.broadcastScripts.keys()])),
        key: new Set(this.sprites.flatMap((s) => [...s.keyScripts.keys()])),
      };
      if (!this.listened[kind].has(msg!)) return started;
    }
    const targets = optTarget ? [optTarget] : this.executable;
    for (let i = targets.length - 1; i >= 0; i--) {
      const t = targets[i];
      const sprite = t.sprite;
      const scripts = kind === 'broadcast' ? sprite.broadcastScripts.get(msg!) : kind === 'key' ? sprite.keyScripts.get(msg!) : kind === 'flag' ? sprite.flagScripts : kind === 'click' ? sprite.clickScripts : sprite.cloneScripts;
      if (!scripts) continue;
      for (const s of scripts) {
        const si = sprite.scriptIndex.get(s)!;
        const existing = t.scriptThreads[si];
        if (kind === 'clone' || kind === 'key') {
          if (existing && existing.status !== STATUS_DONE) continue;
          started.push(this.pushThread(t, s, si));
        } else if (existing) {
          started.push(this.restartThread(existing, si));
        } else {
          started.push(this.pushThread(t, s, si));
        }
      }
    }
    return started;
  }

  broadcast(msg: string): void {
    this.startHats('broadcast', msg.toUpperCase());
  }

  /** `broadcast and wait`, first step: the ids of the threads started, or null when none started. */
  broadcastStart(msg: Value): number[] | null {
    const started = this.startHats('broadcast', toStr(msg).toUpperCase());
    return started.length ? started.map((th) => th.id) : null;
  }

  /** `broadcast and wait`, each step: how to yield while a started thread is still in the list, or null when done. */
  broadcastWait(ids: number[]): Ctl | null {
    const live = ids.map((id) => this.threads.find((th) => th.id === id));
    if (!live.some((th) => th !== undefined)) return null;
    const waiting = (th: Thread | undefined) => !th || th.status === STATUS_PROMISE_WAIT || th.status === STATUS_YIELD_TICK || th.stackEmpty || th.status === STATUS_DONE;
    return live.every(waiting) ? Ctl.YieldTick : Ctl.Yield;
  }

  private initThread(th: Thread): void {
    const s = th.script;
    if (s.plain) th.fresh = true;
    else th.frames.push(newFrame(s.unit!, false, false, []));
  }

  private pushThread(t: Target, s: ScriptDef, si: number): Thread {
    const th = new Thread(this.nextThreadId++, t, s);
    this.initThread(th);
    this.threads.push(th);
    t.scriptThreads[si] = th;
    return th;
  }

  private restartThread(old: Thread, si: number): Thread {
    const th = new Thread(this.nextThreadId++, old.target, old.script);
    this.initThread(th);
    const i = this.threads.indexOf(old);
    old.orphan = true;
    this.threads[i] = th;
    old.target.scriptThreads[si] = th;
    return th;
  }

  private forgetThread(th: Thread): void {
    const si = th.target.sprite.scriptIndex.get(th.script)!;
    if (th.target.scriptThreads[si] === th) th.target.scriptThreads[si] = undefined;
  }

  private stopThread(th: Thread): void {
    th.isKilled = true;
    th.fresh = false;
    th.nullPending = false;
    th.frames.length = 0;
    th.status = STATUS_DONE;
  }

  stopForTarget(t: Target, except: Thread | null): void {
    // Listeners run first: waiting sounds stop, questions from this target are dropped.
    for (const idx of t.waitingSounds) {
      const p = this.players[t.sprite.index][idx];
      if (p.owner === t) this.stopPlayer(t.sprite.index, idx);
    }
    t.waitingSounds.clear();
    this.questions = this.questions.filter((q) => q.target !== t);
    for (let i = 0; i < this.threads.length; i++) {
      const th = this.threads[i];
      if (th === except) continue;
      if (th.target === t) this.stopThread(th);
    }
  }

  stopOtherScripts(t: Target, th: Thread | null): void {
    this.stopForTarget(t, th);
  }

  // ---------------------------------------------------------------- targets, clones and layers

  getSpriteTargetByName(name: string): Target | undefined {
    for (const t of this.targets) {
      if (!t.isStage && t.sprite.name === name) return t;
    }
    return undefined;
  }

  private spriteGroupOffset(): number {
    return 1 + (this.penCreated ? 1 : 0);
  }

  drawIndex(t: Target): number {
    if (t.isStage) return 0;
    return this.spriteGroupOffset() + this.drawList.indexOf(t);
  }

  setDrawableOrder(t: Target, order: number, isRelative: boolean, optMin?: number): number | null {
    const start = this.spriteGroupOffset();
    const end = start + this.drawList.length;
    const oldLocal = this.drawList.indexOf(t);
    if (oldLocal < 0) return null;
    const oldIndex = start + oldLocal;
    if (order === 0) return oldIndex;
    this.drawList.splice(oldLocal, 1);
    let newIndex = order;
    if (isRelative) newIndex += oldIndex;
    const possibleMin = (optMin || 0) + start;
    const min = possibleMin >= start && possibleMin < end ? possibleMin : start;
    newIndex = Math.max(newIndex, min);
    newIndex = Math.min(newIndex, end);
    this.drawList.splice(newIndex - start, 0, t);
    return newIndex;
  }

  moveExecutable(t: Target, delta: number): number {
    const ex = this.executable;
    const oldIndex = ex.indexOf(t);
    ex.splice(oldIndex, 1);
    let newIndex = oldIndex + delta;
    if (newIndex > ex.length) newIndex = ex.length;
    if (newIndex <= 0) newIndex = ex.length > 0 && ex[0].isStage ? 1 : 0;
    ex.splice(newIndex, 0, t);
    return newIndex;
  }

  setExecutablePosition(t: Target, newIndex: number): void {
    const oldIndex = this.executable.indexOf(t);
    this.moveExecutable(t, newIndex - oldIndex);
  }

  createClone(t: Target, option: Value): void {
    const name = toStr(option);
    const source = name === '_myself_' ? t : this.getSpriteTargetByName(name);
    if (!source) return;
    if (this.cloneCount >= MAX_CLONES || source.isStage) return;
    this.cloneCount++;
    const sprite = source.sprite;
    const c = new Target(this, sprite, this.nextTargetId++, false);
    // Sound and pen state come from the sprite's original, not from the target that made the clone.
    const first = sprite.clones[0];
    sprite.clones.push(c);
    if (first.pen) c.pen = { ...first.pen, c4: [...first.pen.c4] as PenState['c4'] };
    if (first.snd) c.snd = { ...first.snd };
    c.x = source.x;
    c.y = source.y;
    c.direction = source.direction;
    c.draggable = source.draggable;
    c.visible = source.visible;
    c.size = source.size;
    c.currentCostume = source.currentCostume;
    c.rotationStyle = source.rotationStyle;
    c.effects = { ...source.effects };
    c.updateDrawPosition(c.x, c.y);
    c.v = { ...source.v };
    c.l = {};
    for (const k of Object.keys(source.l)) c.l[k] = sprite.fixedLists.has(k) ? source.l[k] : source.l[k].slice();
    this.drawList.push(c);
    this.startHats('clone', null, c);
    if (c.visible) this.requestRedraw();
    this.targets.push(c);
    this.executable.push(c);
    const otherLayer = this.setDrawableOrder(source, 0, true)!;
    this.setDrawableOrder(c, otherLayer, false);
    this.setExecutablePosition(c, this.executable.indexOf(source));
  }

  /** Deletes a clone; returns true when the running thread must stop. */
  deleteClone(t: Target): boolean {
    if (t.isOriginal) return false;
    this.targets = this.targets.filter((x) => x !== t);
    this.disposeTarget(t);
    this.stopForTarget(t, null);
    return true;
  }

  private disposeTarget(t: Target): void {
    this.cloneCount--;
    this.stopForTarget(t, null);
    const ei = this.executable.indexOf(t);
    if (ei > -1) this.executable.splice(ei, 1);
    const ci = t.sprite.clones.indexOf(t);
    if (ci >= 0) t.sprite.clones.splice(ci, 1);
    const di = this.drawList.indexOf(t);
    if (di >= 0) this.drawList.splice(di, 1);
    if (t.visible) this.requestRedraw();
  }

  /** `delete this clone` from generated code: stops the running thread if the clone was deleted. */
  deleteThisClone(t: Target): void {
    if (this.deleteClone(t)) throw KILLED;
  }

  switchBackdrop(v: Value): void {
    const stage = this.stage;
    if (typeof v === 'number') {
      stage.setCostume(v - 1);
      return;
    }
    const s = v.toString();
    const idx = stage.sprite.costumeByName.get(s);
    if (idx !== undefined) stage.setCostume(idx);
    else if (v === 'next backdrop') stage.setCostume(stage.currentCostume + 1);
    else if (v === 'previous backdrop') stage.setCostume(stage.currentCostume - 1);
    else if (v === 'random backdrop') {
      const n = stage.sprite.costumes.length;
      if (n > 1) {
        let r = Math.floor(this.random() * (n - 1));
        if (r >= stage.currentCostume) r++;
        stage.setCostume(r);
      }
    } else if (!(Number.isNaN(Number(v)) || (typeof v === 'string' && v.trim().length === 0))) stage.setCostume(Number(v) - 1);
  }

  // ---------------------------------------------------------------- sensing

  touching(t: Target, what: Value): boolean {
    if (what === '_mouse_') return this.render.touchingPoint(t, this.io.mouseX, this.io.mouseY);
    if (what === '_edge_') {
      const b = this.render.bounds(t);
      return b.left < -STAGE_X || b.right > STAGE_X || b.top > STAGE_Y || b.bottom < -STAGE_Y;
    }
    const first = this.getSpriteTargetByName(toStr(what));
    if (!first) return false;
    return this.render.touchingTargets(t, first.sprite.clones);
  }

  keyPressed(k: Value): boolean {
    return this.io.keyPressed(k);
  }

  /** `go to`: the mouse, a random spot, or a sprite's original. */
  goTo(t: Target, to: Value): void {
    let x: number;
    let y: number;
    if (to === '_mouse_') {
      x = this.io.mouseX;
      y = this.io.mouseY;
    } else if (to === '_random_') {
      x = Math.round(STAGE_W * (this.random() - 0.5));
      y = Math.round(STAGE_H * (this.random() - 0.5));
    } else {
      const other = this.getSpriteTargetByName(toStr(to));
      if (!other) return;
      x = other.x;
      y = other.y;
    }
    t.setXY(x, y);
  }

  /** `glide`: the target's position at `elapsed` ms of a glide from (x0, y0) to (x1, y1) lasting `duration` ms. */
  glideStep(t: Target, x0: number, y0: number, x1: number, y1: number, elapsed: number, duration: number): boolean {
    if (elapsed < duration) {
      const frac = elapsed / duration;
      t.setXY(x0 + frac * (x1 - x0), y0 + frac * (y1 - y0));
      return true;
    }
    t.setXY(x1, y1);
    return false;
  }

  distanceTo(t: Target, what: Value): number {
    if (t.isStage) return 10000;
    let x: number;
    let y: number;
    if (what === '_mouse_') {
      x = this.io.mouseX;
      y = this.io.mouseY;
    } else {
      const other = this.getSpriteTargetByName(toStr(what));
      if (!other) return 10000;
      x = other.x;
      y = other.y;
    }
    const dx = t.x - x;
    const dy = t.y - y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** `(property) of (sprite)`: motion and looks values, or a sprite's own variable by name. */
  attributeOf(property: string, object: Value): Value {
    const o = object === '_stage_' ? this.stage : this.getSpriteTargetByName(toStr(object));
    if (!o) return 0;
    if (o.isStage) {
      switch (property) {
        case 'background #': case 'backdrop #': return o.currentCostume + 1;
        case 'backdrop name': return o.costumeName();
        case 'volume': return o.volume;
      }
    } else {
      switch (property) {
        case 'x position': return o.x;
        case 'y position': return o.y;
        case 'direction': return o.direction;
        case 'costume #': return o.currentCostume + 1;
        case 'costume name': return o.costumeName();
        case 'size': return o.size;
        case 'volume': return o.volume;
      }
    }
    const prop = o.sprite.def.varNames?.[property];
    return prop === undefined ? 0 : o.v[prop];
  }

  /** `if on edge, bounce`, from the drawn bounds. */
  ifOnEdgeBounce(t: Target): void {
    const b = this.render.bounds(t);
    const distLeft = Math.max(0, STAGE_X + b.left);
    const distTop = Math.max(0, STAGE_Y - b.top);
    const distRight = Math.max(0, STAGE_X - b.right);
    const distBottom = Math.max(0, STAGE_Y + b.bottom);
    let edge = '';
    let min = Infinity;
    if (distLeft < min) { min = distLeft; edge = 'left'; }
    if (distTop < min) { min = distTop; edge = 'top'; }
    if (distRight < min) { min = distRight; edge = 'right'; }
    if (distBottom < min) { min = distBottom; edge = 'bottom'; }
    if (min > 0) return;
    const radians = ((90 - t.direction) * Math.PI) / 180;
    let dx = cos(radians);
    let dy = -sin(radians);
    if (edge === 'left') dx = Math.max(0.2, Math.abs(dx));
    else if (edge === 'top') dy = Math.max(0.2, Math.abs(dy));
    else if (edge === 'right') dx = 0 - Math.max(0.2, Math.abs(dx));
    else if (edge === 'bottom') dy = 0 - Math.max(0.2, Math.abs(dy));
    t.setDirection((atan2(dy, dx) * 180) / Math.PI + 90);
    const [fx, fy] = this.render.keepInFence(t, t.x, t.y);
    t.setXY(fx, fy);
  }

  /** The player's name for `username`; empty unless the page sets it. */
  username = '';

  /** TypeScript versions of custom blocks, by `<sprite>/<proccode>`, that run in place of the transpiled blocks unless they return false. */
  natives: Record<string, (t: Target, args: Value[]) => void | boolean> = {};
  /** For tools, with code transpiled with PROBE=1: called as each custom block starts, with its arguments. */
  probe: ((proc: string, args: Value[]) => void) | null = null;
  /** Transpiled custom blocks that tools can call, by `<sprite>/<proccode>`. */
  procs: Record<string, (t: Target, args: Value[]) => void> = {};

  /** Days since 2000-01-01 on the simulation clock, in UTC. */
  daysSince2000(): number {
    return (this.currentMSecs - Date.UTC(2000, 0, 1)) / 86400000;
  }

  /** Speech bubbles by target id: the text and whether it is a thought. Only drawing reads them. */
  bubbles: Record<number, string> = {};
  say(t: Target, message: Value): void {
    const text = toStr(message);
    if (text === '') delete this.bubbles[t.id];
    else this.bubbles[t.id] = text;
    // Placing a bubble beside a shown sprite reads its hull bounds.
    if (text !== '' && t.visible) this.render.computeHull(t);
  }

  nextBackdrop(): void {
    this.stage.setCostume(this.stage.currentCostume + 1);
  }

  current(menu: string): number {
    const d = new Date(this.currentMSecs);
    switch (menu.toLowerCase()) {
      case 'year': return d.getUTCFullYear();
      case 'month': return d.getUTCMonth() + 1;
      case 'date': return d.getUTCDate();
      case 'dayofweek': return d.getUTCDay() + 1;
      case 'hour': return d.getUTCHours();
      case 'minute': return d.getUTCMinutes();
      case 'second': return d.getUTCSeconds();
    }
    return 0;
  }

  /** `ask and wait`; returns Ctl.Promise after queuing the question. */
  ask(th: Thread, t: Target, question: Value): Ctl {
    this.questions.push({ text: String(question), thread: th, target: t });
    return Ctl.Promise;
  }

  private submitAnswer(text: string): void {
    this.answer = text;
    const q = this.questions.shift();
    if (q) this.pending.push(q.thread);
  }

  /** The color a sprite and its pen stamps are painted in, from game state, or null. Only drawing reads it. */
  tintOf: ((t: Target) => Tint | null) | null = null;

  // ---------------------------------------------------------------- operators

  pickRandom(from: Value, to: Value): number {
    const nFrom = toNumber(from);
    const nTo = toNumber(to);
    const low = nFrom <= nTo ? nFrom : nTo;
    const high = nFrom <= nTo ? nTo : nFrom;
    if (low === high) return low;
    if (isInt(from) && isInt(to)) return low + Math.floor(this.random() * (high + 1 - low));
    return this.random() * (high - low) + low;
  }

  // ---------------------------------------------------------------- monitors

  /** Variable monitors by property name, shown and hidden from code. */
  showVariable(prop: string): void {
    this.monitorVisible[`v:${prop}`] = true;
  }
  hideVariable(prop: string): void {
    this.monitorVisible[`v:${prop}`] = false;
  }

  showList(prop: string): void {
    this.monitorVisible[prop] = true;
  }
  hideList(prop: string): void {
    this.monitorVisible[prop] = false;
  }

  // ---------------------------------------------------------------- pen

  private ensurePenLayer(): void {
    this.penCreated = true;
  }

  penClear(): void {
    this.ensurePenLayer();
    this.pen = { cmds: [], gen: this.pen.gen + 1 };
    if (this.logPen) this.frameLog.pen.push(['clear']);
    this.requestRedraw();
  }

  penStamp(t: Target): void {
    this.ensurePenLayer();
    const clip = this.render.touchingBounds(t);
    if (clip) {
      const cmd: PenCmd = {
        op: 'stamp',
        skin: t.sprite.costumes[t.currentCostume].skin,
        x: t.drawX,
        y: t.drawY,
        sx: Math.fround(t.renderedScaleX()),
        sy: Math.fround(t.size),
        dir: t.renderedDirection(),
        fx: { ...t.effects },
      };
      const tint = this.tintOf?.(t);
      if (tint) cmd.tint = tint;
      // The renderer works out the costume box itself; the hull box needs the simulation's hull state.
      if (t.hullClean) cmd.clip = clip;
      this.pen.cmds.push(cmd);
      if (this.logPen) this.frameLog.pen.push(stampLog(this, t, cmd));
    }
    this.requestRedraw();
  }

  penLine(p: PenState, x0: number, y0: number, x1: number, y1: number): void {
    this.ensurePenLayer();
    this.pen.cmds.push({ op: 'line', c4: [...p.c4], d: p.diameter, x0, y0, x1, y1, point: false });
    if (this.logPen) this.frameLog.pen.push(['line', [...p.c4], p.diameter, x0, y0, x1, y1]);
    this.requestRedraw();
  }

  penPoint(p: PenState, x: number, y: number): void {
    this.ensurePenLayer();
    this.pen.cmds.push({ op: 'line', c4: [...p.c4], d: p.diameter, x0: x, y0: y, x1: x, y1: y, point: true });
    if (this.logPen) this.frameLog.pen.push(['point', [...p.c4], p.diameter, x, y]);
    this.requestRedraw();
  }

  // ---------------------------------------------------------------- sound

  private soundIndex(t: Target, name: Value): number {
    const len = t.sprite.sounds.length;
    if (len === 0) return -1;
    const byName = typeof name === 'string' ? t.sprite.soundByName.get(name) : undefined;
    if (byName !== undefined) return byName;
    const n = parseInt(String(name), 10);
    if (!Number.isNaN(n)) {
      const range = len;
      return n - 1 - Math.floor((n - 1) / range) * range;
    }
    return -1;
  }

  private nowMs(): number {
    return this.currentMSecs;
  }

  private setPlayerRate(p: PlayerState, rate: number): void {
    if (p.isPlaying) {
      const now = this.nowMs();
      p.pos += (now - p.lastT) * p.rate;
      p.lastT = now;
    }
    p.rate = rate;
  }

  private applySoundEffects(spriteIdx: number, soundIdx: number, t: Target): void {
    const p = this.players[spriteIdx][soundIdx];
    if (t.snd) p.pitch = t.snd.pitch;
    this.setPlayerRate(p, pitchRatio(p.pitch));
    if (p.isPlaying) {
      this.soundEvents.push({ kind: 'fx', sprite: spriteIdx, sound: soundIdx, at: this.nowMs(), rate: p.rate, volume: t.volume, pan: t.snd?.pan ?? 0, serial: p.serial });
    }
  }

  private emitStop(p: PlayerState): void {
    const w = p.waiters;
    p.waiters = [];
    for (const th of w) this.pending.push(th);
  }

  private stopPlayer(spriteIdx: number, soundIdx: number): void {
    const p = this.players[spriteIdx][soundIdx];
    if (!p.isPlaying) return;
    this.emitStop(p);
    p.isPlaying = false;
    p.startingUntil = 0;
    this.soundEvents.push({ kind: 'stop', sprite: spriteIdx, sound: soundIdx, at: this.nowMs(), rate: p.rate, volume: 0, serial: p.serial });
    this.frameLog.sound.push(['stop', this.sprites[spriteIdx].sounds[soundIdx].name]);
  }

  private bankPlay(t: Target, soundIdx: number): PlayerState {
    const si = t.sprite.index;
    const p = this.players[si][soundIdx];
    if (p.owner !== t) this.stopPlayer(si, soundIdx);
    p.owner = t;
    if (p.order < 0) p.order = Math.max(-1, ...this.players[si].map((q) => q.order)) + 1;
    this.applySoundEffects(si, soundIdx, t);
    this.frameLog.sound.push(['play', t.sprite.sounds[soundIdx].name, this.executable.indexOf(t)]);
    const now = this.nowMs();
    if (p.isPlaying && p.startingUntil > now) {
      this.emitStop(p);
      return p;
    }
    if (p.isPlaying) this.stopPlayer(si, soundIdx);
    p.isPlaying = true;
    p.pos = 0;
    p.lastT = now;
    p.startingUntil = now + DECAY_MS;
    p.serial++;
    this.soundEvents.push({ kind: 'play', sprite: si, sound: soundIdx, at: now, rate: p.rate, volume: t.volume, pan: t.snd?.pan ?? 0, serial: p.serial });
    return p;
  }

  startSound(t: Target, name: Value): void {
    const idx = this.soundIndex(t, name);
    if (idx < 0) return;
    t.waitingSounds.delete(idx);
    this.bankPlay(t, idx);
  }

  /** `play sound until done`: returns true when the thread must suspend. */
  playUntilDone(th: Thread, t: Target, name: Value): boolean {
    const idx = this.soundIndex(t, name);
    if (idx < 0) return false;
    t.waitingSounds.add(idx);
    const p = this.bankPlay(t, idx);
    p.waiters.push(th);
    return true;
  }

  private checkSoundEnds(): void {
    const now = this.nowMs();
    for (let s = 0; s < this.players.length; s++) {
      const list = this.players[s];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p.isPlaying) continue;
        const def = this.sprites[s].sounds[i];
        const durationMs = (def.sampleCount / def.rate) * 1000;
        if (p.pos + (now - p.lastT) * p.rate >= durationMs) {
          p.isPlaying = false;
          this.emitStop(p);
          this.frameLog.sound.push(['end', def.name]);
        }
      }
    }
  }

  /** Sound indices of a sprite in the order they were first played, as the original's bank walks them. */
  private bankOrder(si: number): number[] {
    const list = this.players[si];
    const idx: number[] = [];
    for (let i = 0; i < list.length; i++) if (list[i].order >= 0) idx.push(i);
    return idx.sort((a, b) => list[a].order - list[b].order);
  }

  stopAllSounds(): void {
    for (const t of this.targets) {
      const si = t.sprite.index;
      for (const idx of this.bankOrder(si)) if (this.players[si][idx].owner === t) this.stopPlayer(si, idx);
      t.waitingSounds.clear();
    }
  }

  private syncSoundEffects(t: Target): void {
    t.soundState();
    const si = t.sprite.index;
    if (!this.players[si].some((p) => p.order >= 0 && p.owner === t)) return;
    for (const idx of this.bankOrder(si)) if (this.players[si][idx].owner === t) this.applySoundEffects(si, idx, t);
  }

  setVolume(t: Target, v: Value): void {
    t.volume = clamp(toNumber(v), 0, 100);
    this.syncSoundEffects(t);
  }

  changeVolume(t: Target, v: Value): void {
    this.setVolume(t, toNumber(v) + t.volume);
  }

  /** Sets or changes a sound effect; returns false when the effect name is unknown (no suspension then). */
  soundEffect(t: Target, effect: Value, v: Value, change: boolean): boolean {
    const name = toStr(effect).toLowerCase();
    const value = toNumber(v);
    const st = t.soundState();
    if (name !== 'pitch' && name !== 'pan') return false;
    st[name] = change ? st[name] + value : value;
    st[name] = name === 'pitch' ? clamp(st[name], -360, 360) : clamp(st[name], -100, 100);
    this.syncSoundEffects(t);
    return true;
  }

  clearSoundEffects(t: Target): void {
    const st = t.soundState();
    st.pitch = 0;
    st.pan = 0;
    this.syncSoundEffects(t);
  }
}

function stampLog(rt: Runtime, t: Target, cmd: Extract<PenCmd, { op: 'stamp' }>): unknown[] {
  const fx = cmd.fx;
  let bits = 0;
  const names: EffectName[] = ['color', 'fisheye', 'whirl', 'pixelate', 'mosaic', 'brightness', 'ghost'];
  names.forEach((n, i) => {
    if (fx[n]) bits |= 1 << i;
  });
  return [
    'stamp',
    `${t.sprite.def.isStage ? '_stage_' : t.sprite.name}#${t.currentCostume}`,
    cmd.x,
    cmd.y,
    cmd.sx,
    cmd.sy,
    cmd.dir,
    bits,
    (fx.color / 200) % 1,
    // Logged as the reference logs it: a zero whirl without its sign.
    ((-fx.whirl * Math.PI) / 180) || 0,
    Math.abs(fx.pixelate) / 10,
    Math.max(-100, Math.min(fx.brightness, 100)) / 100,
    1 - Math.max(0, Math.min(fx.ghost, 100)) / 100,
  ];
  void rt;
}
