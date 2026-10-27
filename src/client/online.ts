// An online game: the shared simulation driven by the rollback session, with sound that follows
// corrections, a status line for connection quality, and continuing without a player who left.
import type { PlayerInput } from '../engine/io.ts';
import type { SoundEvent } from '../engine/sound-model.ts';
import { RollbackSession } from '../net/rollback.ts';
import type { Mesh } from '../net/mesh.ts';
import type { RoomClient } from '../net/room-client.ts';
import type { SeatInfo, StartInfo } from '../net/protocol.ts';
import { report, reportContext } from '../net/report.ts';
import { fromBase64, toBase64 } from '../net/wire.ts';
import { loadControls, seatKeys, translateKeys } from './controls.ts';
import { actionKeys, type Pads } from './pads.ts';
import { seatScreen } from '../game/screens.ts';
import { Game, startFixedLoop } from './game.ts';
import type { LocalInput } from './input.ts';

/** Plays sounds once per frame even when a frame is simulated again after a correction. */
class RollbackAudio {
  private played = new Map<number, Set<string>>();

  constructor(private game: Game) {}

  frame(f: number, resim: boolean, sounds: SoundEvent[]): void {
    const audio = this.game.audio;
    const before = this.played.get(f) ?? new Set<string>();
    const now = new Set<string>();
    const out: SoundEvent[] = [];
    for (const e of sounds) {
      if (e.kind === 'play') {
        const key = `${e.sprite}:${e.sound}`;
        now.add(key);
        if (resim && before.has(key)) continue;
      }
      out.push(e);
    }
    if (resim) {
      for (const key of before) {
        if (!now.has(key)) {
          const [s, n] = key.split(':').map(Number);
          audio.stopSound(s, n);
        }
      }
    }
    this.played.set(f, now);
    if (this.played.size > 200) {
      for (const k of this.played.keys()) if (k < f - 150) this.played.delete(k);
    }
    audio.apply(out);
  }
}

export interface OnlineHud {
  update(text: string, warn: string): void;
  /** Shows one button, or none for a null label. */
  action(label: string | null, onClick: () => void): void;
  /** Shows the waiting panel over the stage, or hides it for a null title. */
  waiting(title: string | null, text?: string, button?: { label: string; onClick: () => void } | null): void;
}

/** Seconds the game waits on a player before the panel offers the host to continue without them. */
const PROMPT_AFTER_S = 3;
/** Milliseconds a "left the game" notice stays in the status line. */
const NOTICE_MS = 5_000;
const FREEZE_REPORT_MS = 5_000;
const AWAY_SILENT_MS = 1_000;

export class OnlineGame {
  session: RollbackSession;
  private stop: (() => void) | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private away = new Set<number>();
  private dropped = new Set<number>();
  /** Seats that said goodbye: they closed the page or chose Leave. */
  private left = new Set<number>();
  private notice: { text: string; until: number } | null = null;
  private stuckSince: number | null = null;
  private freezeReported = false;
  private desyncReported = false;
  host: number;

  constructor(
    public game: Game,
    private room: RoomClient,
    private mesh: Mesh,
    public start: StartInfo,
    public local: number,
    private names: Map<number, string>,
    private hud: OnlineHud,
    host: number,
  ) {
    this.host = host;
    this.session = new RollbackSession({
      rt: game.rt,
      local,
      seats: start.seats,
      delay: start.delay,
      maxPrediction: 10,
      transport: { send: (seat, data) => mesh.send(seat, data) },
    });
    const audio = new RollbackAudio(game);
    this.session.onFrame = (f, resim, sounds) => audio.frame(f, resim, sounds);
    mesh.onPacket = (data) => this.session.receive(data);
    this.session.onBye = (seat) => this.left.add(seat);
    reportContext.room = room.id;
    reportContext.seat = local;
    reportContext.online = true;
    mesh.onFallback = (seat, reason) => report('link-fallback', { seat, reason, ...this.diagnostics() });
  }

  /** The session and link state that problem reports carry. */
  diagnostics(): Record<string, unknown> {
    const st = this.session.stats;
    return {
      frame: st.frame,
      confirmed: this.session.confirmedFrame(),
      seats: this.start.seats,
      delay: this.start.delay,
      waitingFor: st.waitingFor,
      away: [...this.away],
      dropped: [...this.dropped],
      silentFor: st.silentFor,
      pings: st.pings,
      rollbacks: st.rollbacks,
      stalls: st.stalls,
      advantage: st.advantage,
      links: this.mesh.describe(),
    };
  }

  /** Seat list updates from the room: who is connected and who hosts now. */
  seatsChanged(seats: SeatInfo[], host: number): void {
    this.host = host;
    this.away.clear();
    for (const s of this.start.seats) {
      const info = seats.find((x) => x.seat === s);
      if (s !== this.local && !this.dropped.has(s) && (!info || !info.connected)) this.away.add(s);
    }
  }

  /** The room announced that the host continues without a seat. */
  onDropped(seat: number, frame: number, data: string): void {
    if (this.dropped.has(seat)) return;
    if (this.session.applyDrop(seat, frame, fromBase64(data))) this.wentOn(seat);
  }

  private wentOn(seat: number): void {
    this.dropped.add(seat);
    this.notice = { text: `${this.name(seat)} left the game.`, until: performance.now() + NOTICE_MS };
  }

  private dropSeat(seat: number): void {
    if (this.dropped.has(seat)) return;
    const offer = this.session.dropOffer(seat);
    if (!this.session.applyDrop(seat, offer.frame, offer.data)) return;
    this.wentOn(seat);
    this.room.send({ type: 'drop', seat, frame: offer.frame, data: toBase64(offer.data) });
  }

  run(input: LocalInput, pads: Pads): void {
    this.probeTimer = setInterval(() => this.session.probe(), 1000);
    this.mesh.watch();
    const own = loadControls();
    this.stop = startFixedLoop(
      () => {
        const pressed = input.sampleKeys();
        // Every controller and the touch controls play this player's own seat.
        const acts = pads.sample().flat();
        // Shared menus take everyone's keys as Player 1's; character select and matches take each seat's own.
        const seat = seatKeys(this.game.rt, seatScreen(this.game.rt) ? this.local : 0);
        const keys = new Set(translateKeys(pressed, own, seat));
        for (const k of actionKeys(acts, seat)) keys.add(k);
        const p: PlayerInput = { keys: [...keys] };
        // Only the first seat drives the shared mouse pointer.
        const mouse = this.local === this.start.seats[0] ? input.sampleMouse() : undefined;
        if (mouse) p.mouse = mouse;
        if (this.game.question.pendingAnswer !== undefined) {
          p.answer = this.game.question.pendingAnswer;
          this.game.question.pendingAnswer = undefined;
        }
        if (!this.session.tick(p)) {
          // The frame did not advance, so offer the same input again next tick.
          input.retap(pressed);
          pads.retap(acts);
          if (p.mouse) input.remouse(p.mouse);
          if (p.answer !== undefined) this.game.question.pendingAnswer ??= p.answer;
        }
      },
      () => {
        this.game.present();
        this.updateHud();
      },
    );
  }

  private name(s: number): string {
    return this.names.get(s) ?? `P${s + 1}`;
  }

  private updateHud(): void {
    const st = this.session.stats;
    const parts: string[] = [];
    for (const s of this.start.seats) {
      if (s === this.local || this.dropped.has(s)) continue;
      const link = this.mesh.state(s);
      parts.push(`${this.name(s)}: ${st.pings[s] ?? '?'} ms ${link === 'relay' ? '(relayed)' : link === 'connecting' ? '(connecting)' : ''}`);
    }
    parts.push(`rollbacks ${st.rollbacks}`);
    let warn = '';
    // A player whose room socket is reconnecting still plays while their inputs arrive directly.
    const silentAway = [...this.away].filter((s) => (st.silentFor[s] ?? 0) > AWAY_SILENT_MS);
    const stuck = [...new Set([...st.waitingFor, ...silentAway])].filter((s) => !this.dropped.has(s));
    if (stuck.length) warn = `Waiting for ${stuck.map((s) => this.name(s)).join(', ')}...`;
    const now = performance.now();
    if (!warn && this.notice && now < this.notice.until) warn = this.notice.text;
    if (st.desync) warn = `Games went out of sync at frame ${st.desync.frame}. Please start a new room.`;
    if (!stuck.length) this.stuckSince = null;
    else if (this.stuckSince === null) this.stuckSince = now;
    else if (now - this.stuckSince > FREEZE_REPORT_MS && !this.freezeReported) {
      this.freezeReported = true;
      report('freeze', { stuck, ...this.diagnostics() });
    }
    if (!stuck.length) this.freezeReported = false;
    if (st.desync && !this.desyncReported) {
      this.desyncReported = true;
      report('desync', { desync: st.desync, ...this.diagnostics() });
    }
    this.hud.update(parts.join('  |  '), warn);
    // A player who closed the page or chose Leave said goodbye, so the host goes on without them at once.
    const isHost = this.local === this.host;
    if (isHost) for (const s of this.left) if (!this.dropped.has(s)) this.dropSeat(s);
    // Anyone else may only be slow, so after a few seconds the host decides, and everyone sees who the game waits for.
    const waited = this.stuckSince === null ? 0 : (now - this.stuckSince) / 1000;
    const on = stuck.find((s) => !this.dropped.has(s));
    if (on !== undefined && waited > PROMPT_AFTER_S && !st.desync) {
      const who = this.name(on);
      if (isHost) this.hud.waiting(`Waiting for ${who}`, `Their game has not answered for ${Math.floor(waited)} seconds. It may only be a slow connection.`, { label: `Continue without ${who}`, onClick: () => this.dropSeat(on) });
      else this.hud.waiting(`Waiting for ${who}`, `Their game has not answered for ${Math.floor(waited)} seconds. ${this.name(this.host)}, the host, can continue without them.`, null);
    } else this.hud.waiting(null);
    this.hud.action(null, () => {});
  }

  leave(): void {
    this.stop?.();
    if (this.probeTimer) clearInterval(this.probeTimer);
    // The goodbye goes both directly and through the room, so it arrives even if one way is down.
    const bye = this.session.goodbye();
    for (const s of this.start.seats) {
      if (s === this.local || this.dropped.has(s)) continue;
      this.mesh.send(s, bye);
      this.room.send({ type: 'relay', to: s, data: toBase64(bye) });
    }
    this.mesh.close();
    this.room.close();
  }
}
