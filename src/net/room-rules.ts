// The rules of a matchmaking room as a plain class, so tests drive it without the Worker runtime.
// A room seats two players, starts the game for both at once, and forwards
// connection setup messages between them. It never runs the game.
import { HOLD_SECONDS, SEATS, type FromRoom, type SeatInfo, type StartInfo, type ToRoom } from './protocol.ts';
import { encodePacket, Kind, toBase64 } from './wire.ts';

export interface SeatState {
  name: string;
  token: string;
  connected: boolean;
  /** When the seat's socket dropped, or null while connected. */
  awaySince: number | null;
}

export interface RoomData {
  build: string | null;
  seats: (SeatState | null)[];
  host: number;
  start: StartInfo | null;
  created: number;
}

/** A message for one seat, or for every connected seat when `seat` is -1. */
export type Out = { seat: number; m: FromRoom }[];

export function newRoom(now: number): RoomData {
  return { build: null, seats: Array.from({ length: SEATS }, () => null), host: 0, start: null, created: now };
}

export class RoomRules {
  constructor(public d: RoomData) {}

  private seatList(): SeatInfo[] {
    const out: SeatInfo[] = [];
    this.d.seats.forEach((s, i) => {
      if (s) out.push({ seat: i, name: s.name, connected: s.connected });
    });
    return out;
  }

  private seatsMsg(): FromRoom {
    return { type: 'seats', host: this.d.host, seats: this.seatList() };
  }

  private pickHost(): void {
    const cur = this.d.seats[this.d.host];
    if (cur && cur.connected) return;
    const next = this.d.seats.findIndex((s) => s && s.connected);
    if (next >= 0) this.d.host = next;
  }

  /** Handles a message from a socket. `seat` is the socket's seat, or null before hello. */
  handle(seat: number | null, m: ToRoom, now: number, token: () => string, seed: () => number): { out: Out; seat?: number; close?: string } {
    const out: Out = [];
    if (m.type === 'hello') {
      if (seat !== null) return { out };
      if (this.d.build && this.d.build !== m.build) return { out, close: 'This room was made by a different version of the game. Reload the page.' };
      this.d.build = m.build;
      if ('resume' in m) {
        const i = this.d.seats.findIndex((s) => s && s.token === m.resume);
        if (i < 0) return { out, close: 'That seat is no longer held.' };
        const s = this.d.seats[i]!;
        s.connected = true;
        s.awaySince = null;
        this.pickHost();
        out.push({ seat: i, m: { type: 'welcome', seat: i, token: s.token, host: this.d.host, seats: this.seatList(), start: this.d.start } });
        out.push({ seat: -1, m: this.seatsMsg() });
        return { out, seat: i };
      }
      if (this.d.start) return { out, close: 'This game has already started.' };
      const i = this.d.seats.findIndex((s) => s === null);
      if (i < 0) return { out, close: 'This room is full.' };
      const s: SeatState = { name: m.name, token: token(), connected: true, awaySince: null };
      this.d.seats[i] = s;
      if (!this.d.seats[this.d.host]) this.d.host = i;
      this.pickHost();
      out.push({ seat: i, m: { type: 'welcome', seat: i, token: s.token, host: this.d.host, seats: this.seatList(), start: null } });
      out.push({ seat: -1, m: this.seatsMsg() });
      return { out, seat: i };
    }
    if (seat === null) return { out, close: 'Say hello first.' };
    switch (m.type) {
      case 'start': {
        if (seat !== this.d.host || this.d.start) return { out };
        const seats = this.d.seats.map((s, i) => (s && s.connected ? i : -1)).filter((i) => i >= 0);
        this.d.start = { seed: seed(), t0: m.t0, seats, delay: m.delay };
        out.push({ seat: -1, m: { type: 'go', start: this.d.start } });
        return { out };
      }
      case 'signal':
        if (m.to !== seat && this.d.seats[m.to]) out.push({ seat: m.to, m: { type: 'signal', from: seat, data: m.data } });
        return { out };
      case 'relay':
        if (m.to !== seat && this.d.seats[m.to]?.connected) out.push({ seat: m.to, m: { type: 'relay', from: seat, data: m.data } });
        return { out };
      case 'drop': {
        // Only the host decides, only during a game, and never about itself. The seat is released for good.
        if (seat !== this.d.host || !this.d.start || m.seat === seat || !this.d.seats[m.seat]) return { out };
        this.d.seats[m.seat] = null;
        this.d.seats.forEach((s, i) => {
          if (s && s.connected && i !== seat) out.push({ seat: i, m: { type: 'dropped', seat: m.seat, frame: m.frame, data: m.data } });
        });
        out.push({ seat: -1, m: this.seatsMsg() });
        return { out };
      }
      case 'leave':
        out.push(...this.drop(seat, now, true));
        return { out, close: 'left' };
      case 'ping':
        out.push({ seat, m: { type: 'pong' } });
        return { out };
    }
    return { out };
  }

  /**
   * A socket closed or left. Before the start the seat frees at once. After it, a seat that left (Leave, or a
   * closed page) is gone and the other players hear its goodbye, and a seat whose connection broke is held.
   */
  drop(seat: number, now: number, left = false): Out {
    const s = this.d.seats[seat];
    if (!s) return [];
    const bye = this.d.start && left && s.connected ? this.goodbye(seat) : [];
    if (!this.d.start || left) {
      if (!this.d.start) this.d.seats[seat] = null;
      else {
        s.connected = false;
        s.awaySince = now - HOLD_SECONDS * 1000;
      }
    } else {
      s.connected = false;
      s.awaySince = now;
    }
    this.pickHost();
    return [...bye, { seat: -1, m: this.seatsMsg() }];
  }

  /** The leaving seat's goodbye packet, relayed to everyone else so their games stop waiting for it. */
  private goodbye(seat: number): Out {
    const data = toBase64(encodePacket({ kind: Kind.Bye, from: seat, t: 0 }));
    const out: Out = [];
    this.d.seats.forEach((s, i) => {
      if (s && s.connected && i !== seat) out.push({ seat: i, m: { type: 'relay', from: seat, data } });
    });
    return out;
  }

  /** Releases seats whose hold ran out; returns true when the room is empty. */
  expire(now: number): boolean {
    this.d.seats.forEach((s, i) => {
      if (s && !s.connected && s.awaySince !== null && now - s.awaySince > HOLD_SECONDS * 1000) {
        if (!this.d.start) this.d.seats[i] = null;
      }
    });
    return this.d.seats.every((s) => !s || !s.connected);
  }
}
