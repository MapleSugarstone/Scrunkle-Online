// The browser end of a matchmaking room: join-code requests, the room socket with pings, and a
// reconnect that takes a dropped seat back with its token. Every message from the room passes
// `readRoom` before anything reads it.
import { readQueueReply, readRoom, type FromRoom, type QueueReply, type ToRoom } from './protocol.ts';

declare const __BUILD__: string;
declare const __RELAY_URL__: string;

/** The site's build fingerprint, so rooms only pair identical games. */
export const BUILD: string = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

const PING_MS = 10_000;
const RETRY_MS = 1_500;
const RETRY_LIMIT = 20;

/** Where the rooms are: this page's origin while developing (Vite forwards /api), else the deployed Worker. */
export function relayBase(): string {
  if (import.meta.env?.DEV) return location.origin;
  return typeof __RELAY_URL__ === 'string' ? __RELAY_URL__ : '';
}

/** False for a published build made without a room server address. */
export const onlineAvailable = (): boolean => relayBase() !== '';

async function post(path: string, body: object): Promise<QueueReply> {
  try {
    const res = await fetch(`${relayBase()}/api/queue/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return readQueueReply(await res.json()) ?? { ok: false, reason: 'The lobby sent an answer this version cannot read.' };
  } catch {
    return { ok: false, reason: 'The matchmaking server could not be reached.' };
  }
}

export const hostRoom = (): Promise<QueueReply> => post('host', { build: BUILD });
export const joinRoom = (code: string): Promise<QueueReply> => post('join', { build: BUILD, code });
export const cancelRoom = (code: string): Promise<QueueReply> => post('cancel', { build: BUILD, code });

export class RoomClient {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private retries = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;
  /** Why the room turned this player away, once it has. */
  refusal: string | null = null;
  seat = -1;
  onMessage: (m: FromRoom) => void = () => {};
  onStatus: (s: 'open' | 'reconnecting' | 'closed', why?: string) => void = () => {};

  constructor(private room: string, private name: string) {}

  get id(): string {
    return this.room;
  }

  connect(): void {
    const base = relayBase().replace(/^http/, 'ws');
    const ws = new WebSocket(`${base}/api/room/${this.room}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      const hello: ToRoom = this.token ? { type: 'hello', build: BUILD, resume: this.token } : { type: 'hello', build: BUILD, name: this.name };
      ws.send(JSON.stringify(hello));
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_MS);
      this.onStatus('open');
    };
    ws.onmessage = (e) => {
      const m = readRoom(e.data);
      if (!m) return;
      if (m.type === 'welcome') {
        this.seat = m.seat;
        this.token = m.token;
      }
      if (m.type === 'refused') {
        this.closedByUs = true;
        this.refusal = m.reason;
      }
      this.onMessage(m);
    };
    ws.onclose = (e) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      const why = `${e.code} ${e.reason}`.trim();
      if (this.closedByUs || this.retries >= RETRY_LIMIT) {
        this.onStatus('closed', why);
        return;
      }
      this.retries++;
      this.onStatus('reconnecting', why);
      setTimeout(() => this.connect(), RETRY_MS);
    };
  }

  send(m: ToRoom): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.closedByUs = true;
    this.send({ type: 'leave' });
    this.ws?.close();
  }
}
