// Online names are Scratch usernames. A room seats a name only when a Scratch account has it, and never
// a Scratch Team member's name. Made-up names (`player` and digits) skip the check.
import { isGeneratedName } from '../../src/net/protocol';

const USERS = 'https://api.scratch.mit.edu/users/';
const TIMEOUT_MS = 4000;

export type NameCheck = { ok: true; name: string; unchecked?: string } | { ok: false; reason: string; why: string };

/** Checks a name the protocol reader accepted. The account's own capitalization replaces the name's. */
export async function checkName(name: string): Promise<NameCheck> {
  if (isGeneratedName(name)) return { ok: true, name };
  let res: Response;
  try {
    res = await fetch(USERS + encodeURIComponent(name), {
      headers: { accept: 'application/json', 'user-agent': 'game-rooms' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Online play goes on when the account service cannot be reached.
    return { ok: true, name, unchecked: String(e) };
  }
  if (res.status === 404) {
    return { ok: false, why: 'no-account', reason: `There is no Scratch account named ${name}. Use your Scratch username, or a name like player1234.` };
  }
  if (!res.ok) return { ok: true, name, unchecked: `status ${res.status}` };
  const user = (await res.json().catch(() => null)) as { username?: unknown; scratchteam?: unknown } | null;
  if (user?.scratchteam === true) return { ok: false, why: 'scratch-team', reason: 'The names of Scratch Team members cannot be used.' };
  const own = typeof user?.username === 'string' && user.username.toLowerCase() === name.toLowerCase() ? user.username : name;
  return { ok: true, name: own };
}
