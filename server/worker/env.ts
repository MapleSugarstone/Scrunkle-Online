// The Worker's bindings, and the one lobby every request reaches.
import type { Lobby } from './lobby';
import type { Room } from './room';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  LOBBY: DurableObjectNamespace<Lobby>;
  /** Comma-separated origins that may use the rooms. Any localhost port may as well. */
  ALLOWED_ORIGINS?: string;
  /** The most rooms the lobby opens in a UTC day. */
  ROOMS_PER_DAY?: string;
}

export function lobbyOf(env: Env): DurableObjectStub<Lobby> {
  return env.LOBBY.get(env.LOBBY.idFromName('lobby'));
}
