// Reads and writes PNG images as RGBA pixels, for patches that import art: 8-bit gray, RGB, palette (any bit depth),
// gray with alpha and RGBA, without interlacing.
import zlib from 'node:zlib';

export interface Image { w: number; h: number; data: Uint8Array }

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function readPng(buf: Buffer): Image {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let o = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  let palette: Buffer = Buffer.alloc(0), alpha: Buffer = Buffer.alloc(0);
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), body = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; color = body[9]; interlace = body[12]; }
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') alpha = body;
    else if (type === 'IDAT') idat.push(body);
    o += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNGs are not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels || (color !== 3 && depth !== 8)) throw new Error(`PNG color type ${color} at depth ${depth} is not supported`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = (w * channels * depth + 7) >> 3;
  const rows: Uint8Array[] = [];
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      line[x] = (line[x] + pred) & 255;
    }
    rows.push(line);
    prev = line;
  }
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = rows[y], q = (y * w + x) * 4;
    if (color === 3) {
      const i = (r[(x * depth) >> 3] >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
      data.set([palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2], i < alpha.length ? alpha[i] : 255], q);
    } else if (color === 0) data.set([r[x], r[x], r[x], 255], q);
    else if (color === 2) data.set([r[x * 3], r[x * 3 + 1], r[x * 3 + 2], 255], q);
    else if (color === 4) data.set([r[x * 2], r[x * 2], r[x * 2], r[x * 2 + 1]], q);
    else data.set(r.subarray(x * 4, x * 4 + 4), q);
  }
  return { w, h, data };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, body: Buffer) => {
  const t = Buffer.from(type, 'ascii'), out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  t.copy(out, 4);
  body.copy(out, 8);
  out.writeUInt32BE(crc(Buffer.concat([t, body])), 8 + body.length);
  return out;
};

export function writePng(img: Image): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0);
  ihdr.writeUInt32BE(img.h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(img.h * (img.w * 4 + 1));
  for (let y = 0; y < img.h; y++) Buffer.from(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4)).copy(raw, y * (img.w * 4 + 1) + 1);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** The smallest box that holds every pixel with any alpha. */
export function contentBox(img: Image): { x: number; y: number; w: number; h: number } {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.data[(y * img.w + x) * 4 + 3] > 0) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (x1 < 0) throw new Error('the image is empty');
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function crop(img: Image, box: { x: number; y: number; w: number; h: number }): Image {
  const data = new Uint8Array(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) data.set(img.data.subarray(((box.y + y) * img.w + box.x) * 4, ((box.y + y) * img.w + box.x + box.w) * 4), y * box.w * 4);
  return { w: box.w, h: box.h, data };
}

export function mirror(img: Image): Image {
  const data = new Uint8Array(img.data.length);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) data.set(img.data.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4), (y * img.w + img.w - 1 - x) * 4);
  return { w: img.w, h: img.h, data };
}

/** Each pixel repeated in a k by k square, which keeps pixel art sharp. */
export function enlarge(img: Image, k: number): Image {
  const w = img.w * k, h = img.h * k, data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(img.data.subarray((((y / k) | 0) * img.w + ((x / k) | 0)) * 4, (((y / k) | 0) * img.w + ((x / k) | 0)) * 4 + 4), (y * w + x) * 4);
  return { w, h, data };
}

/** Scales an image down to fit a size, averaging the colors of the pixels each output pixel covers by their alpha. */
export function shrink(img: Image, maxW: number, maxH: number): Image {
  const s = Math.min(1, maxW / img.w, maxH / img.h);
  const w = Math.max(1, Math.round(img.w * s)), h = Math.max(1, Math.round(img.h * s)), data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = Math.floor(y / s); sy < Math.min(img.h, Math.ceil((y + 1) / s)); sy++) for (let sx = Math.floor(x / s); sx < Math.min(img.w, Math.ceil((x + 1) / s)); sx++) {
      const q = (sy * img.w + sx) * 4, al = img.data[q + 3];
      r += img.data[q] * al; g += img.data[q + 1] * al; b += img.data[q + 2] * al; a += al; n++;
    }
    data.set(a ? [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / n)] : [0, 0, 0, 0], (y * w + x) * 4);
  }
  return { w, h, data };
}
