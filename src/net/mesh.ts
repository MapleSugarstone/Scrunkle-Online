// Direct connections between players: one WebRTC data channel per pair, set to unordered and
// without retransmission for the lowest latency. Setup messages go through the room. If a
// direct link cannot be made, or goes quiet during a game, packets for that player also go
// through the room's relay.
import type { RoomClient } from './room-client.ts';
import { fromBase64, toBase64 } from './wire.ts';

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
const DIRECT_TIMEOUT_MS = 8_000;
/** During a game every peer sends a packet each frame, so this long without one means the link is failing. */
const QUIET_MS = 1_000;
const WATCH_MS = 250;

export type LinkState = 'connecting' | 'direct' | 'relay';

interface Link {
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  state: LinkState;
  timer: ReturnType<typeof setTimeout>;
  /** Last time a packet arrived over the direct channel. */
  heard: number;
}

export class Mesh {
  private links = new Map<number, Link>();
  private watcher: ReturnType<typeof setInterval> | null = null;
  onPacket: (data: ArrayBuffer) => void = () => {};
  onLinkChange: (seat: number, state: LinkState) => void = () => {};
  /** Called when a link switches to the relay, with the reason, for diagnostics. */
  onFallback: (seat: number, reason: string) => void = () => {};

  constructor(private room: RoomClient, readonly local: number, extraIce: RTCIceServer[] = []) {
    this.ice = [...ICE_SERVERS, ...extraIce];
  }

  private ice: RTCIceServer[];

  /** Opens links to every seat in `seats` that has none yet. The lower seat makes the offer. */
  ensure(seats: number[]): void {
    for (const s of seats) {
      if (s === this.local || this.links.has(s)) continue;
      this.open(s, this.local < s);
    }
  }

  state(seat: number): LinkState {
    return this.links.get(seat)?.state ?? 'connecting';
  }

  /** Each link's states, for problem reports. */
  describe(): Record<number, Record<string, string | number>> {
    const now = performance.now();
    const out: Record<number, Record<string, string | number>> = {};
    for (const [seat, l] of this.links) {
      out[seat] = {
        state: l.state,
        connection: l.pc.connectionState,
        ice: l.pc.iceConnectionState,
        channel: l.channel?.readyState ?? 'none',
        heardMsAgo: Math.round(now - l.heard),
      };
    }
    return out;
  }

  /** Starts checking that direct links keep delivering packets. Call once the game sends every frame. */
  watch(): void {
    if (this.watcher) return;
    const now = performance.now();
    for (const l of this.links.values()) l.heard = now;
    this.watcher = setInterval(() => {
      const t = performance.now();
      for (const [seat, l] of this.links) {
        if (l.state !== 'direct') continue;
        const cs = l.pc.connectionState;
        if (cs === 'failed' || cs === 'disconnected' || cs === 'closed') this.fallBack(seat, `connection ${cs}`, true);
        else if (l.channel?.readyState !== 'open') this.fallBack(seat, `channel ${l.channel?.readyState ?? 'missing'}`, true);
        else if (t - l.heard > QUIET_MS) this.fallBack(seat, `no direct packets for ${Math.round(t - l.heard)} ms`, true);
      }
    }, WATCH_MS);
  }

  private open(seat: number, offer: boolean): Link {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const link: Link = {
      pc,
      channel: null,
      state: 'connecting',
      timer: setTimeout(() => this.fallBack(seat, 'no direct connection in time', false), DIRECT_TIMEOUT_MS),
      heard: performance.now(),
    };
    this.links.set(seat, link);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.room.send({ type: 'signal', to: seat, data: JSON.stringify({ ice: e.candidate.toJSON() }) });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.fallBack(seat, 'connection failed', true);
    };
    const wire = (ch: RTCDataChannel) => {
      ch.binaryType = 'arraybuffer';
      link.channel = ch;
      ch.onopen = () => {
        clearTimeout(link.timer);
        link.heard = performance.now();
        if (link.state === 'connecting') {
          link.state = 'direct';
          this.onLinkChange(seat, 'direct');
        }
      };
      ch.onclose = () => this.fallBack(seat, 'channel closed', true);
      ch.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        link.heard = performance.now();
        this.onPacket(e.data);
      };
    };
    if (offer) {
      wire(pc.createDataChannel('inputs', { ordered: false, maxRetransmits: 0 }));
      void pc
        .createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => this.room.send({ type: 'signal', to: seat, data: JSON.stringify({ sdp: pc.localDescription }) }));
    } else {
      pc.ondatachannel = (e) => wire(e.channel);
    }
    return link;
  }

  /**
   * Sends this seat's packets through the relay from now on, and through the direct channel too
   * while it is open. The relay stays on for the rest of the game, because a failing link often
   * still works in one direction. `tell` asks the other player to do the same, since they may
   * still be hearing this side and not know their own packets are lost.
   */
  private fallBack(seat: number, reason: string, tell: boolean): void {
    const link = this.links.get(seat);
    if (!link || link.state === 'relay') return;
    clearTimeout(link.timer);
    link.state = 'relay';
    if (tell) this.room.send({ type: 'signal', to: seat, data: JSON.stringify({ relay: true }) });
    this.onLinkChange(seat, 'relay');
    this.onFallback(seat, reason);
  }

  /** Handles a setup message from another seat, relayed by the room. */
  async signal(from: number, data: string): Promise<void> {
    let msg: { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit; relay?: boolean };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    let link = this.links.get(from);
    if (!link) link = this.open(from, false);
    if (msg.relay) {
      this.fallBack(from, 'the other player stopped hearing this one', false);
      return;
    }
    const pc = link.pc;
    try {
      if (msg.sdp) {
        await pc.setRemoteDescription(msg.sdp);
        if (msg.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.room.send({ type: 'signal', to: from, data: JSON.stringify({ sdp: pc.localDescription }) });
        }
      } else if (msg.ice) {
        await pc.addIceCandidate(msg.ice);
      }
    } catch {
      // A failed step leaves the link to time out into the relay.
    }
  }

  /** Packets that came through the room's relay. */
  relayed(data: string): void {
    try {
      this.onPacket(fromBase64(data));
    } catch {
      // Ignore malformed relay data.
    }
  }

  send(seat: number, data: ArrayBuffer): void {
    const link = this.links.get(seat);
    if (!link) return;
    if (link.channel?.readyState === 'open' && link.state !== 'connecting') {
      try {
        link.channel.send(data);
      } catch {
        // The relay below still carries it if the link has fallen back.
      }
    }
    if (link.state === 'relay') this.room.send({ type: 'relay', to: seat, data: toBase64(data) });
  }

  close(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    for (const l of this.links.values()) {
      clearTimeout(l.timer);
      l.pc.close();
    }
    this.links.clear();
  }
}
