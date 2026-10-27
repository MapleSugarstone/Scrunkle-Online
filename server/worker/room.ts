// One room: seats players, starts the game for everyone at once, forwards connection setup
// messages, and relays inputs only for players whose direct connection failed. Sockets use the
// hibernation API, so an idle room costs nothing.
import { DurableObject } from 'cloudflare:workers';
import { readClient, type FromRoom } from '../../src/net/protocol';
import { newRoom, RoomRules, type Out, type RoomData } from '../../src/net/room-rules';
import type { Env } from './env';
import { log } from './log';
import { checkName } from './scratch-name';

interface Tag {
  seat: number | null;
  since: number;
  count: number;
}

/** Messages one socket may send in a window. Relaying inputs sends about 30 a second to each of up to 3 other players. */
const FLOOD_MAX = 1800;
const FLOOD_WINDOW_MS = 10_000;
const SOCKETS_MAX = 8;
const IDLE_MS = 6 * 60 * 60 * 1000;

export class Room extends DurableObject<Env> {
  private data: RoomData | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  private async load(): Promise<RoomData> {
    if (!this.data) this.data = (await this.ctx.storage.get<RoomData>('room')) ?? newRoom(Date.now());
    return this.data;
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put('room', this.data);
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  private tagOf(ws: WebSocket): Tag {
    const t = ws.deserializeAttachment() as Partial<Tag> | null;
    return { seat: t?.seat ?? null, since: t?.since ?? 0, count: t?.count ?? 0 };
  }

  private deliver(out: Out): void {
    const sockets = this.ctx.getWebSockets();
    for (const { seat, m } of out) {
      for (const ws of sockets) {
        const s = this.tagOf(ws).seat;
        if (s !== null && (seat === -1 || s === seat)) send(ws, m);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (this.ctx.getWebSockets().length >= SOCKETS_MAX) return new Response('room is full', { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat: null, since: Date.now(), count: 0 } satisfies Tag);
    await this.load();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const now = Date.now();
    const tag = this.tagOf(ws);
    if (now - tag.since > FLOOD_WINDOW_MS) {
      tag.since = now;
      tag.count = 0;
    }
    if (++tag.count > FLOOD_MAX) {
      log('room-flood', { room: this.id(), seat: tag.seat });
      shut(ws, 1008, 'too many messages');
      return;
    }
    const read = readClient(raw);
    if ('why' in read) {
      log('room-bad-message', { room: this.id(), seat: tag.seat, why: read.why });
      shut(ws, 1008, read.why);
      return;
    }
    if (read.m.type === 'hello' && 'name' in read.m && tag.seat === null) {
      const named = await checkName(read.m.name);
      if (!named.ok) {
        log('room-name-refused', { room: this.id(), why: named.why });
        send(ws, { type: 'refused', reason: named.reason });
        shut(ws, 1000, 'closed');
        return;
      }
      if (named.unchecked) log('room-name-unchecked', { room: this.id(), error: named.unchecked });
      // Other messages run while the check waits, so a second hello from this socket may have taken a seat.
      if (this.tagOf(ws).seat !== null) return;
      read.m.name = named.name;
    }
    const d = await this.load();
    const rules = new RoomRules(d);
    const before = JSON.stringify(d);
    const r = rules.handle(tag.seat, read.m, now, () => crypto.randomUUID(), () => crypto.getRandomValues(new Uint32Array(1))[0]);
    if (r.seat !== undefined) {
      // A rejoin replaces any older socket on the same seat.
      for (const other of this.ctx.getWebSockets()) if (other !== ws && this.tagOf(other).seat === r.seat) shut(other, 4000, 'replaced');
      tag.seat = r.seat;
      log('room-seat', { room: this.id(), seat: r.seat, resume: read.m.type === 'hello' && 'resume' in read.m, started: d.start !== null });
    }
    ws.serializeAttachment(tag);
    this.deliver(r.out);
    if (read.m.type === 'start' && d.start) log('room-start', { room: this.id(), seats: d.start.seats, delay: d.start.delay });
    if (read.m.type === 'drop') log('room-drop', { room: this.id(), by: tag.seat, seat: read.m.seat, frame: read.m.frame });
    if (r.close) {
      if (r.close !== 'left') {
        log('room-refused', { room: this.id(), seat: tag.seat, reason: r.close });
        send(ws, { type: 'refused', reason: r.close });
      }
      shut(ws, 1000, 'closed');
    }
    // Relayed inputs and signaling do not change the room record, so most messages write nothing.
    if (JSON.stringify(d) !== before) await this.save();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    log('room-socket-closed', { room: this.id(), seat: this.tagOf(ws).seat, code, reason, wasClean });
    // Browsers close with 1001 when the page closes or navigates away. A broken connection closes with 1006.
    await this.closed(ws, code === 1001);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    log('room-socket-error', { room: this.id(), seat: this.tagOf(ws).seat, error: String(error) });
    await this.closed(ws);
  }

  /** A short form of this room's object id, enough to group one room's log lines. */
  private id(): string {
    return this.ctx.id.toString().slice(0, 12);
  }

  private async closed(ws: WebSocket, left = false): Promise<void> {
    const seat = this.tagOf(ws).seat;
    if (seat === null) return;
    const others = this.ctx.getWebSockets().filter((o) => o !== ws && this.tagOf(o).seat === seat);
    if (others.length) return;
    const d = await this.load();
    this.deliver(new RoomRules(d).drop(seat, Date.now(), left));
    await this.save();
  }

  async alarm(): Promise<void> {
    const d = await this.load();
    const empty = new RoomRules(d).expire(Date.now());
    if (empty && Date.now() - d.created > 60_000 && this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.data = null;
      return;
    }
    await this.ctx.storage.put('room', d);
    if (Date.now() - d.created < IDLE_MS) await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }
}

function send(ws: WebSocket, m: FromRoom): void {
  try {
    ws.send(JSON.stringify(m));
  } catch {
    // The socket closed between the check and the send.
  }
}

function shut(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason.slice(0, 120));
  } catch {
    // Already closed.
  }
}
