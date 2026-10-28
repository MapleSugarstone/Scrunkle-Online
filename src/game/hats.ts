// "Actually wear hats": each fighter's hat is drawn on the fighter's head, turning with it, and right after the
// fighter's own stamps on the pen layer, so the hat gets the fighter's outline and the other fighter can cover it.
// It changes only the picture. `tools/hat-anchors.ts` makes the head positions in `hat-anchors.json`.
import type { PenCmd, Runtime } from '../engine/runtime.ts';
import type { Target } from '../engine/target.ts';
import { def as fighterDef } from './generated/costumes.ts';
import anchorData from './hat-anchors.json' with { type: 'json' };

type Stamp = Extract<PenCmd, { op: 'stamp' }>;

/** By skin: the hat point in costume units from the rotation center (y up), its turn clockwise, and 1 when mirrored. */
const anchors = new Map<number, readonly number[]>();
for (const c of fighterDef.costumes) {
  const a = (anchorData as Record<string, number[]>)[c.name];
  if (a) anchors.set(c.skin, a);
}

/** The variable `!#` numbers the fighter sprite's clones: 1 and 2 draw the fighters, 4 and 5 draw their hats. */
const NUM = fighterDef.varNames?.['!#'] ?? 'Num';

/** The player a stamp belongs to and whether it is the hat, or null for every other stamp. */
function role(owner: Target | undefined): { player: number; hat: boolean } | null {
  if (!owner || owner.sprite.def.name !== fighterDef.name) return null;
  const n = Number(owner.v[NUM]);
  if (n === 1 || n === 2) return { player: n, hat: false };
  if (n === 4 || n === 5) return { player: n - 3, hat: true };
  return null;
}

const RING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** One fighter's stamps from one frame: the outline, the fighter and any copies, then the hat and its copies. */
interface Group {
  bodies: number[];
  hats: Stamp[];
}

/**
 * The hat drawn with a fighter stamp: on the head that the costume's anchor gives, turned and flipped with the fighter.
 * It takes the fighter stamp's effects, so it is white with the outline and fades and flashes with the fighter, and
 * keeps the hat stamp's own color.
 */
function worn(body: Stamp, hat: Stamp, anchor: readonly number[]): Stamp {
  const [ax, ay, turn, mirrored] = anchor;
  const lx = (ax * body.sx) / 100, ly = (ay * body.sy) / 100;
  const r = ((body.dir - 90) * Math.PI) / 180;
  const flipped = body.sx < 0;
  const stamp: Stamp = {
    op: 'stamp',
    skin: hat.skin,
    x: body.x + lx * Math.cos(r) + ly * Math.sin(r),
    y: body.y - lx * Math.sin(r) + ly * Math.cos(r),
    sx: Math.abs(body.sx) * (flipped !== (mirrored === 1) ? -1 : 1),
    sy: body.sy,
    dir: body.dir + (flipped ? -turn : turn),
    fx: { ...body.fx, color: hat.fx.color },
  };
  if (hat.tint) stamp.tint = hat.tint;
  return stamp;
}

/** The pen commands from `from` on with each hat moved onto its fighter's head. */
export function wearHats(rt: Runtime, cmds: readonly PenCmd[], from: number): readonly PenCmd[] {
  const owners = rt.stampOwners;
  if (!owners) return cmds.slice(from);
  const open = new Map<number, Group>();
  const groupOf = new Map<number, Group>();
  const moved = new Set<number>();
  for (let i = from; i < cmds.length; i++) {
    const cmd = cmds[i];
    if (cmd.op !== 'stamp') continue;
    const who = role(owners.get(cmd));
    if (!who) continue;
    let g = open.get(who.player);
    if (!who.hat) {
      if (!g || g.hats.length) open.set(who.player, (g = { bodies: [], hats: [] }));
      g.bodies.push(i);
      groupOf.set(i, g);
    } else if (g && g.bodies.every((b) => anchors.has((cmds[b] as Stamp).skin))) {
      g.hats.push(cmd);
      moved.add(i);
    }
  }
  if (moved.size === 0) return cmds.slice(from);
  const out: PenCmd[] = [];
  for (let i = from; i < cmds.length; i++) {
    if (moved.has(i)) continue;
    const cmd = cmds[i];
    out.push(cmd);
    const g = groupOf.get(i);
    if (!g || g.hats.length === 0) continue;
    // The fighter's outline stamps come first and have no hat stamps of their own. After the last of them the hat gets
    // its own white ring at the same width, so the outline goes round both. The game's ring leaves out one diagonal,
    // which shows most at the top of the figure, so the hat's ring has all eight.
    const outlines = g.bodies.length - g.hats.length;
    const j = g.bodies.indexOf(i);
    if (outlines > 0 && j === outlines - 1) {
      const main = cmds[g.bodies[outlines]] as Stamp;
      const ring = g.bodies.slice(0, outlines).map((b) => cmds[b] as Stamp);
      const w = Math.max(...ring.map((s) => Math.max(Math.abs(s.x - main.x), Math.abs(s.y - main.y))));
      const anchor = anchors.get(main.skin)!;
      for (const [dx, dy] of RING) out.push(worn({ ...main, x: main.x + dx * w, y: main.y + dy * w, fx: ring[0].fx }, g.hats[0], anchor));
    }
    if (j === g.bodies.length - 1) {
      g.hats.forEach((hat, h) => {
        const body = cmds[g.bodies[Math.max(0, outlines + h)]] as Stamp;
        out.push(worn(body, hat, anchors.get(body.skin)!));
      });
    }
  }
  return out;
}
