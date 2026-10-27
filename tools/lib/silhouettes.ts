import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Runtime } from '../../src/engine/runtime.ts';
import { decodeMaskSet } from '../../src/engine/masks.ts';
import { installSilhouettes } from '../../src/game/silhouettes.ts';

export const MASK_FILE = path.resolve(import.meta.dirname, '../../src/game/masks.bin');

export function loadSilhouettes(rt: Runtime): void {
  if (!fs.existsSync(MASK_FILE)) return;
  installSilhouettes(rt, decodeMaskSet(new Uint8Array(zlib.gunzipSync(fs.readFileSync(MASK_FILE)))));
}
