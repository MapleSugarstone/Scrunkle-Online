/* global PORT_RUNTIME, Scaffolding, VirtualMachine, ScratchRender, ScratchStorage, ScratchSVGRenderer, DMATH */
// Runs the original project in the runtime it was made for (src/game/runtime.json: the interpreter, or the runtime that
// compiles scripts), at the project's stage size, with simulated time, a seeded random source and simulated sound
// timing, so every run with the same inputs produces the same frames.
(function () {
  'use strict';

  // The VM steps from an interval of 1000 / 30 ms, which browsers truncate to 33, so real frames are 33 ms apart.
  const FRAME_MS = 1000 / 30;
  const CLOCK_STEP_MS = 33;
  const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
  let simNow = T0;
  // The compiled date blocks read `new Date()` in local time, and the page runs in UTC, so they read the simulated clock.
  const RealDate = Date;
  class SimDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(simNow);
      else super(...args);
    }
    static now() { return simNow; }
  }
  window.Date = SimDate;
  const COMPILED = PORT_RUNTIME.runtime === 'turbowarp';
  const STAGE_W = PORT_RUNTIME.stageWidth;
  const STAGE_H = PORT_RUNTIME.stageHeight;

  const STATUS_RUNNING = 0;
  const STATUS_YIELD = 2;
  const STATUS_YIELD_TICK = 3;
  const STATUS_DONE = 4;

  const H = window.H = {
    frame: 0,
    ticks: 0,
    tickCap: 8,
    capHits: 0,
    penLog: [],
    soundLog: [],
    rngCalls: 0,
    ready: false,
    error: null,
  };

  // Seeded generator shared by the port (32-bit state, one step per call).
  function makeRng(seed) {
    let a = seed >>> 0;
    return {
      next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      get state() { return a; },
    };
  }
  let rng = makeRng(1);
  // Compiled code calls Math.random for pick random, random list items, random positions and directions, so
  // Math.random is the seeded generator. Clones take ids from Math.random too, which the port has no use for,
  // so those draws come from the browser's generator.
  const realRandom = Math.random;
  let unseeded = 0;
  Math.random = function () {
    if (unseeded > 0) return realRandom();
    H.rngCalls++;
    return rng.next();
  };

  // ---------------------------------------------------------------- simulated audio
  const DECAY = 0.025;
  function nowSec() { return simNow / 1000; }

  class FakePlayer {
    constructor(id, sound) {
      this.id = id;
      this.name = sound.name;
      this.duration = sound.sampleCount / sound.rate;
      this.buffer = { sampleRate: sound.rate, length: sound.sampleCount, duration: this.duration };
      this.isPlaying = false;
      this.startingUntil = 0;
      this.waiters = [];
      this.rate = 1;
      this.pos = 0;
      this.lastT = 0;
    }
    get isStarting() { return this.isPlaying && this.startingUntil > nowSec(); }
    emitStop() {
      const w = this.waiters;
      this.waiters = [];
      for (const r of w) r();
    }
    setRate(r) {
      if (this.isPlaying) {
        const t = nowSec();
        this.pos += (t - this.lastT) * this.rate;
        this.lastT = t;
      }
      this.rate = r;
    }
    play() {
      if (this.isStarting) {
        this.emitStop();
        return;
      }
      if (this.isPlaying) this.stop();
      this.isPlaying = true;
      this.pos = 0;
      this.lastT = nowSec();
      this.startingUntil = nowSec() + DECAY;
    }
    stop() {
      if (!this.isPlaying) return;
      this.emitStop();
      this.isPlaying = false;
      this.startingUntil = 0;
      H.soundLog.push(['stop', this.name]);
    }
    checkEnded() {
      if (!this.isPlaying) return;
      const consumed = this.pos + (nowSec() - this.lastT) * this.rate;
      if (consumed >= this.duration) {
        this.isPlaying = false;
        this.emitStop();
        H.soundLog.push(['end', this.name]);
      }
    }
  }

  const allPlayers = [];
  let nextSoundId = 1;

  class FakeBank {
    constructor() {
      this.soundPlayers = {};
      this.playerTargets = new Map();
      this.pitch = new Map();
    }
    addSoundPlayer(p) { this.soundPlayers[p.id] = p; }
    getSoundPlayer(id) { return this.soundPlayers[id]; }
    _applyEffects(soundId, target) {
      if (target.soundEffects && 'pitch' in target.soundEffects) this.pitch.set(soundId, target.soundEffects.pitch);
      const pitch = this.pitch.get(soundId) || 0;
      this.soundPlayers[soundId].setRate(DMATH.pow2((pitch / 10) / 12));
    }
    playSound(target, soundId) {
      const player = this.soundPlayers[soundId];
      if (this.playerTargets.get(soundId) !== target) player.stop();
      this.playerTargets.set(soundId, target);
      this._applyEffects(soundId, target);
      H.soundLog.push(['play', player.name, H.vm.runtime.executableTargets.indexOf(target)]);
      player.play();
      return new Promise((resolve) => player.waiters.push(resolve));
    }
    setEffects(target) {
      this.playerTargets.forEach((t, id) => { if (t === target) this._applyEffects(id, target); });
    }
    stop(target, soundId) {
      if (this.playerTargets.get(soundId) === target) this.soundPlayers[soundId].stop();
    }
    stopAllSounds(target = '*') {
      this.playerTargets.forEach((t, id) => {
        if (target === '*' || t === target) this.soundPlayers[id].stop();
      });
    }
    dispose() {}
  }

  const fakeAudioEngine = {
    get currentTime() { return nowSec(); },
    DECAY_DURATION: DECAY,
    createBank() { return new FakeBank(); },
    decodeSoundPlayer(sound) {
      const p = new FakePlayer(`snd${nextSoundId++}`, sound);
      allPlayers.push(p);
      return Promise.resolve(p);
    },
    getLoudness() { return -1; },
  };

  // ---------------------------------------------------------------- scheduler with a tick cap
  // The warp timer reads the wall clock, which stands still within a frame here. In a browser a block that
  // yields inside a warp procedure (broadcast and wait, wait, wait until) runs again until 500 ms have passed,
  // and the thread then gives up its turn. Other threads cannot run meanwhile, so the outcome is that the
  // thread yields. This timer expires as soon as such a block yields, which gives the same order of events
  // without the stall. Warp loops and calls never expire it, as on a machine fast enough to finish them.
  function newWarpTimer() {
    return { expired: false, start() {}, timeElapsed() { return this.expired ? Infinity : 0; } };
  }
  const YIELDING_OPS = ['control_wait', 'control_wait_until', 'event_broadcastandwait', 'motion_glidesecstoxy', 'motion_glideto', 'looks_sayforsecs', 'looks_thinkforsecs'];
  function wrapYieldingOps(runtime) {
    for (const op of YIELDING_OPS) {
      const orig = runtime._primitives[op];
      if (!orig) continue;
      runtime._primitives[op] = function (args, util) {
        const out = orig.call(this, args, util);
        const th = util.thread;
        if (th.status === STATUS_YIELD && th.warpTimer && th.peekStackFrame().warpMode) th.warpTimer.expired = true;
        return out;
      };
    }
  }

  // Logs one thread step for tools/parity-ticks.ts and tools/parity-steps.ts: with `states`, the rng and target hashes
  // after the step, and with `fullAtStep`, the full state after that step.
  function traceStep(th) {
    const entry = [H.frame, H.ticks, th.target.sprite.name, th.topBlock, th.status];
    if (H.trace.states) {
      const d = digest(fullState());
      entry.push([d.rng, ...d.targets]);
    }
    H.trace.log.push(entry);
    if (H.trace.fullAtStep === H.trace.log.length - 1) H.trace.full = fullState();
  }

  function patchedStepThreads() {
    const runtime = this.runtime;
    runtime.updateCurrentMSecs();
    let numActiveThreads = Infinity;
    let ranFirstTick = false;
    const doneThreads = [];
    H.ticks = 0;
    while (runtime.threads.length > 0 &&
           numActiveThreads > 0 &&
           H.ticks < H.tickCap &&
           (runtime.turboMode || !runtime.redrawRequested)) {
      H.ticks++;
      numActiveThreads = 0;
      let stoppedThread = false;
      const threads = runtime.threads;
      for (let i = 0; i < threads.length; i++) {
        const activeThread = this.activeThread = threads[i];
        if (activeThread.stack.length === 0 || activeThread.status === STATUS_DONE) {
          stoppedThread = true;
          continue;
        }
        if (activeThread.status === STATUS_YIELD_TICK && !ranFirstTick) {
          activeThread.status = STATUS_RUNNING;
        }
        if (activeThread.status === STATUS_RUNNING || activeThread.status === STATUS_YIELD) {
          activeThread.warpTimer = newWarpTimer();
          this.stepThread(activeThread);
          activeThread.warpTimer = null;
          if (H.trace && H.frame >= H.trace.from && H.frame <= H.trace.to) traceStep(activeThread);
          // The interpreter steps the same index again after a thread was killed. The compiling runtime does not.
          if (!COMPILED && activeThread.isKilled) i--;
        }
        if (activeThread.status === STATUS_RUNNING) numActiveThreads++;
        if (activeThread.stack.length === 0 || activeThread.status === STATUS_DONE) stoppedThread = true;
      }
      ranFirstTick = true;
      if (stoppedThread) {
        let next = 0;
        for (let i = 0; i < runtime.threads.length; i++) {
          const thread = runtime.threads[i];
          if (thread.stack.length !== 0 && thread.status !== STATUS_DONE) {
            runtime.threads[next++] = thread;
          } else {
            if (runtime.threadMap) runtime.threadMap.delete(thread.getId());
            doneThreads.push(thread);
          }
        }
        runtime.threads.length = next;
      }
    }
    if (H.ticks >= H.tickCap && runtime.threads.length > 0 && numActiveThreads > 0 && !runtime.redrawRequested) H.capHits++;
    this.activeThread = null;
    return doneThreads;
  }

  // ---------------------------------------------------------------- canonical values and digests
  function canon(v) {
    if (typeof v === 'number') return Object.is(v, -0) ? 'n-0' : `n${v}`;
    if (typeof v === 'string') return `s${JSON.stringify(v)}`;
    if (typeof v === 'boolean') return v ? 'bT' : 'bF';
    if (v === undefined) return 'u';
    if (v === null) return 'z';
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    return `o${JSON.stringify(v)}`;
  }
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  const EFFECT_NAMES = ['color', 'fisheye', 'whirl', 'pixelate', 'mosaic', 'brightness', 'ghost'];
  let skinKeys = new Map();

  function targetState(t) {
    const r = H.vm.runtime;
    const vars = {};
    const lists = {};
    for (const [id, v] of Object.entries(t.variables)) {
      if (v.type === 'list') lists[id] = v.value.slice();
      else if (v.type === '') vars[id] = v.value;
    }
    const pen = t.getCustomState('Scratch.pen');
    const snd = t.getCustomState('Scratch.sound');
    return {
      name: t.getName(),
      orig: t.isOriginal,
      x: t.x, y: t.y, dir: t.direction, size: t.size, costume: t.currentCostume,
      vis: t.visible, rot: t.rotationStyle, vol: t.volume,
      fx: EFFECT_NAMES.map((e) => t.effects[e]),
      // Position within the sprite layer group, which does not depend on whether the pen layer exists yet.
      layer: t.isStage ? -1 : r.renderer._drawList.indexOf(t.drawableID) - r.renderer._layerGroups.sprite.drawListOffset,
      vars, lists,
      pen: pen ? [pen.penDown, pen.color, pen.saturation, pen.brightness, pen.transparency, pen.penAttributes.diameter] : null,
      snd: snd ? [snd.effects.pitch, snd.effects.pan] : null,
    };
  }

  function fullState() {
    const r = H.vm.runtime;
    return {
      frame: H.frame,
      ticks: H.ticks,
      rng: rng.state,
      rngCalls: H.rngCalls,
      targets: r.executableTargets.map(targetState),
      threads: r.threads.map((th) => [r.executableTargets.indexOf(th.target), th.topBlock, th.status, th.stack.length ? th.stack[th.stack.length - 1] : null]),
      pen: H.penLog,
      sound: H.soundLog,
      answer: r.ext_scratch3_sensing ? r.ext_scratch3_sensing._answer : null,
    };
  }

  function digest(s) {
    return {
      frame: s.frame,
      ticks: s.ticks,
      rng: s.rng,
      targets: s.targets.map((t) => hash(canon([t.name, t.orig, t.x, t.y, t.dir, t.size, t.costume, t.vis, t.rot, t.vol, t.fx, t.layer, t.pen, t.snd])
        + canon(sortedEntries(t.vars)) + canon(sortedEntries(t.lists)))),
      threads: hash(canon(s.threads.map((th) => [th[0], th[1], th[2]]))),
      pen: hash(canon(s.pen)),
      penCount: s.pen.length,
      sound: hash(canon(normalizeSound(s.sound))),
    };
  }

  function sortedEntries(o) {
    return Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  // Sorts each run of 'end' events; their order between players carries no meaning.
  function normalizeSound(log) {
    const out = [];
    let run = [];
    const flush = () => {
      run.sort((a, b) => canon(a).localeCompare(canon(b)));
      out.push(...run);
      run = [];
    };
    for (const e of log) {
      if (e[0] === 'end') run.push(e);
      else { flush(); out.push(e); }
    }
    flush();
    return out;
  }

  // ---------------------------------------------------------------- setup
  async function setup() {
    const canvas = document.getElementById('stage');
    const P = COMPILED
      ? Scaffolding.Packages
      : { VM: VirtualMachine, Storage: ScratchStorage.ScratchStorage || ScratchStorage, Renderer: ScratchRender, SVGRenderer: ScratchSVGRenderer };
    const vm = new P.VM();
    H.vm = vm;
    vm.attachStorage(new P.Storage());
    const renderer = new P.Renderer(canvas, -STAGE_W / 2, STAGE_W / 2, -STAGE_H / 2, STAGE_H / 2);
    H.renderer = renderer;
    const createDrawable = renderer.createDrawable.bind(renderer);
    renderer.createDrawable = (group) => {
      const id = createDrawable(group);
      if (group === 'pen') H.penDrawableId = id;
      return id;
    };
    vm.attachRenderer(renderer);
    vm.attachV2BitmapAdapter(new P.SVGRenderer.BitmapAdapter());
    vm.attachAudioEngine(fakeAudioEngine);
    vm.setCompatibilityMode(true);
    if (COMPILED) vm.setStageSize(STAGE_W, STAGE_H);
    vm.runtime.sequencer.stepThreads = patchedStepThreads;

    const res = await fetch(new URLSearchParams(location.search).get('p') || '/game.sb3');
    const buf = await res.arrayBuffer();
    await vm.loadProject(buf);
    const r0 = vm.runtime;
    if (COMPILED) {
      // The project's settings comment sets the stage size and frame rate. The port is built for these.
      if (r0.stageWidth !== STAGE_W || r0.stageHeight !== STAGE_H) throw new Error(`stage is ${r0.stageWidth}x${r0.stageHeight}, expected ${STAGE_W}x${STAGE_H}`);
      if (r0.frameLoop.framerate !== 30) throw new Error(`frame rate is ${r0.frameLoop.framerate}, expected 30`);
      if (!r0.compilerOptions.enabled || r0.compilerOptions.warpTimer) throw new Error(`compiler options ${JSON.stringify(r0.compilerOptions)}`);
    }
    r0.currentStepTime = FRAME_MS;
    H.compileErrors = [];
    r0.on('COMPILE_ERROR', (target, error) => H.compileErrors.push([target.getName(), String(error && error.message || error)]));
    // For tools/parity-probe.ts: while H.probe is set, every custom block a compiled thread calls logs its name and
    // arguments, as the port's code transpiled with PROBE=1 does.
    const wrapProcedures = (th) => {
      if (!th || !th.procedures || th.procedures.__probed) return th;
      for (const k of Object.keys(th.procedures)) {
        const f = th.procedures[k];
        th.procedures[k] = function (...args) {
          if (H.probe && H.frame === H.probe.frame) H.probe.log.push([k.slice(1), args]);
          return f.apply(this, args);
        };
      }
      th.procedures.__probed = true;
      return th;
    };
    for (const name of ['_pushThread', '_restartThread']) {
      const orig = r0[name];
      r0[name] = function (...args) { return wrapProcedures(orig.apply(this, args)); };
    }
    // The VM makes ids from Math.random for clones, speech bubbles (say, think and ask) and variables it creates while
    // running. The port has no use for them, so those draws come from the browser's generator.
    const unseededCalls = (obj, name) => {
      const orig = obj && obj[name];
      if (typeof orig !== 'function') return;
      obj[name] = function (...args) {
        unseeded++;
        try { return orig.apply(this, args); } finally { unseeded--; }
      };
    };
    const proto = Object.getPrototypeOf(r0.getTargetForStage());
    for (const name of ['makeClone', 'lookupOrCreateVariable', 'lookupOrCreateList', 'createVariable']) unseededCalls(proto, name);
    // Speech bubbles listen for the SAY event with a function bound when the VM starts, so the event is wrapped.
    const emit = r0.emit;
    r0.emit = function (event, ...args) {
      if (event !== 'SAY') return emit.call(this, event, ...args);
      unseeded++;
      try { return emit.call(this, event, ...args); } finally { unseeded--; }
    };
    unseededCalls(r0, 'createNewGlobalVariable');

    // Glide reads the real clock in the original; here it reads the simulated clock, which advances 33 ms per frame as
    // the real one does.
    vm.runtime._primitives.motion_glidesecstoxy = function (args, util) {
      const sf = util.stackFrame;
      if (sf.glideStart !== undefined) {
        const timeElapsed = simNow - sf.glideStart;
        if (timeElapsed < sf.duration * 1000) {
          const frac = timeElapsed / (sf.duration * 1000);
          util.target.setXY(sf.startX + frac * (sf.endX - sf.startX), sf.startY + frac * (sf.endY - sf.startY));
          util.yield();
        } else {
          util.target.setXY(sf.endX, sf.endY);
        }
      } else {
        sf.glideStart = simNow;
        sf.duration = Number(args.SECS) || 0;
        sf.startX = util.target.x;
        sf.startY = util.target.y;
        sf.endX = Number(args.X) || 0;
        sf.endY = Number(args.Y) || 0;
        if (sf.duration <= 0) {
          util.target.setXY(sf.endX, sf.endY);
          return;
        }
        util.yield();
      }
    };

    // Pen operation log.
    const origStamp = renderer.penStamp.bind(renderer);
    renderer.penStamp = function (penSkinID, stampID) {
      const d = renderer._allDrawables[stampID];
      const bounds = d && d.skin ? renderer._touchingBounds(stampID) : null;
      if (bounds) {
        const u = d._uniforms;
        // A zero whirl's sign depends on how the drawable last set it and never changes a pixel, so it is logged as 0.
        H.penLog.push(['stamp', skinKeys.get(d.skin.id), d._position[0], d._position[1], d._scale[0], d._scale[1], d._direction,
          d.enabledEffects, u.u_color, u.u_whirl || 0, u.u_pixelate, u.u_brightness, u.u_ghost]);
      }
      return origStamp(penSkinID, stampID);
    };
    const origLine = renderer.penLine.bind(renderer);
    renderer.penLine = function (id, attrs, x0, y0, x1, y1) {
      H.penLog.push(['line', attrs.color4f.slice(), attrs.diameter, x0, y0, x1, y1]);
      return origLine(id, attrs, x0, y0, x1, y1);
    };
    const origPoint = renderer.penPoint.bind(renderer);
    renderer.penPoint = function (id, attrs, x, y) {
      H.penLog.push(['point', attrs.color4f.slice(), attrs.diameter, x, y]);
      return origPoint(id, attrs, x, y);
    };
    const origClear = renderer.penClear.bind(renderer);
    renderer.penClear = function (id) {
      H.penLog.push(['clear']);
      return origClear(id);
    };

    // Wait for every vector costume to finish rasterizing.
    for (let i = 0; i < 600; i++) {
      const pending = Object.values(renderer._allSkins).filter((s) => s && s._svgImage && !s._svgImageLoaded);
      if (pending.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Touching uses the 1x raster's silhouette only. The stock renderer keeps the largest raster made so far,
    // so masks would depend on display size and on which scales each costume was drawn or tested at.
    const svgSkin = Object.values(renderer._allSkins).find((s) => s && s._svgImage);
    if (svgSkin) {
      const proto = Object.getPrototypeOf(svgSkin);
      const origCreateMIP = proto.createMIP;
      proto.createMIP = function (scale) {
        // The raster getTexture([100, 100]) picks; for very large costumes it is below 1x.
        const base = Math.pow(2, Math.max(Math.ceil(Math.log2(Math.min(1, this._maxTextureScale))) + 8, 0) - 8);
        const largest = this._largestMIPScale;
        if (scale !== base) this._largestMIPScale = Infinity;
        const tex = origCreateMIP.call(this, scale);
        if (scale !== base) this._largestMIPScale = largest;
        return tex;
      };
      // The silhouette reads its pixels lazily, which updateSilhouette forces before a touching test reads them.
      proto.updateSilhouette = function () {
        this.getTexture([100, 100]);
        if (this._silhouette.unlazy) this._silhouette.unlazy();
      };
    }
    skinKeys = new Map();
    for (const t of vm.runtime.targets) {
      t.sprite.costumes.forEach((c, i) => skinKeys.set(c.skinId, `${t.isStage ? '_stage_' : t.sprite.name}#${i}`));
    }
    wrapYieldingOps(vm.runtime);
    captureInitial();
    H.ready = true;
    document.getElementById('status').textContent = 'ready';
  }

  // ---------------------------------------------------------------- reset without reloading
  // Loading this project takes minutes (thousands of vector costumes), and the green flag does not reset
  // variables, so each run restores the state every original target had right after loading.
  let initial = null;
  function captureInitial() {
    const r = H.vm.runtime;
    initial = {
      targets: r.targets.filter((t) => t.isOriginal).map((t) => ({
        t,
        vars: Object.fromEntries(Object.entries(t.variables).map(([id, v]) => [id, Array.isArray(v.value) ? v.value.slice() : v.value])),
        x: t.x, y: t.y, direction: t.direction, size: t.size, costume: t.currentCostume, visible: t.visible,
        rotationStyle: t.rotationStyle, draggable: t.draggable, volume: t.volume,
      })),
      drawList: H.renderer._drawList.slice(),
      executable: r.executableTargets.slice(),
      monitors: r._monitorState,
    };
  }

  function resetToInitial() {
    const r = H.vm.runtime;
    r.stopAll();
    for (const s of initial.targets) {
      const t = s.t;
      for (const [id, v] of Object.entries(s.vars)) if (t.variables[id]) t.variables[id].value = Array.isArray(v) ? v.slice() : v;
      // Loading assigns these without fencing or clamping, so they are assigned the same way here.
      t.x = s.x;
      t.y = s.y;
      t.direction = s.direction;
      t.size = s.size;
      t.currentCostume = s.costume;
      t.visible = s.visible;
      t.rotationStyle = s.rotationStyle;
      t.draggable = s.draggable;
      t.volume = s.volume;
      t.clearEffects();
      t.updateAllDrawableProperties();
    }
    H.renderer._drawList.length = 0;
    H.renderer._drawList.push(...initial.drawList);
    // The pen layer outlives a reset, and the layer group offsets still count it, so it goes back in its group.
    if (H.penDrawableId !== undefined && !H.renderer._drawList.includes(H.penDrawableId)) {
      H.renderer._drawList.splice(H.renderer._layerGroups.pen.drawListOffset, 0, H.penDrawableId);
    }
    r.executableTargets.length = 0;
    r.executableTargets.push(...initial.executable);
    r._monitorState = initial.monitors;
    r.ioDevices.keyboard._keysPressed = [];
    for (const p of allPlayers) { p.isPlaying = false; p.waiters = []; p.rate = 1; p.pos = 0; p.startingUntil = 0; }
    // A fresh load has empty banks; their first-play order decides the order "stop all sounds" stops in.
    for (const s of initial.targets) {
      const bank = s.t.sprite.soundBank;
      if (bank) { bank.playerTargets.clear(); bank.pitch.clear(); }
    }
  }
  H.reset = resetToInitial;

  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  // ---------------------------------------------------------------- driver API
  const keyToBrowser = (k) => {
    switch (k) {
      case 'space': return ' ';
      case 'left arrow': return 'ArrowLeft';
      case 'right arrow': return 'ArrowRight';
      case 'up arrow': return 'ArrowUp';
      case 'down arrow': return 'ArrowDown';
      case 'enter': return 'Enter';
      default: return k.toLowerCase();
    }
  };

  function applyInput(ev) {
    const vm = H.vm;
    if (ev.type === 'key') {
      vm.postIOData('keyboard', { key: keyToBrowser(ev.key), isDown: ev.down });
    } else if (ev.type === 'mouse') {
      const cx = ev.x + STAGE_W / 2 || 1e-9;
      const cy = STAGE_H / 2 - ev.y || 1e-9;
      const data = { x: cx, y: cy, canvasWidth: STAGE_W, canvasHeight: STAGE_H };
      if (ev.down !== undefined) data.isDown = ev.down;
      vm.postIOData('mouse', data);
    } else if (ev.type === 'answer') {
      vm.runtime.emit('ANSWER', ev.text);
    } else if (ev.type === 'cloud') {
      vm.postIOData('cloud', { varUpdate: { name: ev.name, value: ev.value } });
    } else if (ev.type === 'var') {
      const v = vm.runtime.getTargetForStage().lookupVariableByNameAndType(ev.name, '');
      if (v) v.value = ev.value;
    } else if (ev.type === 'list') {
      const t = ev.target === 'Stage' ? vm.runtime.getTargetForStage() : vm.runtime.getSpriteTargetByName(ev.target);
      const l = t && t.lookupVariableById(ev.id);
      if (l) {
        l.value = ev.value.slice();
        l._monitorUpToDate = false;
      }
    }
  }

  H.start = async function (opts) {
    if (H.started) resetToInitial();
    H.started = true;
    rng = makeRng(opts.seed >>> 0);
    H.rngCalls = 0;
    H.tickCap = opts.tickCap || 8;
    simNow = T0;
    H.vm.runtime.currentMSecs = T0;
    H.frame = 0;
    H.penLog = [];
    H.soundLog = [];
    // Mouse x and y report nothing until the first pointer event, which a page with a pointer sends at once.
    // The port starts with the pointer at the stage center, so the reference does too.
    H.vm.postIOData('userData', { username: opts.username || '' });
    const mouse = H.vm.runtime.ioDevices.mouse;
    mouse._isDown = false;
    mouse._clientX = STAGE_W / 2;
    mouse._clientY = STAGE_H / 2;
    mouse._scratchX = 0;
    mouse._scratchY = 0;
    H.vm.greenFlag();
    await flush();
    return digest(fullState());
  };

  // Runs one frame. `events` apply before the frame's ticks.
  H.step = async function (events, want) {
    H.frame++;
    simNow = T0 + H.frame * CLOCK_STEP_MS;
    H.penLog = [];
    H.soundLog = [];
    for (const p of allPlayers) p.checkEnded();
    await flush();
    for (const ev of events || []) applyInput(ev);
    H.vm.runtime._step();
    let shot = null;
    if (want && want.shot) shot = document.getElementById('stage').toDataURL('image/png');
    await flush();
    const full = fullState();
    const out = { digest: digest(full) };
    if (want && want.full) out.full = full;
    if (shot) out.shot = shot;
    return out;
  };

  H.run = async function (frames, eventsByFrame, opts) {
    const digests = [];
    const fulls = {};
    const shots = {};
    const fullAt = new Set((opts && opts.fullAt) || []);
    const shotAt = new Set((opts && opts.shotAt) || []);
    for (let i = 0; i < frames; i++) {
      const f = H.frame + 1;
      const r = await H.step(eventsByFrame[f], { full: fullAt.has(f), shot: shotAt.has(f) });
      digests.push(r.digest);
      if (r.full) fulls[f] = r.full;
      if (r.shot) shots[f] = r.shot;
    }
    return { digests, fulls, shots, capHits: H.capHits };
  };

  // What a player sees and hears and what the scripts hold, keyed by names rather than ids, costume numbers or
  // threads, so two versions of a project that behave the same compare equal. Names in `ignore` are left out.
  function observed(ignore) {
    const r = H.vm.runtime;
    return {
      rng: rng.state,
      rngCalls: H.rngCalls,
      targets: r.executableTargets.map((t) => {
        const vars = {};
        const lists = {};
        for (const v of Object.values(t.variables)) {
          if (ignore.includes(v.name)) continue;
          if (v.type === 'list') lists[v.name] = v.value.slice();
          else if (v.type === '') vars[v.name] = v.value;
        }
        const pen = t.getCustomState('Scratch.pen');
        const snd = t.getCustomState('Scratch.sound');
        return [t.getName(), t.isOriginal, t.x, t.y, t.direction, t.size, t.getCostumes()[t.currentCostume].name, t.visible,
          t.rotationStyle, t.volume, EFFECT_NAMES.map((e) => t.effects[e]),
          t.isStage ? -1 : r.renderer._drawList.indexOf(t.drawableID) - r.renderer._layerGroups.sprite.drawListOffset,
          sortedEntries(vars), sortedEntries(lists),
          pen ? [pen.penDown, pen.color, pen.saturation, pen.brightness, pen.transparency, pen.penAttributes.diameter] : null,
          snd ? [snd.effects.pitch, snd.effects.pan] : null];
      }),
      pen: H.penLog,
      sound: normalizeSound(H.soundLog),
      answer: r.ext_scratch3_sensing ? r.ext_scratch3_sensing._answer : null,
    };
  }
  H.observed = (ignore) => observed(ignore || []);
  // Runs frames as H.step does and returns one hash of the observed state per frame.
  H.runObserved = async function (frames, eventsByFrame, ignore) {
    const hashes = [];
    for (let i = 0; i < frames; i++) {
      H.frame++;
      simNow = T0 + H.frame * CLOCK_STEP_MS;
      H.penLog = [];
      H.soundLog = [];
      for (const p of allPlayers) p.checkEnded();
      await flush();
      for (const ev of eventsByFrame[H.frame] || []) applyInput(ev);
      H.vm.runtime._step();
      await flush();
      hashes.push(hash(canon(observed(ignore || []))));
    }
    return hashes;
  };

  H.resize = function (w, h) {
    H.renderer.resize(w, h);
    const c = document.getElementById('stage');
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
  };

  // Costume and sound metadata as the renderer computed it.
  H.meta = function () {
    const renderer = H.renderer;
    const out = [];
    for (const t of H.vm.runtime.targets) {
      if (!t.isOriginal) continue;
      const costumes = t.sprite.costumes.map((c) => {
        const skin = renderer._allSkins[c.skinId];
        const entry = {
          name: c.name,
          format: c.dataFormat,
          md5ext: c.md5,
          bitmapResolution: c.bitmapResolution,
          rotationCenterX: c.rotationCenterX,
          rotationCenterY: c.rotationCenterY,
          size: skin.size,
          skinRotationCenter: [skin.rotationCenter[0], skin.rotationCenter[1]],
        };
        if (skin._svgImage) entry.maxTextureScale = skin._maxTextureScale;
        return entry;
      });
      const sounds = t.sprite.sounds.map((s) => ({ name: s.name, md5ext: s.md5, format: s.dataFormat, rate: s.rate, sampleCount: s.sampleCount }));
      out.push({ name: t.sprite.name, isStage: t.isStage, costumes, sounds });
    }
    return out;
  };

  // Normalized vector sources, a slice at a time (all of them at once overflow the driver's message limit).
  H.svgSources = function (start, count) {
    const all = [];
    for (const t of H.vm.runtime.targets) {
      if (!t.isOriginal) continue;
      for (const c of t.sprite.costumes) {
        const skin = H.renderer._allSkins[c.skinId];
        if (skin._svgImage) all.push({ md5ext: c.md5, src: skin._svgImage.src });
      }
    }
    return { total: all.length, items: all.slice(start, start + count) };
  };

  // 1-bit alpha masks of the given sprites' costumes at the 1x mip, as the touching tests see them.
  H.silhouettes = function (spriteNames) {
    const out = {};
    for (const t of H.vm.runtime.targets) {
      if (!t.isOriginal || t.isStage || !spriteNames.includes(t.sprite.name)) continue;
      out[t.sprite.name] = t.sprite.costumes.map((c) => {
        const skin = H.renderer._allSkins[c.skinId];
        skin.getTexture([100, 100]);
        const s = skin._silhouette;
        // The silhouette reads its pixels lazily.
        if (s.unlazy) s.unlazy();
        const w = s._width;
        const h = s._height;
        const bits = new Uint8Array(Math.ceil((w * h) / 8));
        if (s._colorData) {
          for (let i = 0; i < w * h; i++) if (s._colorData[i * 4 + 3] > 0) bits[i >> 3] |= 1 << (i & 7);
        }
        let bin = '';
        for (let i = 0; i < bits.length; i++) bin += String.fromCharCode(bits[i]);
        return { w, h, bits: btoa(bin) };
      });
    }
    return out;
  };

  setup().catch((e) => {
    H.error = String(e && e.stack || e);
    document.getElementById('status').textContent = H.error;
  });
})();
