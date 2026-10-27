import type { CostumeDef, SkinDef, SoundDef } from '../engine/defs.ts';
import data from './assets-data.json' with { type: 'json' };

const table = data as unknown as { skins: SkinDef[]; costumes: CostumeDef[][]; sounds: SoundDef[][] };

export const skins: SkinDef[] = table.skins;

export function costumes(targetIndex: number): CostumeDef[] {
  return table.costumes[targetIndex];
}

export const allCostumes: readonly CostumeDef[][] = table.costumes;

/** The skin of the first costume with this name in any sprite, or -1. */
export function skinOf(costume: string): number {
  for (const list of table.costumes) for (const c of list) if (c.name === costume) return c.skin;
  return -1;
}

export function sounds(targetIndex: number): SoundDef[] {
  return table.sounds[targetIndex];
}
