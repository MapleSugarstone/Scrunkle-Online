// Finds, moves and deletes existing blocks of a target, for patches that change scripts without adding blocks.
import type { Target } from './sb3-patch.ts';

export type Block = Target['blocks'][string];
const SUBSTACKS = ['SUBSTACK', 'SUBSTACK2'];

export class Editor {
  constructor(readonly t: Target) {}

  get B(): Record<string, Block> {
    return this.t.blocks;
  }
  block(id: string): Block {
    const b = this.B[id];
    if (!b || Array.isArray(b)) throw new Error(`${this.t.name}: no block ${id}`);
    return b;
  }

  /** The definition block of a custom block, found by its proccode. */
  procedure(proccode: string): string {
    const proto = Object.entries(this.B).find(([, b]) => b?.opcode === 'procedures_prototype' && b.mutation?.proccode === proccode);
    if (!proto) throw new Error(`${this.t.name}: no procedure ${proccode}`);
    return proto[1].parent!;
  }
  /** The hat of the only script that runs when `message` is received. */
  receiver(message: string): string {
    const hats = Object.entries(this.B).filter(([, b]) => b?.opcode === 'event_whenbroadcastreceived' && String(b.fields.BROADCAST_OPTION[0]) === message);
    if (hats.length !== 1) throw new Error(`${this.t.name}: ${hats.length} receivers of ${message}`);
    return hats[0][0];
  }

  /** Every block of a script below `top`: statements, substacks and reporters, in order. */
  descendants(top: string, followNext = true): string[] {
    const out: string[] = [];
    const visit = (id: string | null, chain: boolean) => {
      for (; id; id = chain ? this.block(id).next : null) {
        out.push(id);
        for (const [name, v] of Object.entries(this.block(id).inputs)) {
          const child = v[1];
          if (typeof child !== 'string' || !this.B[child]) continue;
          visit(child, SUBSTACKS.includes(name));
        }
      }
    };
    visit(top, followNext);
    return out;
  }
  /** The single block under `top` that `test` accepts; throws when there is none or more than one. */
  one(top: string, what: string, test: (b: Block, id: string) => boolean): string {
    const hits = this.descendants(top).filter((id) => test(this.block(id), id));
    if (hits.length !== 1) throw new Error(`${this.t.name}: ${hits.length} blocks match ${what}`);
    return hits[0];
  }

  /** The text of a literal input, or undefined when a reporter or nothing fills it. */
  literal(id: string, input: string): string | undefined {
    const v = this.block(id).inputs[input];
    return v && v[0] === 1 && Array.isArray(v[1]) ? String(v[1][1]) : undefined;
  }
  /** The name of a variable or list reporter stored inline in an input. */
  inlineName(id: string, input: string): string | undefined {
    const v = this.block(id).inputs[input];
    return v && Array.isArray(v[1]) && (v[1][0] === 12 || v[1][0] === 13) ? String(v[1][1]) : undefined;
  }
  /** The reporter block in an input, if any. */
  child(id: string, input: string): string | undefined {
    const v = this.block(id).inputs[input];
    const c = v?.[1];
    return typeof c === 'string' && this.B[c] && !this.block(c).shadow ? c : undefined;
  }
  setLiteral(id: string, input: string, value: string): void {
    const v = this.block(id).inputs[input];
    if (!v || v[0] !== 1 || !Array.isArray(v[1])) throw new Error(`${this.t.name}: ${id}.${input} holds no literal`);
    (v[1] as unknown[])[1] = value;
  }

  // ------------------------------------------------------------ statements

  /** Takes a statement out of its stack and joins the blocks around it. */
  detach(id: string): void {
    const b = this.block(id);
    const p = b.parent;
    const n = b.next;
    if (p) {
      const pb = this.block(p);
      if (pb.next === id) pb.next = n;
      else {
        const k = SUBSTACKS.find((s) => pb.inputs[s]?.[1] === id);
        if (!k) throw new Error(`${this.t.name}: ${id} is not a statement of ${p}`);
        if (n) pb.inputs[k] = [2, n];
        else delete pb.inputs[k];
      }
    } else if (n) {
      Object.assign(this.block(n), { topLevel: true, x: (b as { x?: number }).x ?? 0, y: (b as { y?: number }).y ?? 0 });
    }
    if (n) this.block(n).parent = p;
    b.parent = null;
    b.next = null;
  }
  /** Puts a detached statement after `after`. */
  insertAfter(id: string, after: string): void {
    const b = this.block(id);
    const a = this.block(after);
    b.parent = after;
    b.next = a.next;
    if (a.next) this.block(a.next).parent = id;
    a.next = id;
  }
  /** Moves the statements from `first` to `last`, a run in one stack, into the empty substack of `wrapper`, which takes their place. */
  wrap(first: string, last: string, wrapper: string): void {
    const f = this.block(first);
    const l = this.block(last);
    const w = this.block(wrapper);
    const p = f.parent;
    if (!p) throw new Error(`${this.t.name}: ${first} starts a script`);
    const pb = this.block(p);
    if (pb.next === first) pb.next = wrapper;
    else {
      const k = SUBSTACKS.find((s) => pb.inputs[s]?.[1] === first);
      if (!k) throw new Error(`${this.t.name}: ${first} is not a statement of ${p}`);
      pb.inputs[k] = [2, wrapper];
    }
    w.parent = p;
    w.next = l.next;
    if (l.next) this.block(l.next).parent = wrapper;
    l.next = null;
    w.inputs.SUBSTACK = [2, first];
    f.parent = wrapper;
  }
  /** Puts a detached statement first in a substack of `owner`. */
  insertFirst(id: string, owner: string, input = 'SUBSTACK'): void {
    const o = this.block(owner);
    const old = o.inputs[input]?.[1] as string | undefined;
    o.inputs[input] = [2, id];
    const b = this.block(id);
    b.parent = owner;
    b.next = old ?? null;
    if (old) this.block(old).parent = id;
  }
  /** Deletes a block with its reporters, shadows and substacks, but not the blocks after it. */
  deleteTree(id: string): number {
    let n = 0;
    const visit = (bid: string, chain: boolean) => {
      for (let cur: string | null = bid; cur; ) {
        const b = this.block(cur);
        if (!b.shadow) n++;
        for (const [name, v] of Object.entries(b.inputs)) {
          for (const c of v.slice(1)) {
            if (Array.isArray(c) && (c[0] === 12 || c[0] === 13)) n++;
            if (typeof c === 'string' && this.B[c]) visit(c, SUBSTACKS.includes(name));
          }
        }
        const next: string | null = chain ? b.next : null;
        delete this.B[cur];
        cur = next;
      }
    };
    visit(id, false);
    return n;
  }
  /** Takes a statement out of its stack and deletes it. Returns the number of blocks removed. */
  remove(id: string): number {
    this.detach(id);
    return this.deleteTree(id);
  }
  /** Deletes a whole script from its hat. */
  removeScript(top: string): number {
    let n = 0;
    for (let id: string | null = top; id; ) {
      const next: string | null = this.block(id).next;
      this.block(id).next = null;
      n += this.deleteTree(id);
      id = next;
    }
    return n;
  }

  // ------------------------------------------------------------ reporters

  /** Takes a reporter out of its parent's input, leaving the input's shadow or an empty slot. */
  unplug(id: string): void {
    const b = this.block(id);
    const p = this.block(b.parent!);
    const k = Object.keys(p.inputs).find((name) => p.inputs[name][1] === id);
    if (!k) throw new Error(`${this.t.name}: ${id} is not an input of ${b.parent}`);
    const v = p.inputs[k];
    if (v.length > 2 && v[2] != null) p.inputs[k] = [1, v[2]];
    else delete p.inputs[k];
    b.parent = null;
  }
  /** Fills an input of `parent` with the reporter `child` (moved from wherever it was) and deletes what filled it before. */
  plug(parent: string, input: string, child: string): number {
    const c = this.block(child);
    if (c.parent) this.unplug(child);
    const p = this.block(parent);
    const v = p.inputs[input];
    let removed = 0;
    if (v && typeof v[1] === 'string' && this.B[v[1]] && !this.block(v[1]).shadow) removed = this.deleteTree(v[1]);
    else if (v && Array.isArray(v[1]) && (v[1][0] === 12 || v[1][0] === 13)) removed = 1;
    const shadow = v ? (v[0] === 1 ? v[1] : v[2]) : undefined;
    p.inputs[input] = shadow !== undefined && !(Array.isArray(shadow) && (shadow[0] === 12 || shadow[0] === 13)) ? [3, child, shadow] : [2, child];
    c.parent = parent;
    return removed;
  }
  /** Replaces whatever fills an input with an inline variable or list reporter. */
  plugInline(parent: string, input: string, kind: 12 | 13, name: string, id: string): number {
    const p = this.block(parent);
    const v = p.inputs[input];
    let removed = 0;
    if (v && typeof v[1] === 'string' && this.B[v[1]] && !this.block(v[1]).shadow) removed = this.deleteTree(v[1]);
    const shadow = v ? (v[0] === 1 ? v[1] : v[2]) : [10, ''];
    p.inputs[input] = [3, [kind, name, id], shadow];
    return removed;
  }
}

/** Detaches the comments of deleted blocks so they stay on the workspace and the project still loads. */
export function keepOrphanComments(t: Target): number {
  let n = 0;
  for (const c of Object.values((t as { comments?: Record<string, { blockId: string | null }> }).comments ?? {})) {
    if (c.blockId && !t.blocks[c.blockId]) { c.blockId = null; n++; }
  }
  return n;
}

/** The blocks of a target as the editor shows them: non-shadow blocks and the inline variable and list reporters. */
export function countBlocks(t: Target): number {
  let n = 0;
  for (const b of Object.values(t.blocks)) {
    if (Array.isArray(b)) { n++; continue; }
    if (!b || b.shadow) continue;
    n++;
    for (const v of Object.values(b.inputs)) if (Array.isArray(v[1]) && (v[1][0] === 12 || v[1][0] === 13)) n++;
  }
  return n;
}
