// Prints every script of an extracted sb3 project.json as indented pseudocode, one file per target.
const fs = require('fs');
const path = require('path');


// With the Stage given, variable and list names come from their ids, because the name copies in blocks can be stale.
function makePrinter(target, stage) {
  const blocks = target.blocks;
  // Names the assembler could not delimit (spaces, parentheses, commas) print inside braces.
  const nm = (n) => (/[\s(),{}]/.test(n) ? `{${n}}` : n);
  function dataName(dict, name, id) {
    const v = target[dict][id] || (stage && stage[dict][id]);
    return v ? v[0] : name;
  }
  function prim(p) {
    switch (p[0]) {
      case 4: case 5: case 6: case 7: case 8: return JSON.stringify(p[1]);
      case 9: return `color(${p[1]})`;
      case 10: return JSON.stringify(p[1]);
      case 11: return `bcast(${JSON.stringify(p[1])})`;
      case 12: return `$${nm(dataName('variables', p[1], p[2]))}`;
      case 13: return `@${nm(dataName('lists', p[1], p[2]))}`;
      default: return `?prim${JSON.stringify(p)}`;
    }
  }
  function input(b, name) {
    const inp = b.inputs[name];
    if (!inp) return 'null';
    const v = inp[1];
    if (v === null) return 'null';
    if (Array.isArray(v)) return prim(v);
    return expr(v);
  }
  function field(b, name) {
    const f = b.fields[name];
    if (!f) return undefined;
    if (name === 'VARIABLE') return dataName('variables', f[0], f[1]);
    if (name === 'LIST') return dataName('lists', f[0], f[1]);
    return f[0];
  }
  function expr(id) {
    const b = blocks[id];
    if (!b) return `?missing(${id})`;
    if (Array.isArray(b)) return prim(b);
    const op = b.opcode;
    const I = (n) => input(b, n);
    switch (op) {
      case 'data_itemoflist': return `item(${I('INDEX')}, @${nm(field(b, 'LIST'))})`;
      case 'data_lengthoflist': return `length(@${nm(field(b, 'LIST'))})`;
      case 'data_itemnumoflist': return `indexOf(${I('ITEM')}, @${nm(field(b, 'LIST'))})`;
      case 'data_listcontainsitem': return `contains(@${nm(field(b, 'LIST'))}, ${I('ITEM')})`;
      case 'data_listcontents': return `contents(@${nm(field(b, 'LIST'))})`;
      case 'operator_add': return `(${I('NUM1')} + ${I('NUM2')})`;
      case 'operator_subtract': return `(${I('NUM1')} - ${I('NUM2')})`;
      case 'operator_multiply': return `(${I('NUM1')} * ${I('NUM2')})`;
      case 'operator_divide': return `(${I('NUM1')} / ${I('NUM2')})`;
      case 'operator_mod': return `(${I('NUM1')} mod ${I('NUM2')})`;
      case 'operator_equals': return `(${I('OPERAND1')} = ${I('OPERAND2')})`;
      case 'operator_gt': return `(${I('OPERAND1')} > ${I('OPERAND2')})`;
      case 'operator_lt': return `(${I('OPERAND1')} < ${I('OPERAND2')})`;
      case 'operator_and': return `(${I('OPERAND1')} and ${I('OPERAND2')})`;
      case 'operator_or': return `(${I('OPERAND1')} or ${I('OPERAND2')})`;
      case 'operator_not': return `not(${I('OPERAND')})`;
      case 'operator_join': return `join(${I('STRING1')}, ${I('STRING2')})`;
      case 'operator_letter_of': return `letter(${I('LETTER')}, ${I('STRING')})`;
      case 'operator_length': return `strlen(${I('STRING')})`;
      case 'operator_contains': return `strcontains(${I('STRING1')}, ${I('STRING2')})`;
      case 'operator_round': return `round(${I('NUM')})`;
      case 'operator_mathop': return `${field(b, 'OPERATOR')}(${I('NUM')})`;
      case 'operator_random': return `random(${I('FROM')}, ${I('TO')})`;
      case 'argument_reporter_string_number': return `arg(${field(b, 'VALUE')})`;
      case 'argument_reporter_boolean': return `argb(${field(b, 'VALUE')})`;
      case 'looks_costume': return JSON.stringify(field(b, 'COSTUME'));
      case 'looks_backdrops': return JSON.stringify(field(b, 'BACKDROP'));
      case 'looks_costumenumbername': return `costume_${field(b, 'NUMBER_NAME')}`;
      case 'looks_backdropnumbername': return `backdrop_${field(b, 'NUMBER_NAME')}`;
      case 'looks_size': return 'size';
      case 'sound_sounds_menu': return JSON.stringify(field(b, 'SOUND_MENU'));
      case 'sound_volume': return 'volume';
      case 'control_create_clone_of_menu': return JSON.stringify(field(b, 'CLONE_OPTION'));
      case 'motion_xposition': return 'x';
      case 'motion_yposition': return 'y';
      case 'motion_direction': return 'direction';
      case 'motion_pointtowards_menu': return JSON.stringify(field(b, 'TOWARDS'));
      case 'motion_goto_menu': return JSON.stringify(field(b, 'TO'));
      case 'sensing_keyoptions': return JSON.stringify(field(b, 'KEY_OPTION'));
      case 'sensing_keypressed': return `keyPressed(${I('KEY_OPTION')})`;
      case 'sensing_mousex': return 'mouseX';
      case 'sensing_mousey': return 'mouseY';
      case 'sensing_mousedown': return 'mouseDown';
      case 'sensing_timer': return 'timer';
      case 'sensing_answer': return 'answer';
      case 'sensing_current': return `current(${field(b, 'CURRENTMENU')})`;
      case 'sensing_dayssince2000': return 'daysSince2000';
      case 'sensing_username': return 'username';
      case 'sensing_touchingobject': return `touching(${I('TOUCHINGOBJECTMENU')})`;
      case 'sensing_touchingobjectmenu': return JSON.stringify(field(b, 'TOUCHINGOBJECTMENU'));
      case 'sensing_of': return `of(${JSON.stringify(field(b, 'PROPERTY'))}, ${I('OBJECT')})`;
      case 'sensing_of_object_menu': return JSON.stringify(field(b, 'OBJECT'));
      case 'pen_menu_colorParam': return JSON.stringify(field(b, 'colorParam'));
      default: {
        const ins = Object.keys(b.inputs).map((k) => `${k}=${I(k)}`);
        const fs_ = Object.keys(b.fields).map((k) => `${k}:${JSON.stringify(field(b, k))}`);
        return `${op}(${[...ins, ...fs_].join(', ')})`;
      }
    }
  }
  function substack(b, name) {
    const inp = b.inputs[name];
    return inp && inp[1] ? inp[1] : null;
  }
  function stmts(id, ind, out) {
    while (id) {
      const b = blocks[id];
      if (!b) { out.push(`${ind}?missing ${id}`); break; }
      stmt(b, ind, out);
      id = b.next;
    }
  }
  function stmt(b, ind, out) {
    const I = (n) => input(b, n);
    const F = (n) => field(b, n);
    const op = b.opcode;
    switch (op) {
      case 'control_if':
        out.push(`${ind}if ${I('CONDITION')} then`);
        stmts(substack(b, 'SUBSTACK'), ind + '  ', out);
        out.push(`${ind}end`);
        return;
      case 'control_if_else':
        out.push(`${ind}if ${I('CONDITION')} then`);
        stmts(substack(b, 'SUBSTACK'), ind + '  ', out);
        out.push(`${ind}else`);
        stmts(substack(b, 'SUBSTACK2'), ind + '  ', out);
        out.push(`${ind}end`);
        return;
      case 'control_repeat':
        out.push(`${ind}repeat ${I('TIMES')}`);
        stmts(substack(b, 'SUBSTACK'), ind + '  ', out);
        out.push(`${ind}end`);
        return;
      case 'control_repeat_until':
        out.push(`${ind}repeat until ${I('CONDITION')}`);
        stmts(substack(b, 'SUBSTACK'), ind + '  ', out);
        out.push(`${ind}end`);
        return;
      case 'control_forever':
        out.push(`${ind}forever`);
        stmts(substack(b, 'SUBSTACK'), ind + '  ', out);
        out.push(`${ind}end`);
        return;
      case 'data_setvariableto': out.push(`${ind}$${nm(F('VARIABLE'))} = ${I('VALUE')}`); return;
      case 'data_changevariableby': out.push(`${ind}$${nm(F('VARIABLE'))} += ${I('VALUE')}`); return;
      case 'data_addtolist': out.push(`${ind}add ${I('ITEM')} to @${nm(F('LIST'))}`); return;
      case 'data_deleteoflist': out.push(`${ind}delete ${I('INDEX')} of @${nm(F('LIST'))}`); return;
      case 'data_deletealloflist': out.push(`${ind}delete all of @${nm(F('LIST'))}`); return;
      case 'data_insertatlist': out.push(`${ind}insert ${I('ITEM')} at ${I('INDEX')} of @${nm(F('LIST'))}`); return;
      case 'data_replaceitemoflist': out.push(`${ind}replace item ${I('INDEX')} of @${nm(F('LIST'))} with ${I('ITEM')}`); return;
      case 'procedures_call': {
        const m = b.mutation;
        const ids = JSON.parse(m.argumentids);
        out.push(`${ind}call "${m.proccode}"(${ids.map((a) => input(b, a)).join(', ')})`);
        return;
      }
      case 'event_broadcast': out.push(`${ind}broadcast ${I('BROADCAST_INPUT')}`); return;
      case 'event_broadcastandwait': out.push(`${ind}broadcast and wait ${I('BROADCAST_INPUT')}`); return;
      default: {
        const ins = Object.keys(b.inputs).filter((k) => !k.startsWith('SUBSTACK')).map((k) => `${k}=${I(k)}`);
        const fs_ = Object.keys(b.fields).map((k) => `${k}:${JSON.stringify(F(k))}`);
        out.push(`${ind}${op}(${[...ins, ...fs_].join(', ')})`);
        const sub = substack(b, 'SUBSTACK');
        if (sub) { stmts(sub, ind + '  ', out); out.push(`${ind}end`); }
      }
    }
  }
  function hat(b) {
    const F = (n) => b.fields[n] && b.fields[n][0];
    switch (b.opcode) {
      case 'event_whenflagclicked': return 'WHEN FLAG CLICKED';
      case 'event_whenbroadcastreceived': return `WHEN I RECEIVE ${JSON.stringify(F('BROADCAST_OPTION'))}`;
      case 'control_start_as_clone': return 'WHEN I START AS A CLONE';
      case 'event_whenkeypressed': return `WHEN KEY ${F('KEY_OPTION')} PRESSED`;
      case 'event_whenthisspriteclicked': return 'WHEN THIS SPRITE CLICKED';
      case 'event_whenstageclicked': return 'WHEN STAGE CLICKED';
      case 'event_whengreaterthan': return `WHEN ${F('WHENGREATERTHANMENU')} > ...`;
      case 'event_whenbackdropswitchesto': return `WHEN BACKDROP SWITCHES TO ${F('BACKDROP')}`;
      case 'procedures_definition': {
        const proto = blocks[b.inputs.custom_block[1]];
        const m = proto.mutation;
        return `DEFINE "${m.proccode}" args=${m.argumentnames} warp=${m.warp}`;
      }
      default: return null;
    }
  }
  return { stmts, hat, expr };
}

module.exports = { makePrinter };
if (require.main !== module) return;

const [, , projectPath, outDir] = process.argv;
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
const index = [];
for (const t of project.targets) {
  const pr = makePrinter(t, project.targets.find(x => x.isStage));
  const out = [];
  out.push(`# ${t.isStage ? 'STAGE' : 'SPRITE'} ${t.name}`);
  out.push(`# variables: ${Object.values(t.variables).map((v) => `${v[0]}=${JSON.stringify(v[1])}`).join('; ')}`);
  for (const [, l] of Object.entries(t.lists)) out.push(`# list ${l[0]} = ${JSON.stringify(l[1]).slice(0, 2000)}`);
  out.push(`# costumes: ${t.costumes.map((c, i) => `${i + 1}:${c.name}`).join(', ')}`);
  out.push(`# sounds: ${t.sounds.map((c, i) => `${i + 1}:${c.name}`).join(', ')}`);
  out.push('');
  const tops = Object.entries(t.blocks).filter(([, b]) => !Array.isArray(b) && b.topLevel);
  tops.sort((a, b) => (a[1].y - b[1].y) || (a[1].x - b[1].x));
  for (const [id, b] of tops) {
    const h = pr.hat(b);
    if (h) {
      out.push(`${h}    [${id}]`);
      pr.stmts(b.next, '  ', out);
    } else {
      out.push(`LOOSE ${b.opcode} [${id}]`);
      if (b.opcode.startsWith('procedures_prototype') || b.parent) continue;
      pr.stmts(id, '  ', out);
    }
    out.push('');
  }
  const file = path.join(outDir, `${t.isStage ? '_Stage' : t.name.replace(/[^\w+-]/g, '_')}.txt`);
  fs.writeFileSync(file, out.join('\n'));
  index.push(`${file} ${out.length} lines`);
}
console.log(index.join('\n'));
