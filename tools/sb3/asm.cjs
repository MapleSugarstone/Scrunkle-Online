// Assembles pseudocode in the decompiler's syntax into blocks of one target, so hand merges read like the scripts they edit.
// Input shapes (literal type codes and shadow menus) are learned from the blocks of the projects passed to learnShapes.
const { isBlock } = require('./sb3.cjs');

const shapes = new Map(); // "opcode.INPUT" -> {prim: typecode} | {shadow: opcode, field} | {bool: true}
const PRIM_OF = { math_number: 4, math_positive_number: 5, math_whole_number: 6, math_integer: 7, math_angle: 8, colour_picker: 9, text: 10 };

function learnShapes(...projects) {
  for (const p of projects) for (const t of p.targets) for (const b of Object.values(t.blocks)) {
    if (!isBlock(b) || b.shadow) continue;
    for (const [name, inp] of Object.entries(b.inputs)) {
      const key = `${b.opcode}.${name}`;
      if (name.startsWith('SUBSTACK')) continue;
      const sh = inp[0] === 3 ? inp[2] : inp[0] === 1 ? inp[1] : null;
      if (Array.isArray(sh)) { if (sh[0] <= 10 && !shapes.has(key)) shapes.set(key, { prim: sh[0] }); }
      else if (typeof sh === 'string' && t.blocks[sh] && t.blocks[sh].shadow) {
        const s = t.blocks[sh];
        if (PRIM_OF[s.opcode]) shapes.set(key, { prim: PRIM_OF[s.opcode] });
        else shapes.set(key, { shadow: s.opcode, field: Object.keys(s.fields)[0], inputs: s.inputs });
      } else if (inp[0] === 2 && !shapes.has(key)) shapes.set(key, { bool: true });
    }
  }
}

// ---------------------------------------------------------------- tokens

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { toks.push({ t: 'nl' }); i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      // `raw` keeps the text as printed, for procedure names, which the decompiler prints without escaping.
      let j = i + 1, s = '';
      while (src[j] !== '"') {
        if (src[j] === '\\' && (src[j + 1] === '"' || src[j + 1] === '\\' || src[j + 1] === 'n')) { s += JSON.parse(`"${src[j]}${src[j + 1]}"`); j += 2; } else s += src[j++];
      }
      toks.push({ t: 'str', v: s, raw: src.slice(i + 1, j) }); i = j + 1; continue;
    }
    if ((c === '$' || c === '@') && src[i + 1] === '{') {
      const j = src.indexOf('}', i);
      toks.push({ t: c === '$' ? 'var' : 'list', v: src.slice(i + 2, j) }); i = j + 1; continue;
    }
    if (c === '$' || c === '@') {
      let j = i + 1;
      while (j < src.length && !/[\s(),]/.test(src[j])) j++;
      toks.push({ t: c === '$' ? 'var' : 'list', v: src.slice(i + 1, j) }); i = j; continue;
    }
    if ('(),:'.includes(c)) { toks.push({ t: c }); i++; continue; }
    if (src.startsWith('+=', i)) { toks.push({ t: 'op', v: '+=' }); i += 2; continue; }
    if ('=<>+-*/'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
    if (j === i) throw new Error(`asm: bad character ${c} in ${src.slice(i, i + 30)}`);
    const word = src.slice(i, j);
    // Argument names can hold any character, so arg(...) takes everything up to its closing parenthesis.
    if ((word === 'arg' || word === 'argb') && src[j] === '(') {
      const k = src.indexOf(')', j);
      toks.push({ t: 'id', v: word }, { t: '(' }, { t: 'argname', v: src.slice(j + 1, k) }, { t: ')' });
      i = k + 1; continue;
    }
    toks.push({ t: 'id', v: word }); i = j;
  }
  toks.push({ t: 'nl' }, { t: 'eof' });
  return toks;
}

// ---------------------------------------------------------------- assembler

class Asm {
  constructor(project, target, ids) {
    this.p = project; this.t = target; this.ids = ids;
    this.stage = project.targets.find(x => x.isStage);
  }

  // Variable, list or broadcast id by name, a target's locals before the Stage's globals.
  ref(kind, name) {
    if (kind === 'broadcast') {
      const e = Object.entries(this.stage.broadcasts).find(([, n]) => n === name);
      if (e) return e[0];
      const id = this.ids.next(); this.stage.broadcasts[id] = name; return id;
    }
    const dict = kind === 'list' ? 'lists' : 'variables';
    for (const tt of [this.t, this.stage]) for (const [id, v] of Object.entries(tt[dict])) if (v[0] === name) return id;
    throw new Error(`asm: no ${kind} ${name} in ${this.t.name}`);
  }

  add(b) { const id = this.ids.next(); this.t.blocks[id] = Object.assign({ next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: false }, b); return id; }

  link(parent, child) { if (child && isBlock(this.t.blocks[child])) this.t.blocks[child].parent = parent; }

  // Builds the input entry for a value placed in slot opcode.name.
  input(owner, opcode, name, val) {
    if (val.kind === 'null') return null;
    const shape = shapes.get(`${opcode}.${name}`) || { prim: 10 };
    if (shape.bool) { if (val.kind === 'block') { this.link(owner, val.id); return [2, val.id]; } return null; }
    const literal = val.kind === 'lit';
    if (shape.prim) {
      const sh = [shape.prim, literal ? val.v : ''];
      if (literal) return [1, sh];
      if (val.kind === 'prim') return [3, val.prim, sh];
      this.link(owner, val.id);
      return [3, val.id, sh];
    }
    // A menu printed as a generic call (sensing_distancetomenu(DISTANCETOMENU:"P1")) is the slot's own shadow.
    if (val.kind === 'block' && this.t.blocks[val.id].opcode === shape.shadow) {
      Object.assign(this.t.blocks[val.id], { shadow: true, parent: owner });
      return [1, val.id];
    }
    const sid = this.add({ opcode: shape.shadow, shadow: true, parent: owner, fields: { [shape.field]: [literal ? val.v : this.defaultField(shape), null] }, inputs: {} });
    if (shape.field === 'BROADCAST_OPTION' || shape.shadow === 'event_broadcast_menu') this.t.blocks[sid].fields[shape.field][1] = this.ref('broadcast', this.t.blocks[sid].fields[shape.field][0]);
    if (literal) return [1, sid];
    if (val.kind === 'prim') return [3, val.prim, sid];
    this.link(owner, val.id);
    return [3, val.id, sid];
  }
  defaultField(shape) { return shape.shadow === 'looks_costume' ? 'costume1' : ''; }

  // ------------------------------------------------ expressions
  expr() {
    const k = this.peek();
    if (k.t === 'str') { this.i++; return { kind: 'lit', v: k.v }; }
    if (k.t === 'var') { this.i++; return { kind: 'prim', prim: [12, k.v, this.ref('variable', k.v)] }; }
    if (k.t === 'list') { this.i++; return { kind: 'prim', prim: [13, k.v, this.ref('list', k.v)] }; }
    if (k.t === 'id' && k.v === 'null') { this.i++; return { kind: 'null' }; }
    if (k.t === '(') {
      this.i++;
      const a = this.expr();
      const op = this.next();
      const opv = op.t === 'op' ? op.v : op.v;
      const b = this.expr();
      this.expect(')');
      const OPS = { '+': ['operator_add', 'NUM1', 'NUM2'], '-': ['operator_subtract', 'NUM1', 'NUM2'], '*': ['operator_multiply', 'NUM1', 'NUM2'],
        '/': ['operator_divide', 'NUM1', 'NUM2'], mod: ['operator_mod', 'NUM1', 'NUM2'], '=': ['operator_equals', 'OPERAND1', 'OPERAND2'],
        '<': ['operator_lt', 'OPERAND1', 'OPERAND2'], '>': ['operator_gt', 'OPERAND1', 'OPERAND2'], and: ['operator_and', 'OPERAND1', 'OPERAND2'], or: ['operator_or', 'OPERAND1', 'OPERAND2'] };
      const [opcode, n1, n2] = OPS[opv] || (() => { throw new Error(`asm: unknown operator ${opv}`); })();
      return this.reporter(opcode, { [n1]: a, [n2]: b });
    }
    if (k.t === 'id') {
      this.i++;
      const SIMPLE = { costume_name: ['looks_costumenumbername', { NUMBER_NAME: 'name' }], costume_number: ['looks_costumenumbername', { NUMBER_NAME: 'number' }],
        backdrop_number: ['looks_backdropnumbername', { NUMBER_NAME: 'number' }], x: ['motion_xposition'], y: ['motion_yposition'], direction: ['motion_direction'],
        size: ['looks_size'], timer: ['sensing_timer'], answer: ['sensing_answer'], username: ['sensing_username'], daysSince2000: ['sensing_dayssince2000'],
        mouseX: ['sensing_mousex'], mouseY: ['sensing_mousey'], mouseDown: ['sensing_mousedown'] };
      if (SIMPLE[k.v] && this.peek().t !== '(') {
        const [opcode, fields = {}] = SIMPLE[k.v];
        return { kind: 'block', id: this.add({ opcode, fields: Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, [v, null]])) }) };
      }
      this.expect('(');
      const fn = k.v;
      const listFn = (opcode, inputName) => { const a = inputName ? this.expr() : null; if (inputName) this.expect(','); const l = this.next().v; this.expect(')'); return this.reporter(opcode, inputName ? { [inputName]: a } : {}, { LIST: [l, this.ref('list', l)] }); };
      switch (fn) {
        case 'item': return listFn('data_itemoflist', 'INDEX');
        case 'indexOf': return listFn('data_itemnumoflist', 'ITEM');
        case 'length': { const l = this.next().v; this.expect(')'); return this.reporter('data_lengthoflist', {}, { LIST: [l, this.ref('list', l)] }); }
        case 'contains': { const l = this.next().v; this.expect(','); const a = this.expr(); this.expect(')'); return this.reporter('data_listcontainsitem', { ITEM: a }, { LIST: [l, this.ref('list', l)] }); }
        case 'not': { const a = this.expr(); this.expect(')'); return this.reporter('operator_not', { OPERAND: a }); }
        case 'arg': case 'argb': { const n = this.next().v; this.expect(')'); return { kind: 'block', id: this.add({ opcode: fn === 'arg' ? 'argument_reporter_string_number' : 'argument_reporter_boolean', fields: { VALUE: [n, null] } }) }; }
        case 'bcast': { const n = this.next().v; this.expect(')'); return { kind: 'bcast', v: n }; }
        case 'contents': { const l = this.next().v; this.expect(')'); return this.reporter('data_listcontents', {}, { LIST: [l, this.ref('list', l)] }); }
        case 'of': { const prop = this.next().v; this.expect(','); const o = this.expr(); this.expect(')'); return this.reporter('sensing_of', { OBJECT: o }, { PROPERTY: [prop, null] }); }
      }
      if (fn.includes('_')) return this.generic(fn);
      const args = [];
      while (this.peek().t !== ')') { args.push(this.expr()); if (this.peek().t === ',') this.i++; }
      this.expect(')');
      const TWO = { join: ['operator_join', 'STRING1', 'STRING2'], letter: ['operator_letter_of', 'LETTER', 'STRING'], strcontains: ['operator_contains', 'STRING1', 'STRING2'],
        random: ['operator_random', 'FROM', 'TO'] };
      const ONE = { strlen: ['operator_length', 'STRING'], round: ['operator_round', 'NUM'], keyPressed: ['sensing_keypressed', 'KEY_OPTION'], touching: ['sensing_touchingobject', 'TOUCHINGOBJECTMENU'] };
      if (TWO[fn]) return this.reporter(TWO[fn][0], { [TWO[fn][1]]: args[0], [TWO[fn][2]]: args[1] });
      if (ONE[fn]) return this.reporter(ONE[fn][0], { [ONE[fn][1]]: args[0] });
      if (['abs', 'floor', 'ceiling', 'sqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'ln', 'log'].includes(fn)) return this.reporter('operator_mathop', { NUM: args[0] }, { OPERATOR: [fn, null] });
      throw new Error(`asm: unknown function ${fn}`);
    }
    throw new Error(`asm: unexpected ${JSON.stringify(k)}`);
  }

  reporter(opcode, inputs, fields = {}) {
    const id = this.add({ opcode, fields });
    const b = this.t.blocks[id];
    for (const [n, v] of Object.entries(inputs)) { const e = this.input(id, opcode, n, v); if (e) b.inputs[n] = e; }
    return { kind: 'block', id };
  }

  // ------------------------------------------------ statements
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  expect(t) { const k = this.next(); if (k.t !== t && k.v !== t) throw new Error(`asm: expected ${t}, got ${JSON.stringify(k)}`); return k; }
  skipNl() { while (this.peek().t === 'nl') this.i++; }
  atWord(...w) { const k = this.peek(); return k.t === 'id' && w.includes(k.v); }

  // Parses statements until one of the stop words; returns the first block id of the chain (or null).
  chain(stops) {
    let first = null, prev = null;
    for (;;) {
      this.skipNl();
      if (this.peek().t === 'eof') break;
      if (this.atWord(...stops)) break;
      const id = this.stmt();
      if (!first) first = id;
      if (prev) { this.t.blocks[prev].next = id; this.t.blocks[id].parent = prev; }
      prev = id;
    }
    return first;
  }

  substack(id, name, stops) {
    const s = this.chain(stops);
    if (s) { this.t.blocks[id].inputs[name] = [2, s]; this.t.blocks[s].parent = id; }
  }

  stmt() {
    const k = this.peek();
    if (k.t === 'var') {
      this.i++;
      const op = this.next().v;
      const v = this.expr();
      const opcode = op === '+=' ? 'data_changevariableby' : 'data_setvariableto';
      const id = this.add({ opcode, fields: { VARIABLE: [k.v, this.ref('variable', k.v)] } });
      this.t.blocks[id].inputs.VALUE = this.input(id, opcode, 'VALUE', v);
      return id;
    }
    if (k.t !== 'id') throw new Error(`asm: statement starts with ${JSON.stringify(k)}`);
    const w = k.v;
    this.i++;
    if (w === 'if') {
      const c = this.expr();
      this.expect('then');
      const id = this.add({ opcode: 'control_if' });
      if (c.kind === 'block') { this.t.blocks[id].inputs.CONDITION = [2, c.id]; this.link(id, c.id); }
      this.substack(id, 'SUBSTACK', ['else', 'end']);
      if (this.atWord('else')) {
        this.i++;
        this.t.blocks[id].opcode = 'control_if_else';
        this.substack(id, 'SUBSTACK2', ['end']);
      }
      this.expect('end');
      return id;
    }
    if (w === 'forever') { const id = this.add({ opcode: 'control_forever' }); this.substack(id, 'SUBSTACK', ['end']); this.expect('end'); return id; }
    if (w === 'repeat') {
      if (this.atWord('until')) {
        this.i++;
        const c = this.expr();
        const id = this.add({ opcode: 'control_repeat_until' });
        if (c.kind === 'block') { this.t.blocks[id].inputs.CONDITION = [2, c.id]; this.link(id, c.id); }
        this.substack(id, 'SUBSTACK', ['end']); this.expect('end'); return id;
      }
      const n = this.expr();
      const id = this.add({ opcode: 'control_repeat' });
      this.t.blocks[id].inputs.TIMES = this.input(id, 'control_repeat', 'TIMES', n);
      this.substack(id, 'SUBSTACK', ['end']); this.expect('end'); return id;
    }
    if (w === 'replace') {
      this.expect('item'); const idx = this.expr(); this.expect('of'); const l = this.next().v; this.expect('with'); const v = this.expr();
      const id = this.add({ opcode: 'data_replaceitemoflist', fields: { LIST: [l, this.ref('list', l)] } });
      this.t.blocks[id].inputs.INDEX = this.input(id, 'data_replaceitemoflist', 'INDEX', idx);
      this.t.blocks[id].inputs.ITEM = this.input(id, 'data_replaceitemoflist', 'ITEM', v);
      return id;
    }
    if (w === 'insert') {
      const v = this.expr(); this.expect('at'); const idx = this.expr(); this.expect('of'); const l = this.next().v;
      const id = this.add({ opcode: 'data_insertatlist', fields: { LIST: [l, this.ref('list', l)] } });
      this.t.blocks[id].inputs.ITEM = this.input(id, 'data_insertatlist', 'ITEM', v);
      this.t.blocks[id].inputs.INDEX = this.input(id, 'data_insertatlist', 'INDEX', idx);
      return id;
    }
    if (w === 'add') {
      const v = this.expr(); this.expect('to'); const l = this.next().v;
      const id = this.add({ opcode: 'data_addtolist', fields: { LIST: [l, this.ref('list', l)] } });
      this.t.blocks[id].inputs.ITEM = this.input(id, 'data_addtolist', 'ITEM', v);
      return id;
    }
    if (w === 'delete') {
      if (this.atWord('all')) { this.i++; this.expect('of'); const l = this.next().v; return this.add({ opcode: 'data_deletealloflist', fields: { LIST: [l, this.ref('list', l)] } }); }
      const v = this.expr(); this.expect('of'); const l = this.next().v;
      const id = this.add({ opcode: 'data_deleteoflist', fields: { LIST: [l, this.ref('list', l)] } });
      this.t.blocks[id].inputs.INDEX = this.input(id, 'data_deleteoflist', 'INDEX', v);
      return id;
    }
    if (w === 'broadcast') {
      let opcode = 'event_broadcast';
      if (this.atWord('and')) { this.i++; this.expect('wait'); opcode = 'event_broadcastandwait'; }
      const v = this.expr();
      const id = this.add({ opcode });
      if (v.kind === 'bcast') this.t.blocks[id].inputs.BROADCAST_INPUT = [1, [11, v.v, this.ref('broadcast', v.v)]];
      else this.t.blocks[id].inputs.BROADCAST_INPUT = this.input(id, opcode, 'BROADCAST_INPUT', v);
      return id;
    }
    if (w === 'call') {
      const pc = this.next().raw;
      const proto = Object.values(this.t.blocks).find(b => isBlock(b) && b.opcode === 'procedures_prototype' && b.mutation.proccode === pc);
      if (!proto) throw new Error(`asm: no procedure "${pc}" in ${this.t.name}`);
      const argIds = JSON.parse(proto.mutation.argumentids);
      const types = pc.match(/%[sbn]/g) || [];
      this.expect('(');
      const args = [];
      while (this.peek().t !== ')') { args.push(this.expr()); if (this.peek().t === ',') this.i++; }
      this.expect(')');
      const id = this.add({ opcode: 'procedures_call', mutation: { tagName: 'mutation', children: [], proccode: pc, argumentids: proto.mutation.argumentids, warp: proto.mutation.warp } });
      args.forEach((a, n) => {
        const b = this.t.blocks[id];
        if (types[n] === '%b') { if (a.kind === 'block') { b.inputs[argIds[n]] = [2, a.id]; this.link(id, a.id); } return; }
        if (a.kind === 'lit') b.inputs[argIds[n]] = [1, [10, a.v]];
        else if (a.kind === 'prim') b.inputs[argIds[n]] = [3, a.prim, [10, '']];
        else { b.inputs[argIds[n]] = [3, a.id, [10, '']]; this.link(id, a.id); }
      });
      return id;
    }
    this.expect('(');
    return this.generic(w).id;
  }

  // Generic opcode(NAME=expr, FIELD:"value"), with the opening parenthesis already read.
  generic(opcode) {
    const id = this.add({ opcode });
    while (this.peek().t !== ')') {
      const name = this.next().v;
      const sep = this.next();
      if (sep.t === ':') {
        const v = this.next().v;
        this.t.blocks[id].fields[name] = [v, name === 'VARIABLE' ? this.ref('variable', v) : name === 'LIST' ? this.ref('list', v) : null];
      } else { const v = this.expr(); const e = this.input(id, opcode, name, v); if (e) this.t.blocks[id].inputs[name] = e; }
      if (this.peek().t === ',') this.i++;
    }
    this.expect(')');
    return { kind: 'block', id };
  }

  // Returns the first block of the assembled chain, unlinked.
  run(src) {
    this.toks = tokenize(src);
    this.i = 0;
    const first = this.chain([]);
    this.skipNl();
    if (this.peek().t !== 'eof') throw new Error(`asm: trailing input at ${JSON.stringify(this.peek())}`);
    return first;
  }
}

function asm(project, target, ids, src) { return new Asm(project, target, ids).run(src); }

module.exports = { learnShapes, asm, shapes };
