// Rollback session: every player runs the whole simulation. Local input is applied after a
// small delay; missing remote input is predicted by repeating the player's last known keys.
// When real input arrives and differs from the prediction, the session restores the snapshot
// before that frame and simulates forward again with the corrected input.
import type { PlayerInput } from '../engine/io.ts';
import { FRAME_MS, type Runtime } from '../engine/runtime.ts';
import type { SoundEvent } from '../engine/sound-model.ts';
import { saveSnapshot, loadSnapshot, type Snapshot } from '../engine/snapshot.ts';
import { asSent, decodePacket, encodePacket, Kind, type InputPacket, type Packet } from './wire.ts';

export interface Transport {
  /** Sends a packet to one seat; delivery is unreliable and unordered. */
  send(seat: number, data: ArrayBuffer): void;
}

export interface SessionOptions {
  rt: Runtime;
  local: number;
  seats: number[];
  delay: number;
  /** Most frames the simulation may run ahead of the oldest unconfirmed remote input. */
  maxPrediction?: number;
  transport: Transport;
  now?: () => number;
}

export interface SessionStats {
  frame: number;
  rollbacks: number;
  rolledFrames: number;
  stalls: number;
  pings: Record<number, number>;
  advantage: number;
  waitingFor: number[];
  /** Milliseconds since each remote seat was last heard from. */
  silentFor: Record<number, number>;
  desync: { frame: number; seat: number } | null;
}

const SEND_WINDOW = 64;
const CHECK_EVERY = 60;
const SILENT_MS = 3000;

function sameInput(a: PlayerInput | undefined, b: PlayerInput | undefined): boolean {
  if (!a || !b) return false;
  if (a.keys.length !== b.keys.length) return false;
  const s = new Set(a.keys);
  for (const k of b.keys) if (!s.has(k)) return false;
  if (!!a.mouse !== !!b.mouse) return false;
  if (a.mouse && b.mouse && (a.mouse.x !== b.mouse.x || a.mouse.y !== b.mouse.y || a.mouse.down !== b.mouse.down)) return false;
  return a.answer === b.answer;
}

const EMPTY: PlayerInput = { keys: [] };

/** A stable hash of a snapshot's simulation state. */
export function snapshotHash(s: Snapshot): number {
  // The pen array is shared and may have grown since; its length at snapshot time is what counts. Held keys come from
  // inputs every peer already agrees on, and leaving them out keeps hashes from before snapshots held them.
  const text = JSON.stringify({ ...s, penCmds: s.penLength, keys: undefined });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class RollbackSession {
  readonly rt: Runtime;
  readonly local: number;
  readonly seats: number[];
  readonly delay: number;
  readonly maxPrediction: number;
  private transport: Transport;
  private now: () => number;

  /** Last simulated frame; the runtime holds the state after it. */
  frame = 0;
  private snaps = new Map<number, Snapshot>();
  /** Confirmed inputs per seat by frame. */
  private inputs = new Map<number, Map<number, PlayerInput>>();
  /** Highest frame per seat with no gaps in its confirmed inputs. */
  private lastConf = new Map<number, number>();
  /** Inputs used when each frame was last simulated. */
  private used = new Map<number, PlayerInput[]>();
  /** Highest frame of our inputs each peer holds. */
  private peerAck = new Map<number, number>();
  private peerFrame = new Map<number, number>();
  private peerHeard = new Map<number, number>();
  private rtt = new Map<number, number>();
  private advantageAvg = 0;
  private skipCooldown = 0;
  private rollbackFrom = Infinity;
  private myHashes = new Map<number, number>();
  private theirHashes = new Map<string, number>();
  private checkOut = { frame: 0, hash: 0 };
  /** Sound events per frame from the latest simulation of that frame. */
  readonly soundByFrame = new Map<number, SoundEvent[]>();
  stats: SessionStats = { frame: 0, rollbacks: 0, rolledFrames: 0, stalls: 0, pings: {}, advantage: 0, waitingFor: [], silentFor: {}, desync: null };
  /** Called after each frame is simulated, with whether it was a re-simulation. */
  onFrame: ((frame: number, resim: boolean, sounds: SoundEvent[]) => void) | null = null;
  /** A player said they are leaving the game. */
  onBye: ((seat: number) => void) | null = null;
  /** Called once per frame, in order, when every seat's input for it is confirmed, with the four slots' inputs and the state after it. */
  onConfirmed: ((frame: number, inputs: PlayerInput[], after: Snapshot) => void) | null = null;
  private reported = 0;

  constructor(o: SessionOptions) {
    this.rt = o.rt;
    this.local = o.local;
    this.seats = [...o.seats];
    this.delay = o.delay;
    this.maxPrediction = o.maxPrediction ?? 10;
    this.transport = o.transport;
    this.now = o.now ?? (() => performance.now());
    this.rt.io.netMode = true;
    for (const s of this.seats) {
      const m = new Map<number, PlayerInput>();
      // The first `delay` frames have no one's input yet.
      for (let f = 1; f <= this.delay; f++) m.set(f, EMPTY);
      this.inputs.set(s, m);
      this.lastConf.set(s, this.delay);
      this.peerAck.set(s, this.delay);
      this.peerFrame.set(s, 0);
      this.peerHeard.set(s, this.now());
    }
    this.snaps.set(0, saveSnapshot(this.rt));
  }

  /** Seats that left, with the last frame their real input counts for; after it their input is empty. */
  private dropped = new Map<number, number>();

  private get remotes(): number[] {
    return this.seats.filter((s) => s !== this.local && !this.dropped.has(s));
  }

  private inputFor(seat: number, f: number): PlayerInput {
    const until = this.dropped.get(seat);
    if (until !== undefined && f > until) return EMPTY;
    const conf = this.inputs.get(seat)!.get(f);
    if (conf) return conf;
    const last = this.inputs.get(seat)!.get(this.lastConf.get(seat)!) ?? EMPTY;
    return { keys: last.keys };
  }

  private simulate(f: number, resim: boolean): void {
    const slots: PlayerInput[] = [EMPTY, EMPTY, EMPTY, EMPTY];
    const used: PlayerInput[] = [];
    for (const s of this.seats) {
      const inp = this.inputFor(s, f);
      slots[s] = inp;
      used[s] = inp;
    }
    this.used.set(f, used);
    this.rt.soundEvents.length = 0;
    this.rt.stepFrame(slots);
    const sounds = this.rt.soundEvents.splice(0);
    this.soundByFrame.set(f, sounds);
    this.snaps.set(f, saveSnapshot(this.rt));
    this.frame = f;
    this.onFrame?.(f, resim, sounds);
  }

  /** Handles a packet from a peer. */
  receive(data: ArrayBuffer): void {
    const p = decodePacket(data);
    if (!p || !this.seats.includes(p.from) || p.from === this.local) return;
    this.peerHeard.set(p.from, this.now());
    if (p.kind === Kind.Bye) {
      this.onBye?.(p.from);
      return;
    }
    if (p.kind === Kind.Ping) {
      this.transport.send(p.from, encodePacket({ kind: Kind.Pong, from: this.local, t: p.t }));
      return;
    }
    if (p.kind === Kind.Pong) {
      const sample = this.now() - p.t;
      const prev = this.rtt.get(p.from);
      this.rtt.set(p.from, prev === undefined ? sample : prev * 0.8 + sample * 0.2);
      return;
    }
    this.onInputs(p as InputPacket);
  }

  private onInputs(p: InputPacket): void {
    const s = p.from;
    const map = this.inputs.get(s)!;
    let last = this.lastConf.get(s)!;
    p.inputs.forEach((inp, i) => {
      const g = p.first + i;
      if (g !== last + 1) return;
      map.set(g, inp);
      last = g;
      if (g <= this.frame) {
        const u = this.used.get(g);
        if (!u || !sameInput(u[s], inp)) this.rollbackFrom = Math.min(this.rollbackFrom, g);
      }
    });
    this.lastConf.set(s, last);
    this.peerAck.set(s, Math.max(this.peerAck.get(s)!, p.ack));
    this.peerFrame.set(s, Math.max(this.peerFrame.get(s)!, p.frame));
    if (p.checkFrame) {
      this.theirHashes.set(`${s}:${p.checkFrame}`, p.checkHash);
      this.compareHash(s, p.checkFrame);
    }
  }

  private compareHash(seat: number, f: number): void {
    const mine = this.myHashes.get(f);
    const theirs = this.theirHashes.get(`${seat}:${f}`);
    if (mine === undefined || theirs === undefined) return;
    if (mine !== theirs && !this.stats.desync) this.stats.desync = { frame: f, seat };
    this.theirHashes.delete(`${seat}:${f}`);
  }

  private rollback(): void {
    const from = this.rollbackFrom;
    this.rollbackFrom = Infinity;
    if (from > this.frame) return;
    const snap = this.snaps.get(from - 1);
    if (!snap) throw new Error(`no snapshot for frame ${from - 1}; rollback window exceeded`);
    const end = this.frame;
    loadSnapshot(this.rt, snap);
    this.stats.rollbacks++;
    this.stats.rolledFrames += end - from + 1;
    for (let f = from; f <= end; f++) this.simulate(f, true);
  }

  /** Frames up to which every seat's input is confirmed. */
  confirmedFrame(): number {
    let m = Infinity;
    for (const s of this.seats) if (!this.dropped.has(s)) m = Math.min(m, this.lastConf.get(s)!);
    // A correction that arrived but is not re-simulated yet makes later frames provisional.
    return Math.min(m, this.frame, this.rollbackFrom - 1);
  }

  /** One fixed-rate tick: takes local input, corrects mispredictions, and advances one frame when allowed. */
  /** Advances one frame if peers allow it. Returns false when `localInput` was not used. */
  tick(localInput: PlayerInput): boolean {
    if (this.rollbackFrom <= this.frame) this.rollback();
    const next = this.frame + 1;
    let oldest = Infinity;
    const waiting: number[] = [];
    for (const s of this.remotes) {
      const c = this.lastConf.get(s)!;
      oldest = Math.min(oldest, c);
      if (next - c > this.maxPrediction) waiting.push(s);
    }
    this.stats.waitingFor = waiting.filter((s) => this.now() - this.peerHeard.get(s)! > SILENT_MS);
    for (const s of this.remotes) this.stats.silentFor[s] = this.now() - this.peerHeard.get(s)!;
    let advance = waiting.length === 0;

    // Time sync: a peer that is behind us gets a frame to catch up now and then.
    this.updateAdvantage();
    if (advance && this.skipCooldown <= 0 && this.advantageAvg > 1.0) {
      advance = false;
      this.skipCooldown = 6;
    }
    if (this.skipCooldown > 0) this.skipCooldown--;

    if (advance) {
      const f = next + this.delay;
      this.inputs.get(this.local)!.set(f, asSent(localInput));
      this.lastConf.set(this.local, f);
      this.simulate(next, false);
    } else {
      this.stats.stalls++;
    }
    this.checksum();
    this.reportConfirmed();
    this.sendInputs();
    this.prune();
    this.stats.frame = this.frame;
    this.stats.advantage = this.advantageAvg;
    void oldest;
    return advance;
  }

  private updateAdvantage(): void {
    let worst = -Infinity;
    for (const s of this.remotes) {
      const rttFrames = (this.rtt.get(s) ?? 0) / FRAME_MS;
      const theirs = this.peerFrame.get(s)! + rttFrames / 2;
      worst = Math.max(worst, this.frame - theirs);
    }
    if (worst === -Infinity) worst = 0;
    this.advantageAvg = this.advantageAvg * 0.9 + worst * 0.1;
  }

  private reportConfirmed(): void {
    if (!this.onConfirmed) return;
    const c = this.confirmedFrame();
    while (this.reported < c) {
      const f = ++this.reported;
      const used = this.used.get(f);
      const after = this.snaps.get(f);
      if (used && after) this.onConfirmed(f, [0, 1, 2, 3].map((s) => used[s] ?? EMPTY), after);
    }
  }

  private checksum(): void {
    const c = this.confirmedFrame();
    const f = c - (c % CHECK_EVERY);
    if (f <= 0 || this.myHashes.has(f)) return;
    const snap = this.snaps.get(f);
    if (!snap) return;
    const h = snapshotHash(snap);
    this.myHashes.set(f, h);
    this.checkOut = { frame: f, hash: h };
    for (const s of this.remotes) this.compareHash(s, f);
  }

  private sendInputs(): void {
    const mine = this.inputs.get(this.local)!;
    const last = this.lastConf.get(this.local)!;
    for (const s of this.remotes) {
      const first = Math.max(this.peerAck.get(s)! + 1, last - SEND_WINDOW + 1);
      const list: PlayerInput[] = [];
      for (let f = first; f <= last; f++) list.push(mine.get(f) ?? EMPTY);
      const p: Packet = {
        kind: Kind.Inputs,
        from: this.local,
        ack: this.lastConf.get(s)!,
        frame: this.frame,
        first,
        inputs: list,
        checkFrame: this.checkOut.frame,
        checkHash: this.checkOut.hash,
      };
      this.transport.send(s, encodePacket(p));
    }
  }

  /**
   * Host side of dropping a seat that left: the last frame of its input everyone will use, and the
   * inputs this peer holds up to that frame, for peers that received fewer of them.
   */
  dropOffer(seat: number): { frame: number; data: ArrayBuffer } {
    const frame = this.lastConf.get(seat)!;
    const map = this.inputs.get(seat)!;
    let first = frame;
    while (first > 1 && map.has(first - 1) && frame - first < 120) first--;
    const list: PlayerInput[] = [];
    for (let f = first; f <= frame; f++) list.push(map.get(f) ?? EMPTY);
    const p: Packet = { kind: Kind.Inputs, from: seat, ack: 0, frame: 0, first, inputs: list, checkFrame: 0, checkHash: 0 };
    return { frame, data: encodePacket(p) };
  }

  /** Every peer applies the same drop: real input through `frame`, empty input after it. */
  applyDrop(seat: number, frame: number, data: ArrayBuffer): boolean {
    if (this.dropped.has(seat) || seat === this.local) return false;
    const p = decodePacket(data);
    if (!p || p.kind !== Kind.Inputs) return false;
    const map = this.inputs.get(seat)!;
    let last = this.lastConf.get(seat)!;
    p.inputs.forEach((inp, i) => {
      const g = p.first + i;
      if (g === last + 1 && g <= frame) {
        map.set(g, inp);
        last = g;
      }
    });
    if (last < frame) return false;
    for (const f of [...map.keys()]) if (f > frame) map.delete(f);
    this.lastConf.set(seat, frame);
    this.dropped.set(seat, frame);
    for (let f = Math.max(1, frame - this.maxPrediction * 4); f <= this.frame; f++) {
      const u = this.used.get(f);
      if (u && !sameInput(u[seat], this.inputFor(seat, f))) {
        this.rollbackFrom = Math.min(this.rollbackFrom, f);
        break;
      }
    }
    return true;
  }

  /** The packet that tells the other players this one is leaving. */
  goodbye(): ArrayBuffer {
    return encodePacket({ kind: Kind.Bye, from: this.local, t: 0 });
  }

  /** Sends round-trip probes; call about once a second. */
  probe(): void {
    for (const s of this.remotes) this.transport.send(s, encodePacket({ kind: Kind.Ping, from: this.local, t: this.now() }));
    for (const s of this.remotes) this.stats.pings[s] = Math.round(this.rtt.get(s) ?? 0);
  }

  private prune(): void {
    const keepFrom = this.confirmedFrame() - this.maxPrediction - 4;
    for (const f of this.snaps.keys()) if (f < keepFrom && f < this.frame - this.maxPrediction - 2) this.snaps.delete(f);
    for (const f of this.used.keys()) if (f < keepFrom) this.used.delete(f);
    for (const f of this.soundByFrame.keys()) if (f < this.frame - 120) this.soundByFrame.delete(f);
    let ackMin = Infinity;
    for (const s of this.remotes) ackMin = Math.min(ackMin, this.peerAck.get(s)!);
    for (const s of this.seats) {
      const m = this.inputs.get(s)!;
      const limit = Math.min(keepFrom, s === this.local ? ackMin : Infinity, this.lastConf.get(s)!) - 1;
      for (const f of m.keys()) if (f < limit) m.delete(f);
    }
    for (const f of this.myHashes.keys()) if (f < this.frame - 600) this.myHashes.delete(f);
  }
}
