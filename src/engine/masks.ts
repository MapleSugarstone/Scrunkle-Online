// The touching masks file: every masked costume's 1-bit alpha mask as run lengths, behind a JSON index.
// The file on disk is gzipped. Callers decompress it, because browsers and the tools do that differently.

/** A costume's mask as stored: varint run lengths of clear and set pixels, alternating and starting with clear. */
export interface PackedMask {
  w: number;
  h: number;
  runs: Uint8Array;
}

/** Alpha mask of one costume at the renderer's 1x mip, used for touching tests. */
export interface Silhouette {
  w: number;
  h: number;
  /** One bit per pixel, row by row and lowest bit first, set where alpha > 0. */
  bits: Uint8Array;
}

/** Sprite name to its costumes' masks, in costume order. */
export type MaskSet = Record<string, PackedMask[]>;

function pushVarint(out: number[], n: number): void {
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

/** Run-length encodes a mask given as packed bits. */
export function packMask(w: number, h: number, bits: Uint8Array): PackedMask {
  const out: number[] = [];
  let on = false;
  let run = 0;
  for (let i = 0; i < w * h; i++) {
    const v = ((bits[i >> 3] >> (i & 7)) & 1) === 1;
    if (v !== on) {
      pushVarint(out, run);
      on = v;
      run = 0;
    }
    run++;
  }
  pushVarint(out, run);
  return { w, h, runs: Uint8Array.from(out) };
}

export function unpackMask(p: PackedMask): Silhouette {
  const bits = new Uint8Array(Math.ceil((p.w * p.h) / 8));
  let i = 0;
  let pos = 0;
  let on = false;
  while (pos < p.runs.length) {
    let run = 0;
    let shift = 1;
    for (;;) {
      const b = p.runs[pos++];
      run += (b & 0x7f) * shift;
      if (b < 0x80) break;
      shift *= 0x80;
    }
    if (on) for (let k = i; k < i + run; k++) bits[k >> 3] |= 1 << (k & 7);
    i += run;
    on = !on;
  }
  return { w: p.w, h: p.h, bits };
}

/** Writes the uncompressed file: a little-endian index length, the JSON index, then every mask's runs. */
export function encodeMaskSet(set: MaskSet): Uint8Array {
  const index: Record<string, [number, number, number, number][]> = {};
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const [name, masks] of Object.entries(set)) {
    index[name] = masks.map((m) => {
      chunks.push(m.runs);
      const entry: [number, number, number, number] = [m.w, m.h, offset, m.runs.length];
      offset += m.runs.length;
      return entry;
    });
  }
  const head = new TextEncoder().encode(JSON.stringify(index));
  const out = new Uint8Array(4 + head.length + offset);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  let at = 4 + head.length;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function decodeMaskSet(file: Uint8Array): MaskSet {
  const headLen = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(file.subarray(4, 4 + headLen))) as Record<string, [number, number, number, number][]>;
  const body = file.subarray(4 + headLen);
  const set: MaskSet = {};
  for (const [name, entries] of Object.entries(index)) {
    set[name] = entries.map(([w, h, off, len]) => ({ w, h, runs: body.subarray(off, off + len) }));
  }
  return set;
}
