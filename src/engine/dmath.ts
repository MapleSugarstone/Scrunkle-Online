// Transcendental functions that give the same bits in every JavaScript engine. Engines ship
// different libm code for Math.sin, Math.atan and the rest, and a one-bit difference desyncs an
// online game. These follow the classic freely distributable libm algorithms and use only +, -, *, / and sqrt,
// which IEEE 754 rounds identically everywhere.

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
// Word order of a double in memory; every current browser is little-endian.
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
const LO = 1 - HI;

function highWord(x: number): number {
  F64[0] = x;
  return U32[HI] | 0;
}
function lowWord(x: number): number {
  F64[0] = x;
  return U32[LO];
}
function fromWords(hi: number, lo: number): number {
  U32[HI] = hi;
  U32[LO] = lo;
  return F64[0];
}
function withLow(x: number, lo: number): number {
  F64[0] = x;
  U32[LO] = lo;
  return F64[0];
}
function withHigh(x: number, hi: number): number {
  F64[0] = x;
  U32[HI] = hi;
  return F64[0];
}
/** x * 2^n for the exponent range the reduction needs (exact). */
function scalbn(x: number, n: number): number {
  while (n > 1000) {
    x *= fromWords(0x7e700000, 0); // 2^1000
    n -= 1000;
  }
  while (n < -1000) {
    x *= fromWords(0x01700000, 0); // 2^-1000
    n += 1000;
  }
  return x * fromWords((n + 1023) << 20, 0);
}

// ------------------------------------------------------------------ argument reduction

const TWO_OVER_PI = [
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62, 0x95993c, 0x439041, 0xfe5163, 0xabdebb, 0xc561b7, 0x246e3a,
  0x424dd2, 0xe00649, 0x2eea09, 0xd1921c, 0xfe1deb, 0x1cb129, 0xa73ee8, 0x8235f5, 0x2ebb44, 0x84e99c, 0x7026b4, 0x5f7e41,
  0x3991d6, 0x398353, 0x39f49c, 0x845f8b, 0xbdf928, 0x3b1ff8, 0x97ffde, 0x05980f, 0xef2f11, 0x8b5a0a, 0x6d1f6d, 0x367ecf,
  0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d, 0x7527ba, 0xc7ebe5, 0xf17b3d, 0x0739f7, 0x8a5292, 0xea6bfb, 0x5fb11f, 0x8d5d08,
  0x560330, 0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3, 0x91615e, 0xe61b08, 0x659985, 0x5f14a0, 0x68408d, 0xffd880,
  0x4d7327, 0x310606, 0x1556ca, 0x73a8c9, 0x60e27b, 0xc08c6b,
];
const NPIO2_HW = [
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb, 0x402921fb, 0x402c463a, 0x402f6a7a,
  0x4031475c, 0x4032d97c, 0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb, 0x403ab41b, 0x403c463a, 0x403dd85a, 0x403f6a7a,
  0x40407e4c, 0x4041475c, 0x4042106c, 0x4042d97c, 0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb, 0x4046c6cb, 0x40478fdb,
  0x404858eb, 0x404921fb,
];
const PIO2 = [
  1.57079625129699707031e0, 7.54978941586159635335e-8, 5.39030252995776476554e-15, 3.28200341580791294123e-22,
  1.27065575308067607349e-29, 1.22933308981111328932e-36, 2.73370053816464559624e-44, 2.16741683877804819444e-51,
];
const TWO24 = 1.6777216e7;
const TWON24 = 5.9604644775390625e-8;
const INVPIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417e0;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32;

/** Payne-Hanek reduction for huge arguments; writes y[0..1] and returns n mod 8. */
function kernelRemPio2(x: number[], y: number[], e0: number, nx: number): number {
  const jk = 4; // precision 2 (double)
  const jp = jk;
  const iq: number[] = new Array(20).fill(0);
  const f: number[] = new Array(20).fill(0);
  const fq: number[] = new Array(20).fill(0);
  const q: number[] = new Array(20).fill(0);
  const jx = nx - 1;
  let jv = ((e0 - 3) / 24) | 0;
  if (jv < 0) jv = 0;
  let q0 = e0 - 24 * (jv + 1);
  let j = jv - jx;
  const m = jx + jk;
  for (let i = 0; i <= m; i++, j++) f[i] = j < 0 ? 0 : TWO_OVER_PI[j];
  for (let i = 0; i <= jk; i++) {
    let fw = 0;
    for (j = 0; j <= jx; j++) fw += x[j] * f[jx + i - j];
    q[i] = fw;
  }
  let jz = jk;
  let z: number;
  let n: number;
  let ih: number;
  for (;;) {
    let i = 0;
    z = q[jz];
    for (j = jz; j > 0; i++, j--) {
      const fw = (TWON24 * z) | 0;
      iq[i] = (z - TWO24 * fw) | 0;
      z = q[j - 1] + fw;
    }
    z = scalbn(z, q0);
    z -= 8.0 * Math.floor(z * 0.125);
    n = z | 0;
    z -= n;
    ih = 0;
    if (q0 > 0) {
      i = iq[jz - 1] >> (24 - q0);
      n += i;
      iq[jz - 1] -= i << (24 - q0);
      ih = iq[jz - 1] >> (23 - q0);
    } else if (q0 === 0) ih = iq[jz - 1] >> 23;
    else if (z >= 0.5) ih = 2;
    if (ih > 0) {
      n += 1;
      let carry = 0;
      for (i = 0; i < jz; i++) {
        const w = iq[i];
        if (carry === 0) {
          if (w !== 0) {
            carry = 1;
            iq[i] = 0x1000000 - w;
          }
        } else iq[i] = 0xffffff - w;
      }
      if (q0 > 0) {
        if (q0 === 1) iq[jz - 1] &= 0x7fffff;
        else if (q0 === 2) iq[jz - 1] &= 0x3fffff;
      }
      if (ih === 2) {
        z = 1 - z;
        if (carry !== 0) z -= scalbn(1, q0);
      }
    }
    if (z === 0) {
      let all = 0;
      for (i = jz - 1; i >= jk; i--) all |= iq[i];
      if (all === 0) {
        let k = 1;
        while (iq[jk - k] === 0) k++;
        for (i = jz + 1; i <= jz + k; i++) {
          f[jx + i] = TWO_OVER_PI[jv + i];
          let fw = 0;
          for (j = 0; j <= jx; j++) fw += x[j] * f[jx + i - j];
          q[i] = fw;
        }
        jz += k;
        continue;
      }
    }
    break;
  }
  if (z === 0) {
    jz -= 1;
    q0 -= 24;
    while (iq[jz] === 0) {
      jz--;
      q0 -= 24;
    }
  } else {
    z = scalbn(z, -q0);
    if (z >= TWO24) {
      const fw = (TWON24 * z) | 0;
      iq[jz] = (z - TWO24 * fw) | 0;
      jz += 1;
      q0 += 24;
      iq[jz] = fw;
    } else iq[jz] = z | 0;
  }
  let fw = scalbn(1, q0);
  for (let i = jz; i >= 0; i--) {
    q[i] = fw * iq[i];
    fw *= TWON24;
  }
  for (let i = jz; i >= 0; i--) {
    fw = 0;
    for (let k = 0; k <= jp && k <= jz - i; k++) fw += PIO2[k] * q[i + k];
    fq[jz - i] = fw;
  }
  fw = 0;
  for (let i = jz; i >= 0; i--) fw += fq[i];
  y[0] = ih === 0 ? fw : -fw;
  fw = fq[0] - fw;
  for (let i = 1; i <= jz; i++) fw += fq[i];
  y[1] = ih === 0 ? fw : -fw;
  return n & 7;
}

/** Reduces x to y[0] + y[1] in [-pi/4, pi/4]; returns the quadrant count. */
function remPio2(x: number, y: number[]): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    y[0] = x;
    y[1] = 0;
    return 0;
  }
  if (ix < 0x4002d97c) {
    if (hx > 0) {
      let z = x - PIO2_1;
      if (ix !== 0x3ff921fb) {
        y[0] = z - PIO2_1T;
        y[1] = z - y[0] - PIO2_1T;
      } else {
        z -= PIO2_2;
        y[0] = z - PIO2_2T;
        y[1] = z - y[0] - PIO2_2T;
      }
      return 1;
    }
    let z = x + PIO2_1;
    if (ix !== 0x3ff921fb) {
      y[0] = z + PIO2_1T;
      y[1] = z - y[0] + PIO2_1T;
    } else {
      z += PIO2_2;
      y[0] = z + PIO2_2T;
      y[1] = z - y[0] + PIO2_2T;
    }
    return -1;
  }
  if (ix <= 0x413921fb) {
    let t = Math.abs(x);
    const n = (t * INVPIO2 + 0.5) | 0;
    const fn = n;
    let r = t - fn * PIO2_1;
    let w = fn * PIO2_1T;
    if (n < 32 && ix !== NPIO2_HW[n - 1]) {
      y[0] = r - w;
    } else {
      const j = ix >> 20;
      y[0] = r - w;
      let i = j - ((highWord(y[0]) >> 20) & 0x7ff);
      if (i > 16) {
        t = r;
        w = fn * PIO2_2;
        r = t - w;
        w = fn * PIO2_2T - (t - r - w);
        y[0] = r - w;
        i = j - ((highWord(y[0]) >> 20) & 0x7ff);
        if (i > 49) {
          t = r;
          w = fn * PIO2_3;
          r = t - w;
          w = fn * PIO2_3T - (t - r - w);
          y[0] = r - w;
        }
      }
    }
    y[1] = r - y[0] - w;
    if (hx < 0) {
      y[0] = -y[0];
      y[1] = -y[1];
      return -n;
    }
    return n;
  }
  if (ix >= 0x7ff00000) {
    y[0] = y[1] = x - x;
    return 0;
  }
  const low = lowWord(x);
  const e0 = (ix >> 20) - 1046;
  let z = fromWords(ix - (e0 << 20), low);
  const tx = [0, 0, 0];
  for (let i = 0; i < 2; i++) {
    tx[i] = z | 0;
    z = (z - tx[i]) * TWO24;
  }
  tx[2] = z;
  let nx = 3;
  while (tx[nx - 1] === 0) nx--;
  const n = kernelRemPio2(tx, y, e0, nx);
  if (hx < 0) {
    y[0] = -y[0];
    y[1] = -y[1];
    return -n;
  }
  return n;
}

// ------------------------------------------------------------------ kernels on [-pi/4, pi/4]

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

function kSin(x: number, y: number, iy: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000 && (x | 0) === 0) return x;
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

function kCos(x: number, y: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000 && (x | 0) === 0) return 1;
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y));
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0);
  const hz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (hz - (z * r - x * y));
}

const T = [
  3.33333333333334091986e-1, 1.33333333333201242699e-1, 5.39682539762260521377e-2, 2.18694882948595424599e-2,
  8.86323982359930005737e-3, 3.59207910759131235356e-3, 1.45620945432529025516e-3, 5.88041240820264096874e-4,
  2.46463134818469906812e-4, 7.81794442939557092300e-5, 7.14072491382608190305e-5, -1.85586374855275456654e-5,
  2.59073051863633712884e-5,
];
const PIO4 = 7.85398163397448278999e-1;
const PIO4LO = 3.06161699786838301793e-17;

function kTan(x: number, y: number, iy: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  let z: number;
  let w: number;
  let v: number;
  let s: number;
  let r: number;
  if (ix < 0x3e300000 && (x | 0) === 0) {
    const low = lowWord(x);
    if ((ix | low | (iy + 1)) === 0) return 1 / Math.abs(x);
    if (iy === 1) return x;
    w = x + y;
    z = withLow(w, 0);
    v = y - (z - x);
    const a = -1 / w;
    const t = withLow(a, 0);
    s = 1 + t * z;
    return t + a * (s + t * v);
  }
  if (ix >= 0x3fe59428) {
    if (hx < 0) {
      x = -x;
      y = -y;
    }
    z = PIO4 - x;
    w = PIO4LO - y;
    x = z + w;
    y = 0;
  }
  z = x * x;
  w = z * z;
  r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
  v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
  s = z * x;
  r = y + z * (s * (r + v) + y);
  r += T[0] * s;
  w = x + r;
  if (ix >= 0x3fe59428) {
    v = iy;
    return (1 - ((hx >> 30) & 2)) * (v - 2.0 * (x - (w * w / (w + v) - r)));
  }
  if (iy === 1) return w;
  z = withLow(w, 0);
  v = r - (z - x);
  const a = -1.0 / w;
  const t = withLow(a, 0);
  s = 1.0 + t * z;
  return t + a * (s + t * v);
}

const Y = [0, 0];

export function sin(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kSin(x, 0, 0);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x, Y);
  switch (n & 3) {
    case 0: return kSin(Y[0], Y[1], 1);
    case 1: return kCos(Y[0], Y[1]);
    case 2: return -kSin(Y[0], Y[1], 1);
    default: return -kCos(Y[0], Y[1]);
  }
}

export function cos(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kCos(x, 0);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x, Y);
  switch (n & 3) {
    case 0: return kCos(Y[0], Y[1]);
    case 1: return -kSin(Y[0], Y[1], 1);
    case 2: return -kCos(Y[0], Y[1]);
    default: return kSin(Y[0], Y[1], 1);
  }
}

export function tan(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kTan(x, 0, 1);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x, Y);
  return kTan(Y[0], Y[1], 1 - ((n & 1) << 1));
}

// ------------------------------------------------------------------ inverse trig

const ATANHI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800e0];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.11111104054623557880e-1,
  9.09088713343650656196e-2, -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2,
  4.97687799461593236017e-2, -3.65315727442169155270e-2, 1.62858201153657823623e-2,
];

export function atan(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  let id: number;
  if (ix >= 0x44100000) {
    const low = lowWord(x);
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && low !== 0)) return x + x;
    return hx > 0 ? ATANHI[3] + ATANLO[3] : -ATANHI[3] - ATANLO[3];
  }
  if (ix < 0x3fdc0000) {
    if (ix < 0x3e200000) return x;
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) {
        id = 0;
        x = (2.0 * x - 1.0) / (2.0 + x);
      } else {
        id = 1;
        x = (x - 1.0) / (x + 1.0);
      }
    } else if (ix < 0x40038000) {
      id = 2;
      x = (x - 1.5) / (1.0 + 1.5 * x);
    } else {
      id = 3;
      x = -1.0 / x;
    }
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATANHI[id] - (x * (s1 + s2) - ATANLO[id] - x);
  return hx < 0 ? -r : r;
}

const PI = 3.1415926535897931160e0;
const PI_O_2 = 1.5707963267948965580e0;
const PI_O_4 = 7.8539816339744827900e-1;
const PI_LO = 1.2246467991473531772e-16;
const TINY = 1.0e-300;

export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return x + y;
  const hx = highWord(x);
  const lx = lowWord(x);
  const ix = hx & 0x7fffffff;
  const hy = highWord(y);
  const ly = lowWord(y);
  const iy = hy & 0x7fffffff;
  if (((hx - 0x3ff00000) | lx) === 0) return atan(y);
  const m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
  if ((iy | ly) === 0) {
    switch (m) {
      case 0:
      case 1: return y;
      case 2: return PI + TINY;
      default: return -PI - TINY;
    }
  }
  if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY;
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0: return PI_O_4 + TINY;
        case 1: return -PI_O_4 - TINY;
        case 2: return 3.0 * PI_O_4 + TINY;
        default: return -3.0 * PI_O_4 - TINY;
      }
    }
    switch (m) {
      case 0: return 0;
      case 1: return -0;
      case 2: return PI + TINY;
      default: return -PI - TINY;
    }
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY;
  const k = (iy - ix) >> 20;
  let z: number;
  if (k > 60) z = PI_O_2 + 0.5 * PI_LO;
  else if (hx < 0 && k < -60) z = 0;
  else z = atan(Math.abs(y / x));
  switch (m) {
    case 0: return z;
    case 1: return -z;
    case 2: return PI - (z - PI_LO);
    default: return z - PI_LO - PI;
  }
}

const PIO2_HI = 1.57079632679489655800e0;
const PIO2_LO = 6.12323399573676603587e-17;
const PIO4_HI = 7.85398163397448278999e-1;
const PS0 = 1.66666666666666657415e-1;
const PS1 = -3.25565818622400915405e-1;
const PS2 = 2.01212532134862925881e-1;
const PS3 = -4.00555345006794114027e-2;
const PS4 = 7.91534994289814532176e-4;
const PS5 = 3.47933107596021167570e-5;
const QS1 = -2.40339491173441421878e0;
const QS2 = 2.02094576023350569471e0;
const QS3 = -6.88283971605453293030e-1;
const QS4 = 7.70381505559019352791e-2;

export function asin(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    const lx = lowWord(x);
    if (((ix - 0x3ff00000) | lx) === 0) return x * PIO2_HI + x * PIO2_LO;
    return (x - x) / (x - x);
  }
  if (ix < 0x3fe00000) {
    if (ix < 0x3e400000) return x;
    const t = x * x;
    const p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
    const q = 1 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
    return x + x * (p / q);
  }
  const w0 = 1 - Math.abs(x);
  let t = w0 * 0.5;
  let p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
  let q = 1 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
  const s = Math.sqrt(t);
  if (ix >= 0x3fef3333) {
    const w = p / q;
    t = PIO2_HI - (2.0 * (s + s * w) - PIO2_LO);
  } else {
    const w = withLow(s, 0);
    const c = (t - w * w) / (s + w);
    const r = p / q;
    p = 2.0 * s * r - (PIO2_LO - 2.0 * c);
    q = PIO4_HI - 2.0 * w;
    t = PIO4_HI - (p - q);
  }
  return hx > 0 ? t : -t;
}

export function acos(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    const lx = lowWord(x);
    if (((ix - 0x3ff00000) | lx) === 0) return hx > 0 ? 0 : PI + 2.0 * PIO2_LO;
    return (x - x) / (x - x);
  }
  if (ix < 0x3fe00000) {
    if (ix <= 0x3c600000) return PIO2_HI + PIO2_LO;
    const z = x * x;
    const p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
    const q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
    const r = p / q;
    return PIO2_HI - (x - (PIO2_LO - x * r));
  }
  if (hx < 0) {
    const z = (1 + x) * 0.5;
    const p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
    const q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
    const s = Math.sqrt(z);
    const r = p / q;
    const w = r * s - PIO2_LO;
    return PI - 2.0 * (s + w);
  }
  const z = (1 - x) * 0.5;
  const s = Math.sqrt(z);
  const df = withLow(s, 0);
  const c = (z - df * df) / (s + df);
  const p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
  const q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
  const r = p / q;
  const w = r * s + c;
  return 2.0 * (df + w);
}

// ------------------------------------------------------------------ exp and log

const HALF = [0.5, -0.5];
const O_THRESHOLD = 7.09782712893383973096e2;
const U_THRESHOLD = -7.45133219101941108420e2;
const LN2HI = [6.93147180369123816490e-1, -6.93147180369123816490e-1];
const LN2LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
const INVLN2 = 1.44269504088896338700e0;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;
const TWOM1000 = 9.33263618503218878990e-302;

export function exp(x: number): number {
  let hx = highWord(x);
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7fffffff;
  let hi = 0;
  let lo = 0;
  let k = 0;
  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) {
      const lx = lowWord(x);
      if (((hx & 0xfffff) | lx) !== 0) return x + x;
      return xsb === 0 ? x : 0;
    }
    if (x > O_THRESHOLD) return Infinity;
    if (x < U_THRESHOLD) return 0;
  }
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      hi = x - LN2HI[xsb];
      lo = LN2LO[xsb];
      k = 1 - xsb - xsb;
    } else {
      k = (INVLN2 * x + HALF[xsb]) | 0;
      const t = k;
      hi = x - t * LN2HI[0];
      lo = t * LN2LO[0];
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    return 1 + x;
  }
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - (x * c / (c - 2.0) - x);
  const y = 1 - (lo - x * c / (2.0 - c) - hi);
  if (k >= -1021) return withHigh(y, highWord(y) + (k << 20));
  return withHigh(y, highWord(y) + ((k + 1000) << 20)) * TWOM1000;
}

const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const TWO54 = 1.80143985094819840000e16;
const LG1 = 6.666666666666735130e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;

export function log(x: number): number {
  let hx = highWord(x);
  const lx = lowWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54;
    hx = highWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  let i = (hx + 0x95f64) & 0x100000;
  x = withHigh(x, hx | (i ^ 0x3ff00000));
  k += i >> 20;
  const f = x - 1.0;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) {
      if (k === 0) return 0;
      const dk = k;
      return dk * LN2_HI + dk * LN2_LO;
    }
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    if (k === 0) return f - R;
    const dk = k;
    return dk * LN2_HI - (R - dk * LN2_LO - f);
  }
  const s = f / (2.0 + f);
  const dk = k;
  const z = s * s;
  i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + R));
    return dk * LN2_HI - (hfsq - (s * (hfsq + R) + dk * LN2_LO) - f);
  }
  if (k === 0) return f - s * (f - R);
  return dk * LN2_HI - (s * (f - R) - dk * LN2_LO - f);
}

/** 2^y without the engine's pow. */
export function pow2(y: number): number {
  return exp(y * 0.6931471805599453);
}
