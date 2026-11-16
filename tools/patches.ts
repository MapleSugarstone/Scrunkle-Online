// Fixes to bugs in the game's own scripts, applied to the extracted project before it is transpiled, so game.sb3 stays
// the original. Each fix acts only in a state the bug leaves behind, so recorded scenarios still match the original.
import { Blocks, type Project, type Ref, type Target } from './lib/sb3-patch.ts';

function target(project: Project, name: string): Target {
  const t = project.targets.find((x) => x.name === name);
  if (!t) throw new Error(`patch: no target ${name}`);
  return t;
}

function stageList(project: Project, name: string): Ref {
  const stage = project.targets.find((x) => x.isStage)!;
  const hit = Object.entries(stage.lists).find(([, l]) => l[0] === name);
  if (!hit) throw new Error(`patch: no stage list ${name}`);
  return [name, hit[0]];
}

/** The top block of the target's one `when I receive` script for a message, matched without case as broadcasts are. */
function receiver(t: Target, message: string): string {
  const hits = Object.entries(t.blocks).filter(
    ([, b]) => b && !Array.isArray(b) && b.opcode === 'event_whenbroadcastreceived' && String(b.fields.BROADCAST_OPTION[0]).toLowerCase() === message.toLowerCase(),
  );
  if (hits.length !== 1) throw new Error(`patch: ${t.name} has ${hits.length} scripts for ${message}`);
  return hits[0][0];
}

/** The last block of the stack that starts at `id`. */
function stackEnd(t: Target, id: string): string {
  while (t.blocks[id].next) id = t.blocks[id].next!;
  return id;
}

/**
 * Switching characters in training mode, or closing the training menu, broadcasts `clear projectiles`, which deletes a
 * running super's clone before `define super` sets item 2 + player of `!P_Stunlock` back to 0 and the clone sets the
 * same item of `!P_Hitstun` to 0. The fighter's costume then never animates again, so its next attack never ends and
 * it can neither attack nor move. The training branch of `clear projectiles` now clears both items for a player whose
 * super it cut off.
 */
function trainingSuperSwitch(project: Project): void {
  const t = target(project, 'Hitbox Engine');
  const b = new Blocks(t, 'patchTrainingSuper');
  const isGimmick = (id: string) => t.blocks[id].opcode === 'procedures_call' && String(t.blocks[id].mutation?.proccode).startsWith('set gimmick');
  const branches = b.walk(receiver(t, 'clear projectiles')).filter((id) => {
    const body = t.blocks[id].opcode === 'control_if' ? t.blocks[id].inputs.SUBSTACK?.[1] : null;
    return typeof body === 'string' && b.walk(body).some(isGimmick);
  });
  if (branches.length !== 1) throw new Error(`patch: found ${branches.length} training branches in clear projectiles`);
  const stun = stageList(project, '!P_Stunlock');
  const hitstun = stageList(project, '!P_Hitstun');
  const fixes = [3, 4].map((i) => b.ifThen(b.not(b.equals(b.itemOf(i, stun), 0)), [b.replace(i, stun, 0), b.replace(i, hitstun, 0)]));
  b.insertAfter(stackEnd(t, t.blocks[branches[0]].inputs.SUBSTACK[1] as string), fixes);
}

const PATCHES: [string, (project: Project) => void][] = [['training super switch', trainingSuperSwitch]];

/** Applies every fix to the project and returns their names. */
export function applyPatches(project: Project): string[] {
  for (const [, apply] of PATCHES) apply(project);
  return PATCHES.map(([name]) => name);
}
