// Structural and reference checks for an unpacked Scratch 3 project folder. Prints errors and warnings, exits 1 on errors.
const fs = require('fs');
const path = require('path');
const { resolveRef, stageOf, isBlock } = require('./sb3.cjs');

const dir = process.argv[2];
const quiet = process.argv.includes('--quiet');
const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const errors = [], warnings = [];
const E = (m) => errors.push(m), W = (m) => warnings.push(m);
const files = new Set(fs.readdirSync(dir));
const st = stageOf(p);

const hats = new Set(['event_whenflagclicked', 'event_whenbroadcastreceived', 'control_start_as_clone', 'event_whenkeypressed',
  'event_whenthisspriteclicked', 'event_whenstageclicked', 'event_whengreaterthan', 'event_whenbackdropswitchesto', 'procedures_definition']);

for (const t of p.targets) {
  const B = t.blocks;
  const where = (id) => `${t.name}/${id}`;
  // Graph integrity.
  const claimed = new Map();
  for (const [id, b] of Object.entries(B)) {
    if (!isBlock(b)) {
      if (!Array.isArray(b) || ![12, 13].includes(b[0])) E(`${where(id)}: bad top-level primitive`);
      continue;
    }
    if (b.next) {
      if (!B[b.next]) E(`${where(id)}: next -> missing ${b.next}`);
      else if (B[b.next].parent !== id) E(`${where(id)}: next ${b.next} has parent ${B[b.next].parent}`);
      if (claimed.has(b.next)) E(`${where(id)}: ${b.next} claimed twice`);
      claimed.set(b.next, id);
    }
    for (const [name, inp] of Object.entries(b.inputs)) {
      for (let k = 1; k < inp.length; k++) {
        const v = inp[k];
        if (typeof v !== 'string') continue;
        if (!B[v]) { E(`${where(id)}: input ${name} -> missing ${v}`); continue; }
        if (isBlock(B[v]) && B[v].parent !== id) E(`${where(id)}: input ${name} child ${v} has parent ${B[v].parent}`);
        if (claimed.has(v) && claimed.get(v) !== id) E(`${where(id)}: ${v} claimed twice`);
        claimed.set(v, id);
      }
    }
    if (b.parent && !B[b.parent]) E(`${where(id)}: parent missing ${b.parent}`);
    if (!b.parent && !b.topLevel) E(`${where(id)}: no parent and not top level`);
    if (b.topLevel && (typeof b.x !== 'number' || typeof b.y !== 'number')) W(`${where(id)}: top level without x/y`);
    if (b.topLevel && !b.shadow && !hats.has(b.opcode) && !b.opcode.startsWith('procedures_prototype')) W(`${where(id)}: loose ${b.opcode}`);
    if (b.comment !== undefined && (typeof b.comment !== 'string' || !(t.comments || {})[b.comment])) E(`${where(id)}: bad comment ${b.comment}`);
  }
  // Data references.
  const ref = (id, kind, name, rid) => {
    const r = resolveRef(p, t, kind, name, rid);
    if (!r || r.id !== rid) E(`${where(id)}: ${kind} ${name} (${rid}) does not resolve by id`);
    else if (r.name !== name) W(`${where(id)}: ${kind} name ${name} differs from ${r.name}`);
  };
  for (const [id, b] of Object.entries(B)) {
    const prims = [];
    if (Array.isArray(b)) prims.push(b);
    else {
      for (const inp of Object.values(b.inputs)) for (const v of inp.slice(1)) if (Array.isArray(v)) prims.push(v);
      if (b.fields.VARIABLE) ref(id, 'variable', ...b.fields.VARIABLE);
      if (b.fields.LIST) ref(id, 'list', ...b.fields.LIST);
      if (b.fields.BROADCAST_OPTION) ref(id, 'broadcast', ...b.fields.BROADCAST_OPTION);
    }
    for (const v of prims) {
      if (v[0] === 11) ref(id, 'broadcast', v[1], v[2]);
      if (v[0] === 12) ref(id, 'variable', v[1], v[2]);
      if (v[0] === 13) ref(id, 'list', v[1], v[2]);
    }
  }
  // Procedures.
  const protos = new Map(), defs = new Map();
  for (const [id, b] of Object.entries(B)) {
    if (!isBlock(b)) continue;
    if (b.opcode === 'procedures_prototype') {
      const pc = b.mutation.proccode;
      if (protos.has(pc)) E(`${t.name}: duplicate prototype "${pc}"`);
      protos.set(pc, b);
    }
    if (b.opcode === 'procedures_definition') defs.set(id, b);
  }
  const called = new Set();
  for (const [id, b] of Object.entries(B)) {
    if (!isBlock(b) || b.opcode !== 'procedures_call') continue;
    const pc = b.mutation.proccode;
    called.add(pc);
    const pr = protos.get(pc);
    if (!pr) { E(`${where(id)}: call to undefined "${pc}"`); continue; }
    if (pr.mutation.argumentids !== b.mutation.argumentids) E(`${where(id)}: argument ids differ from prototype "${pc}"`);
  }
  for (const pc of protos.keys()) if (!called.has(pc)) W(`${t.name}: "${pc}" is never called`);
  // Variables.
  for (const dict of ['variables', 'lists']) {
    const names = new Map();
    for (const [id, v] of Object.entries(t[dict])) {
      if (names.has(v[0])) W(`${t.name}: duplicate ${dict} name ${v[0]}`);
      names.set(v[0], id);
      if (!t.isStage && Object.values(st[dict]).some(g => g[0] === v[0])) E(`${t.name}: local ${v[0]} shadows a global`);
    }
  }
  // Assets.
  for (const kind of ['costumes', 'sounds']) {
    const seen = new Set();
    for (const a of t[kind]) {
      const f = a.md5ext || `${a.assetId}.${a.dataFormat}`;
      if (!files.has(f)) E(`${t.name}: ${kind} ${a.name} file ${f} missing`);
      if (seen.has(a.name)) E(`${t.name}: duplicate ${kind} name ${a.name}`);
      seen.add(a.name);
    }
  }
  if (t.currentCostume < 0 || t.currentCostume >= t.costumes.length) E(`${t.name}: currentCostume out of range`);
  // Literal costume and sound menus that name nothing.
  const cos = new Set(t.costumes.map(c => c.name)), snd = new Set(t.sounds.map(s => s.name));
  for (const [id, b] of Object.entries(B)) {
    if (!isBlock(b) || !b.shadow) continue;
    if (b.opcode === 'looks_costume' && !cos.has(b.fields.COSTUME[0])) {
      const par = B[b.parent];
      const covered = par && Object.values(par.inputs).some(i => i[2] === id && typeof i[1] === 'string' && i[1] !== id);
      if (!covered && !/^\d+$/.test(b.fields.COSTUME[0])) W(`${where(id)}: costume menu names missing "${b.fields.COSTUME[0]}"`);
    }
    if (b.opcode === 'sound_sounds_menu' && !snd.has(b.fields.SOUND_MENU[0])) {
      const par = B[b.parent];
      const covered = par && Object.values(par.inputs).some(i => i[2] === id && typeof i[1] === 'string' && i[1] !== id);
      if (!covered) W(`${where(id)}: sound menu names missing "${b.fields.SOUND_MENU[0]}"`);
    }
  }
}
// Monitors.
for (const m of p.monitors || []) {
  if (!['data_variable', 'data_listcontents'].includes(m.opcode)) continue;
  const kind = m.opcode === 'data_variable' ? 'variables' : 'lists';
  const owner = m.spriteName ? p.targets.find(t => t.name === m.spriteName) : st;
  if (!owner || !owner[kind][m.id]) E(`monitor ${m.id} (${JSON.stringify(m.params)}) has no ${kind} entry`);
}
const cloud = Object.values(st.variables).filter(v => v[2]).length;
if (cloud > 10) W(`${cloud} cloud variables (vanilla Scratch allows 10)`);
const size = fs.statSync(path.join(dir, 'project.json')).size;
if (size > 5 * 1024 * 1024) W(`project.json is ${size} bytes, over the 5 MiB upload limit`);

const show = (label, list) => {
  const counts = new Map();
  for (const m of list) { const k = m.replace(/\/[^:]*:/, ':').replace(/\([^)]*\)/g, '()').replace(/"[^"]*"/g, '""'); counts.set(k, (counts.get(k) || 0) + 1); }
  console.log(`${label}: ${list.length}`);
  if (quiet) for (const [k, n] of counts) console.log(`  ${n} x ${k}`);
  else for (const m of list) console.log('  ' + m);
};
show('errors', errors);
show('warnings', warnings);
process.exit(errors.length ? 1 : 0);
