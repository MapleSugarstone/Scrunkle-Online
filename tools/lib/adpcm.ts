// Converts IMA ADPCM wav files to 16-bit PCM wav files. Browsers cannot decode ADPCM, which the original player
// decodes itself, so these sounds would otherwise be silent. The decoder follows the original player's: mono only,
// the same sample count, and the same clamping, so every 16-bit sample matches what it plays.

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173,
  190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
  18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEXES = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

function chunk(buf: Buffer, id: string): Buffer | null {
  for (let p = 12; p + 8 <= buf.length; ) {
    const size = buf.readUInt32LE(p + 4);
    if (buf.toString('latin1', p, p + 4) === id) return buf.subarray(p + 8, Math.min(buf.length, p + 8 + size));
    p += 8 + size + (size & 1);
  }
  return null;
}

/** True for a RIFF wav whose format chunk says IMA ADPCM. */
export function isAdpcm(buf: Buffer): boolean {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return false;
  const fmt = chunk(buf, 'fmt ');
  return !!fmt && fmt.length >= 2 && fmt.readUInt16LE(0) === 0x11;
}

/** The PCM wav that plays the same samples as an IMA ADPCM wav. */
export function adpcmToPcm(buf: Buffer): Buffer {
  const fmt = chunk(buf, 'fmt ')!;
  const data = chunk(buf, 'data')!;
  const rate = fmt.readUInt32LE(4);
  const samplesPerBlock = fmt.readUInt16LE(18);
  const blockSize = (samplesPerBlock - 1) / 2 + 4;
  const blocks = (data.length / blockSize) | 0;
  const count = blocks * 2 * (blockSize - 4) + 1 + Math.max((data.length % blockSize) - 4, 0) * 2 + Math.min(data.length % blockSize, 1);
  const out = new Int16Array(count);
  let p = 0;
  let i = 0;
  while (i < count && p + 4 <= data.length) {
    let sample = data.readInt16LE(p);
    let index = Math.min(data[p + 2], 88);
    p += 4;
    out[i++] = sample;
    const length = Math.min((blockSize - 4) * 2, count - i);
    const start = i;
    while (i - start < length && p < data.length) {
      const byte = data[p++];
      for (const code of [byte & 0xf, (byte >> 4) & 0xf]) {
        if (i - start >= length) break;
        const step = STEPS[index];
        let delta = step >> 3;
        if (code & 4) delta += step;
        if (code & 2) delta += step >> 1;
        if (code & 1) delta += step >> 2;
        index = Math.max(0, Math.min(88, index + INDEXES[code]));
        sample = Math.max(-32768, Math.min(32767, sample + (code & 8 ? -delta : delta)));
        out[i++] = sample;
      }
    }
  }
  const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF', 0, 'latin1');
  wav.writeUInt32LE(36 + count * 2, 4);
  wav.write('WAVEfmt ', 8, 'latin1');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'latin1');
  wav.writeUInt32LE(count * 2, 40);
  for (let k = 0; k < count; k++) wav.writeInt16LE(out[k], 44 + k * 2);
  return wav;
}
