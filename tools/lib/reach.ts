// Decides which scripts of a Scratch project can ever run.
import type { Target } from './sb3-patch.ts';

type Block = Target['blocks'][string];
const isBlock = (b: unknown): b is Block => !!b && !Array.isArray(b) && typeof b === 'object';
export const HATS = new Set(['event_whenflagclicked', 'event_whenkeypressed', 'event_whenthisspriteclicked', 'event_whenstageclicked',
  'event_whenbackdropswitchesto', 'event_whengreaterthan', 'event_whenbroadcastreceived', 'control_start_as_clone', 'procedures_definition',
  'event_whentouchingobject']);

/**
 * The lower-case names of every message the project can send. A broadcast computed at run time can send any text the
 * project holds, so while one exists every list item, variable value and text literal counts as sent.
 */
export function sentMessages(targets: Target[]): Set<string> {
  const sent = new Set<string>();
  let computed = false;
  for (const t of targets) {
    for (const b of Object.values(t.blocks)) {
      if (!isBlock(b) || !b.opcode.startsWith('event_broadcast')) continue;
      const v = b.inputs.BROADCAST_INPUT;
      if (v?.[0] === 1 && Array.isArray(v[1])) sent.add(String(v[1][1]).toLowerCase());
      else computed = true;
    }
  }
  if (computed) {
    for (const t of targets) {
      for (const [, items] of Object.values(t.lists)) for (const v of items) sent.add(String(v).toLowerCase());
      for (const [, v] of Object.values(t.variables)) sent.add(String(v).toLowerCase());
      for (const b of Object.values(t.blocks)) {
        if (!isBlock(b)) continue;
        for (const v of Object.values(b.inputs)) if (Array.isArray(v[1]) && v[1][0] === 10) sent.add(String(v[1][1]).toLowerCase());
      }
    }
  }
  return sent;
}

export interface DeadScript { top: string; kind: 'no hat' | 'message never sent' | 'procedure never called'; what: string }

/** The top-level scripts of a target that can never run: stacks without a hat, receivers of messages nothing sends, and procedures that no live script calls. */
export function deadScripts(t: Target, sent: Set<string>): DeadScript[] {
  const dead: DeadScript[] = [];
  const definitions = new Map<string, string>();
  const live: string[] = [];
  for (const [id, b] of Object.entries(t.blocks)) {
    if (!isBlock(b)) { if (Array.isArray(b)) dead.push({ top: id, kind: 'no hat', what: String(b[1]) }); continue; }
    if (!b.topLevel) continue;
    if (!HATS.has(b.opcode)) dead.push({ top: id, kind: 'no hat', what: b.opcode });
    else if (b.opcode === 'procedures_definition') definitions.set(String((t.blocks[b.inputs.custom_block[1] as string] as Block).mutation!.proccode), id);
    else if (b.opcode === 'event_whenbroadcastreceived' && !sent.has(String(b.fields.BROADCAST_OPTION[0]).toLowerCase())) dead.push({ top: id, kind: 'message never sent', what: String(b.fields.BROADCAST_OPTION[0]) });
    else live.push(id);
  }
  // Procedures are live when a live script calls them, so follow calls until no new procedure turns up.
  const reached = new Set<string>();
  const calls = (top: string): string[] => {
    const out: string[] = [];
    const visit = (id: string | null, chain: boolean) => {
      for (; id; id = chain ? (t.blocks[id] as Block).next : null) {
        const b = t.blocks[id] as Block;
        if (b.opcode === 'procedures_call') out.push(String(b.mutation!.proccode));
        for (const [name, v] of Object.entries(b.inputs)) {
          if (typeof v[1] === 'string' && isBlock(t.blocks[v[1]])) visit(v[1], name.startsWith('SUBSTACK'));
        }
      }
    };
    visit(top, true);
    return out;
  };
  const work = [...live];
  while (work.length) {
    for (const proc of calls(work.pop()!)) {
      if (reached.has(proc) || !definitions.has(proc)) continue;
      reached.add(proc);
      work.push(definitions.get(proc)!);
    }
  }
  for (const [proc, id] of definitions) if (!reached.has(proc)) dead.push({ top: id, kind: 'procedure never called', what: proc });
  return dead;
}
