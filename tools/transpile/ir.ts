// Parses the source project JSON into a small statement/expression tree with every variable,
// list and broadcast reference resolved the way the original loader resolves them.
import { COMPILED } from '../../src/engine/defs.ts';

export type Lit = string | number | boolean | undefined;

export type Expr =
  | { k: 'lit'; v: Lit }
  | { k: 'var'; ref: StoreRef }
  | { k: 'listContents'; ref: StoreRef }
  | { k: 'arg'; name: string; bool: boolean }
  | { k: 'op'; op: string; id: string; in: Record<string, Expr>; inOrder: string[]; f: Record<string, unknown> };

export type Stmt =
  | { k: 'if'; id: string; cond: Expr; then: Stmt[]; else: Stmt[] | null }
  | { k: 'repeat'; id: string; times: Expr; body: Stmt[] }
  | { k: 'until'; id: string; cond: Expr; body: Stmt[] }
  | { k: 'forever'; id: string; body: Stmt[] }
  | { k: 'call'; id: string; proc: string; args: Record<string, Expr>; inOrder: string[] }
  | { k: 'op'; id: string; op: string; in: Record<string, Expr>; inOrder: string[]; f: Record<string, unknown> };

export interface StoreRef {
  scope: 'local' | 'global';
  prop: string;
  id: string;
  list: boolean;
}

export interface VarDecl {
  id: string;
  name: string;
  prop: string;
  value: unknown;
  list: boolean;
  /** A stage variable shared with other players through the cloud link. */
  cloud?: boolean;
}

export interface ProcIR {
  proccode: string;
  warp: boolean;
  argNames: string[];
  argIds: string[];
  argDefaults: unknown[];
  body: Stmt[];
  defId: string;
  /** Sanitized function name base. */
  fname: string;
}

export interface ScriptIR {
  hat: 'flag' | 'broadcast' | 'clone' | 'key' | 'click' | 'timer';
  msg?: string;
  /** The threshold literal of a timer hat. */
  value?: string;
  top: string;
  body: Stmt[];
}

export interface TargetIR {
  index: number;
  name: string;
  isStage: boolean;
  json: any;
  vars: VarDecl[];
  lists: VarDecl[];
  scripts: ScriptIR[];
  procs: Map<string, ProcIR>;
  /** Prototype data by proccode: first prototype in block order, which is what calls use for params. */
  protos: Map<string, { names: string[]; ids: string[]; defaults: unknown[] }>;
}

const RESERVED = new Set([
  'constructor', '__proto__', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'yield', 'let', 'static', 'enum', 'await', 'implements', 'package', 'protected', 'interface', 'private', 'public', 'null',
  'true', 'false', 'undefined', 'NaN', 'Infinity', 'arguments', 'eval',
]);

/** Symbols that carry meaning in names get a word instead of disappearing. */
const SYMBOL_WORDS: Record<string, string> = { '#': 'Num', '%': 'Pct', '&': 'And', '+': 'Plus', '=': 'Eq' };

export function sanitize(name: string, used: Set<string>, fallback = 'unnamed'): string {
  let s = name
    .replace(/[#%&+=]/g, (c) => `_${SYMBOL_WORDS[c]}_`)
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (s === '') s = fallback;
  if (/^[0-9]/.test(s)) s = `_${s}`;
  if (RESERVED.has(s)) s = `${s}_`;
  let out = s;
  let n = 2;
  while (used.has(out)) out = `${s}_${n++}`;
  used.add(out);
  return out;
}

interface RawBlock {
  opcode: string;
  next: string | null;
  parent: string | null;
  inputs: Record<string, any[]>;
  fields: Record<string, any[]>;
  shadow: boolean;
  topLevel: boolean;
  mutation?: any;
}

/** Inputs whose numeric-looking text stays text when it names a costume or sound, as the original's compiler keeps it. */
const KEEPS_NAMES = new Set([
  'sensing_keypressed.KEY_OPTION',
  'data_addtolist.ITEM',
  'data_insertatlist.ITEM',
  'data_replaceitemoflist.ITEM',
  'data_setvariableto.VALUE',
  'looks_switchbackdropto.BACKDROP',
  'looks_switchcostumeto.COSTUME',
]);
/** Blocks the original's compiler runs through its compatibility layer, where every input keeps names as text. */
const COMPAT_BLOCKS = new Set([
  'looks_changestretchby', 'looks_hideallsprites', 'looks_sayforsecs', 'looks_setstretchto', 'looks_switchbackdroptoandwait',
  'looks_thinkforsecs', 'motion_align_scene', 'motion_glidesecstoxy', 'motion_glideto', 'motion_goto', 'motion_pointtowards',
  'motion_scroll_right', 'motion_scroll_up', 'sensing_askandwait', 'sensing_setdragmode', 'sound_changeeffectby',
  'sound_changevolumeby', 'sound_cleareffects', 'sound_play', 'sound_playuntildone', 'sound_seteffectto', 'sound_setvolumeto',
  'sound_stopallsounds',
]);

/**
 * The original's compiler turns a constant into a number when the number prints back as the same text, so "-30" is
 * stored as -30 while "1.50", "1e3" and " 5" stay text. `keepNames` leaves costume and sound names as text.
 */
function compiledConstant(v: string | number, keepNames: boolean, names: Set<string>): string | number {
  const s = String(v);
  const n = +s;
  if (Number.isNaN(n) || (s.trim() === '' && !s.includes('\t'))) return s;
  if (keepNames && names.has(s)) return s;
  return String(n) === s ? n : s;
}

export function parseProject(project: any): TargetIR[] {
  const stageJson = project.targets.find((t: any) => t.isStage);
  const costumeAndSoundNames = new Set<string>();
  for (const t of project.targets) {
    for (const c of t.costumes) costumeAndSoundNames.add(c.name);
    for (const s of t.sounds) costumeAndSoundNames.add(s.name);
  }
  const targets: TargetIR[] = project.targets.map((t: any, index: number) => ({
    index,
    name: t.name,
    isStage: !!t.isStage,
    json: t,
    vars: [],
    lists: [],
    scripts: [],
    procs: new Map(),
    protos: new Map(),
  }));
  const stage = targets.find((t) => t.isStage)!;

  // Declarations, with property names unique per target (stage names are global).
  for (const t of targets) {
    const usedV = new Set<string>();
    const usedL = new Set<string>();
    for (const [id, v] of Object.entries<any>(t.json.variables)) {
      t.vars.push({ id, name: v[0], prop: sanitize(v[0], usedV, 'v'), value: v[1], list: false, cloud: t.isStage && v[2] === true });
    }
    for (const [id, l] of Object.entries<any>(t.json.lists)) {
      t.lists.push({ id, name: l[0], prop: sanitize(l[0], usedL, 'list'), value: l[1], list: true });
    }
  }

  // Resolve every reference once, creating stage variables for dangling ones like the loader does.
  const stageBroadcasts: Record<string, string> = { ...(stageJson.broadcasts ?? {}) };
  const resolver = (t: TargetIR) => {
    const find = (id: string, list: boolean): StoreRef | null => {
      const own = (list ? t.lists : t.vars).find((d) => d.id === id);
      if (own) return { scope: t.isStage ? 'global' : 'local', prop: own.prop, id, list };
      const g = (list ? stage.lists : stage.vars).find((d) => d.id === id);
      if (g) return { scope: 'global', prop: g.prop, id, list };
      return null;
    };
    return (id: string, name: string, list: boolean): StoreRef => {
      const hit = find(id, list);
      if (hit) return hit;
      const byName = (list ? stage.lists : stage.vars).find((d) => d.name === name);
      if (byName) {
        console.warn(`[transpile] ${t.name}: remapped dangling ${list ? 'list' : 'variable'} '${name}' (${id}) to stage '${byName.id}'`);
        return { scope: 'global', prop: byName.prop, id: byName.id, list };
      }
      console.warn(`[transpile] ${t.name}: created stage ${list ? 'list' : 'variable'} for dangling '${name}' (${id})`);
      const decls = list ? stage.lists : stage.vars;
      const used = new Set(decls.map((d) => d.prop));
      const decl: VarDecl = { id, name, prop: sanitize(name, used, list ? 'list' : 'v'), value: list ? [] : 0, list };
      decls.push(decl);
      return { scope: 'global', prop: decl.prop, id, list };
    };
  };
  const broadcastName = (id: string | null, name: string): string => {
    if (id && stageBroadcasts[id] !== undefined) return stageBroadcasts[id];
    return name;
  };

  for (const t of targets) {
    const blocks: Record<string, RawBlock | any[]> = t.json.blocks;
    const resolve = resolver(t);
    const B = (id: string) => blocks[id] as RawBlock;

    const prim = (p: any[]): Expr => {
      switch (p[0]) {
        case 4: case 5: case 6: case 7: case 8: case 9: case 10:
          return { k: 'lit', v: p[1] };
        case 11:
          return { k: 'lit', v: broadcastName(p[2], p[1]) };
        case 12:
          return { k: 'var', ref: resolve(p[2], p[1], false) };
        case 13:
          return { k: 'listContents', ref: resolve(p[2], p[1], true) };
      }
      throw new Error(`unknown primitive ${JSON.stringify(p)}`);
    };

    const exprOf = (idOrPrim: string | any[] | null): Expr | undefined => {
      if (idOrPrim === null || idOrPrim === undefined) return undefined;
      if (Array.isArray(idOrPrim)) return prim(idOrPrim);
      const raw = blocks[idOrPrim];
      if (Array.isArray(raw)) return prim(raw);
      const b = raw as RawBlock;
      if (!b) throw new Error(`missing block ${idOrPrim}`);
      switch (b.opcode) {
        case 'argument_reporter_string_number':
          return { k: 'arg', name: b.fields.VALUE[0], bool: false };
        case 'argument_reporter_boolean':
          return { k: 'arg', name: b.fields.VALUE[0], bool: true };
        case 'data_variable':
          return { k: 'var', ref: resolve(b.fields.VARIABLE[1], b.fields.VARIABLE[0], false) };
        case 'data_listcontents':
          return { k: 'listContents', ref: resolve(b.fields.LIST[1], b.fields.LIST[0], true) };
      }
      // Menus and other shadow-only blocks report their single field.
      const fieldKeys = Object.keys(b.fields);
      if (b.shadow && fieldKeys.length === 1 && Object.keys(b.inputs).length === 0 && !REPORTER_OPS.has(b.opcode)) {
        const fv = b.fields[fieldKeys[0]];
        if (b.opcode === 'event_broadcast_menu') return { k: 'lit', v: broadcastName(fv[1], fv[0]) };
        return { k: 'lit', v: fv[0] };
      }
      return { k: 'op', op: b.opcode, id: idOrPrim, ...inputsOf(b), f: fieldsOf(b) };
    };

    const fieldsOf = (b: RawBlock): Record<string, unknown> => {
      const f: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.fields)) {
        if (k === 'VARIABLE') f[k] = resolve(v[1], v[0], false);
        else if (k === 'LIST') f[k] = resolve(v[1], v[0], true);
        else if (k === 'BROADCAST_OPTION') f[k] = broadcastName(v[1], v[0]);
        else f[k] = v[0];
      }
      return f;
    };

    const inputsOf = (b: RawBlock): { in: Record<string, Expr>; inOrder: string[] } => {
      const ins: Record<string, Expr> = {};
      const order: string[] = [];
      for (const [name, desc] of Object.entries(b.inputs)) {
        if (name === 'custom_block' || name.startsWith('SUBSTACK')) continue;
        // [1, x] same block and shadow; [2, x] block without shadow; [3, block, shadow].
        let e = exprOf(desc[1]);
        if (COMPILED && e?.k === 'lit' && (typeof e.v === 'string' || typeof e.v === 'number')) {
          const keepNames = b.opcode === 'procedures_call' || COMPAT_BLOCKS.has(b.opcode) || KEEPS_NAMES.has(`${b.opcode}.${name}`);
          e = { k: 'lit', v: compiledConstant(e.v, keepNames, costumeAndSoundNames) };
        }
        if (e !== undefined) {
          ins[name] = e;
          order.push(name);
        }
      }
      return { in: ins, inOrder: order };
    };

    const substack = (b: RawBlock, name: string): Stmt[] => {
      const d = b.inputs[name];
      if (!d || d[1] === null || d[1] === undefined) return [];
      // A primitive in a branch slot loads as a no-op shadow block, the same as an empty branch.
      if (Array.isArray(d[1])) return [];
      return seq(d[1] as string);
    };

    const stmtOf = (id: string): Stmt => {
      const b = B(id);
      if (!b) throw new Error(`${t.name}: block ${id} is missing`);
      const ins = inputsOf(b);
      switch (b.opcode) {
        case 'control_if':
          return { k: 'if', id, cond: ins.in.CONDITION ?? { k: 'lit', v: undefined }, then: substack(b, 'SUBSTACK'), else: null };
        case 'control_if_else':
          return { k: 'if', id, cond: ins.in.CONDITION ?? { k: 'lit', v: undefined }, then: substack(b, 'SUBSTACK'), else: substack(b, 'SUBSTACK2') };
        case 'control_repeat':
          return { k: 'repeat', id, times: ins.in.TIMES ?? { k: 'lit', v: undefined }, body: substack(b, 'SUBSTACK') };
        case 'control_repeat_until':
          return { k: 'until', id, cond: ins.in.CONDITION ?? { k: 'lit', v: undefined }, body: substack(b, 'SUBSTACK') };
        case 'control_forever':
          return { k: 'forever', id, body: substack(b, 'SUBSTACK') };
        case 'procedures_call':
          return { k: 'call', id, proc: b.mutation.proccode, args: ins.in, inOrder: ins.inOrder };
      }
      return { k: 'op', id, op: b.opcode, ...ins, f: fieldsOf(b) };
    };

    const seq = (first: string | null): Stmt[] => {
      const out: Stmt[] = [];
      let id = first;
      while (id) {
        const raw = blocks[id];
        if (Array.isArray(raw)) break;
        out.push(stmtOf(id));
        id = (raw as RawBlock).next;
      }
      return out;
    };

    // Prototypes in block order (first wins), then definitions and hat scripts in block order.
    for (const [, raw] of Object.entries(blocks)) {
      if (Array.isArray(raw)) continue;
      const b = raw as RawBlock;
      if (b.opcode === 'procedures_prototype' && !t.protos.has(b.mutation.proccode)) {
        t.protos.set(b.mutation.proccode, {
          names: JSON.parse(b.mutation.argumentnames),
          ids: JSON.parse(b.mutation.argumentids),
          defaults: JSON.parse(b.mutation.argumentdefaults),
        });
      }
    }
    const usedF = new Set<string>();
    for (const [id, raw] of Object.entries(blocks)) {
      if (Array.isArray(raw)) continue;
      const b = raw as RawBlock;
      if (!b.topLevel || b.shadow) continue;
      switch (b.opcode) {
        case 'procedures_definition': {
          const proto = B(b.inputs.custom_block[1]);
          const code = proto.mutation.proccode;
          if (t.procs.has(code)) break;
          const warp = proto.mutation.warp === true || proto.mutation.warp === 'true';
          t.procs.set(code, {
            proccode: code,
            warp,
            argNames: JSON.parse(proto.mutation.argumentnames),
            argIds: JSON.parse(proto.mutation.argumentids),
            argDefaults: JSON.parse(proto.mutation.argumentdefaults),
            body: seq(b.next),
            defId: id,
            fname: sanitize(code.replace(/%[sbn]/g, ' '), usedF, 'proc'),
          });
          break;
        }
        case 'event_whenflagclicked':
          t.scripts.push({ hat: 'flag', top: id, body: seq(b.next) });
          break;
        case 'event_whenbroadcastreceived':
          t.scripts.push({ hat: 'broadcast', msg: broadcastName(b.fields.BROADCAST_OPTION[1], b.fields.BROADCAST_OPTION[0]).toUpperCase(), top: id, body: seq(b.next) });
          break;
        case 'control_start_as_clone':
          t.scripts.push({ hat: 'clone', top: id, body: seq(b.next) });
          break;
        case 'event_whenthisspriteclicked':
        case 'event_whenstageclicked':
          t.scripts.push({ hat: 'click', top: id, body: seq(b.next) });
          break;
        case 'event_whenkeypressed':
          t.scripts.push({ hat: 'key', msg: String(b.fields.KEY_OPTION[0]).toUpperCase(), top: id, body: seq(b.next) });
          break;
        case 'event_whengreaterthan': {
          const menu = String(b.fields.WHENGREATERTHANMENU[0]).toUpperCase();
          const input = b.inputs.VALUE;
          // Only a typed-in threshold is supported. A reporter in the slot would have to run inside the hat test.
          if (menu !== 'TIMER' || !Array.isArray(input?.[1])) throw new Error(`${t.name}: unsupported 'when ${menu} >' hat ${id}`);
          t.scripts.push({ hat: 'timer', msg: menu, value: String(input[1][1]), top: id, body: seq(b.next) });
          break;
        }
        default:
          break;
      }
    }
  }
  return targets;
}

/** Opcodes that are real reporters even when stored as shadows. */
const REPORTER_OPS = new Set<string>([]);
