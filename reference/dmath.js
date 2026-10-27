"use strict";
var DMATH = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/engine/dmath.ts
  var dmath_exports = {};
  __export(dmath_exports, {
    acos: () => acos,
    asin: () => asin,
    atan: () => atan,
    atan2: () => atan2,
    cos: () => cos,
    exp: () => exp,
    log: () => log,
    pow2: () => pow2,
    sin: () => sin,
    tan: () => tan
  });
  var F64 = new Float64Array(1);
  var U32 = new Uint32Array(F64.buffer);
  var HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
  var LO = 1 - HI;
  function highWord(x) {
    F64[0] = x;
    return U32[HI] | 0;
  }
  function lowWord(x) {
    F64[0] = x;
    return U32[LO];
  }
  function fromWords(hi, lo) {
    U32[HI] = hi;
    U32[LO] = lo;
    return F64[0];
  }
  function withLow(x, lo) {
    F64[0] = x;
    U32[LO] = lo;
    return F64[0];
  }
  function withHigh(x, hi) {
    F64[0] = x;
    U32[HI] = hi;
    return F64[0];
  }
  function scalbn(x, n) {
    while (n > 1e3) {
      x *= fromWords(2121269248, 0);
      n -= 1e3;
    }
    while (n < -1e3) {
      x *= fromWords(24117248, 0);
      n += 1e3;
    }
    return x * fromWords(n + 1023 << 20, 0);
  }
  var TWO_OVER_PI = [
    10680707,
    7228996,
    1387004,
    2578385,
    16069853,
    12639074,
    9804092,
    4427841,
    16666979,
    11263675,
    12935607,
    2387514,
    4345298,
    14681673,
    3074569,
    13734428,
    16653803,
    1880361,
    10960616,
    8533493,
    3062596,
    8710556,
    7349940,
    6258241,
    3772886,
    3769171,
    3798172,
    8675211,
    12450088,
    3874808,
    9961438,
    366607,
    15675153,
    9132554,
    7151469,
    3571407,
    2607881,
    12013382,
    4155038,
    6285869,
    7677882,
    13102053,
    15825725,
    473591,
    9065106,
    15363067,
    6271263,
    9264392,
    5636912,
    4652155,
    7056368,
    13614112,
    10155062,
    1944035,
    9527646,
    15080200,
    6658437,
    6231200,
    6832269,
    16767104,
    5075751,
    3212806,
    1398474,
    7579849,
    6349435,
    12618859
  ];
  var NPIO2_HW = [
    1073291771,
    1074340347,
    1074977148,
    1075388923,
    1075800698,
    1076025724,
    1076231611,
    1076437499,
    1076643386,
    1076849274,
    1076971356,
    1077074300,
    1077177244,
    1077280187,
    1077383131,
    1077486075,
    1077589019,
    1077691962,
    1077794906,
    1077897850,
    1077968460,
    1078019932,
    1078071404,
    1078122876,
    1078174348,
    1078225820,
    1078277292,
    1078328763,
    1078380235,
    1078431707,
    1078483179,
    1078534651
  ];
  var PIO2 = [
    1.570796251296997,
    7549789415861596e-23,
    5390302529957765e-30,
    3282003415807913e-37,
    1270655753080676e-44,
    12293330898111133e-52,
    27337005381646456e-60,
    21674168387780482e-67
  ];
  var TWO24 = 16777216;
  var TWON24 = 5960464477539063e-23;
  var INVPIO2 = 0.6366197723675814;
  var PIO2_1 = 1.5707963267341256;
  var PIO2_1T = 6077100506506192e-26;
  var PIO2_2 = 6077100506303966e-26;
  var PIO2_2T = 20222662487959506e-37;
  var PIO2_3 = 20222662487111665e-37;
  var PIO2_3T = 84784276603689e-45;
  function kernelRemPio2(x, y, e0, nx) {
    const jk = 4;
    const jp = jk;
    const iq = new Array(20).fill(0);
    const f = new Array(20).fill(0);
    const fq = new Array(20).fill(0);
    const q = new Array(20).fill(0);
    const jx = nx - 1;
    let jv = (e0 - 3) / 24 | 0;
    if (jv < 0) jv = 0;
    let q0 = e0 - 24 * (jv + 1);
    let j = jv - jx;
    const m = jx + jk;
    for (let i = 0; i <= m; i++, j++) f[i] = j < 0 ? 0 : TWO_OVER_PI[j];
    for (let i = 0; i <= jk; i++) {
      let fw2 = 0;
      for (j = 0; j <= jx; j++) fw2 += x[j] * f[jx + i - j];
      q[i] = fw2;
    }
    let jz = jk;
    let z;
    let n;
    let ih;
    for (; ; ) {
      let i = 0;
      z = q[jz];
      for (j = jz; j > 0; i++, j--) {
        const fw2 = TWON24 * z | 0;
        iq[i] = z - TWO24 * fw2 | 0;
        z = q[j - 1] + fw2;
      }
      z = scalbn(z, q0);
      z -= 8 * Math.floor(z * 0.125);
      n = z | 0;
      z -= n;
      ih = 0;
      if (q0 > 0) {
        i = iq[jz - 1] >> 24 - q0;
        n += i;
        iq[jz - 1] -= i << 24 - q0;
        ih = iq[jz - 1] >> 23 - q0;
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
              iq[i] = 16777216 - w;
            }
          } else iq[i] = 16777215 - w;
        }
        if (q0 > 0) {
          if (q0 === 1) iq[jz - 1] &= 8388607;
          else if (q0 === 2) iq[jz - 1] &= 4194303;
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
            let fw2 = 0;
            for (j = 0; j <= jx; j++) fw2 += x[j] * f[jx + i - j];
            q[i] = fw2;
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
        const fw2 = TWON24 * z | 0;
        iq[jz] = z - TWO24 * fw2 | 0;
        jz += 1;
        q0 += 24;
        iq[jz] = fw2;
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
  function remPio2(x, y) {
    const hx = highWord(x);
    const ix = hx & 2147483647;
    if (ix <= 1072243195) {
      y[0] = x;
      y[1] = 0;
      return 0;
    }
    if (ix < 1073928572) {
      if (hx > 0) {
        let z3 = x - PIO2_1;
        if (ix !== 1073291771) {
          y[0] = z3 - PIO2_1T;
          y[1] = z3 - y[0] - PIO2_1T;
        } else {
          z3 -= PIO2_2;
          y[0] = z3 - PIO2_2T;
          y[1] = z3 - y[0] - PIO2_2T;
        }
        return 1;
      }
      let z2 = x + PIO2_1;
      if (ix !== 1073291771) {
        y[0] = z2 + PIO2_1T;
        y[1] = z2 - y[0] + PIO2_1T;
      } else {
        z2 += PIO2_2;
        y[0] = z2 + PIO2_2T;
        y[1] = z2 - y[0] + PIO2_2T;
      }
      return -1;
    }
    if (ix <= 1094263291) {
      let t = Math.abs(x);
      const n2 = t * INVPIO2 + 0.5 | 0;
      const fn = n2;
      let r = t - fn * PIO2_1;
      let w = fn * PIO2_1T;
      if (n2 < 32 && ix !== NPIO2_HW[n2 - 1]) {
        y[0] = r - w;
      } else {
        const j = ix >> 20;
        y[0] = r - w;
        let i = j - (highWord(y[0]) >> 20 & 2047);
        if (i > 16) {
          t = r;
          w = fn * PIO2_2;
          r = t - w;
          w = fn * PIO2_2T - (t - r - w);
          y[0] = r - w;
          i = j - (highWord(y[0]) >> 20 & 2047);
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
        return -n2;
      }
      return n2;
    }
    if (ix >= 2146435072) {
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
  var S1 = -0.16666666666666632;
  var S2 = 0.00833333333332249;
  var S3 = -1984126982985795e-19;
  var S4 = 27557313707070068e-22;
  var S5 = -25050760253406863e-24;
  var S6 = 158969099521155e-24;
  function kSin(x, y, iy) {
    const ix = highWord(x) & 2147483647;
    if (ix < 1044381696 && (x | 0) === 0) return x;
    const z = x * x;
    const v = z * x;
    const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if (iy === 0) return x + v * (S1 + z * r);
    return x - (z * (0.5 * y - v * r) - y - v * S1);
  }
  var C1 = 0.0416666666666666;
  var C2 = -0.001388888888887411;
  var C3 = 2480158728947673e-20;
  var C4 = -27557314351390663e-23;
  var C5 = 2087572321298175e-24;
  var C6 = -11359647557788195e-27;
  function kCos(x, y) {
    const ix = highWord(x) & 2147483647;
    if (ix < 1044381696 && (x | 0) === 0) return 1;
    const z = x * x;
    const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if (ix < 1070805811) return 1 - (0.5 * z - (z * r - x * y));
    const qx = ix > 1072234496 ? 0.28125 : fromWords(ix - 2097152, 0);
    const hz = 0.5 * z - qx;
    const a = 1 - qx;
    return a - (hz - (z * r - x * y));
  }
  var T = [
    0.3333333333333341,
    0.13333333333320124,
    0.05396825397622605,
    0.021869488294859542,
    0.0088632398235993,
    0.0035920791075913124,
    0.0014562094543252903,
    5880412408202641e-19,
    2464631348184699e-19,
    7817944429395571e-20,
    7140724913826082e-20,
    -18558637485527546e-21,
    2590730518636337e-20
  ];
  var PIO4 = 0.7853981633974483;
  var PIO4LO = 3061616997868383e-32;
  function kTan(x, y, iy) {
    const hx = highWord(x);
    const ix = hx & 2147483647;
    let z;
    let w;
    let v;
    let s;
    let r;
    if (ix < 1043333120 && (x | 0) === 0) {
      const low = lowWord(x);
      if ((ix | low | iy + 1) === 0) return 1 / Math.abs(x);
      if (iy === 1) return x;
      w = x + y;
      z = withLow(w, 0);
      v = y - (z - x);
      const a2 = -1 / w;
      const t2 = withLow(a2, 0);
      s = 1 + t2 * z;
      return t2 + a2 * (s + t2 * v);
    }
    if (ix >= 1072010280) {
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
    if (ix >= 1072010280) {
      v = iy;
      return (1 - (hx >> 30 & 2)) * (v - 2 * (x - (w * w / (w + v) - r)));
    }
    if (iy === 1) return w;
    z = withLow(w, 0);
    v = r - (z - x);
    const a = -1 / w;
    const t = withLow(a, 0);
    s = 1 + t * z;
    return t + a * (s + t * v);
  }
  var Y = [0, 0];
  function sin(x) {
    const ix = highWord(x) & 2147483647;
    if (ix <= 1072243195) return kSin(x, 0, 0);
    if (ix >= 2146435072) return x - x;
    const n = remPio2(x, Y);
    switch (n & 3) {
      case 0:
        return kSin(Y[0], Y[1], 1);
      case 1:
        return kCos(Y[0], Y[1]);
      case 2:
        return -kSin(Y[0], Y[1], 1);
      default:
        return -kCos(Y[0], Y[1]);
    }
  }
  function cos(x) {
    const ix = highWord(x) & 2147483647;
    if (ix <= 1072243195) return kCos(x, 0);
    if (ix >= 2146435072) return x - x;
    const n = remPio2(x, Y);
    switch (n & 3) {
      case 0:
        return kCos(Y[0], Y[1]);
      case 1:
        return -kSin(Y[0], Y[1], 1);
      case 2:
        return -kCos(Y[0], Y[1]);
      default:
        return kSin(Y[0], Y[1], 1);
    }
  }
  function tan(x) {
    const ix = highWord(x) & 2147483647;
    if (ix <= 1072243195) return kTan(x, 0, 1);
    if (ix >= 2146435072) return x - x;
    const n = remPio2(x, Y);
    return kTan(Y[0], Y[1], 1 - ((n & 1) << 1));
  }
  var ATANHI = [0.4636476090008061, 0.7853981633974483, 0.982793723247329, 1.5707963267948966];
  var ATANLO = [22698777452961687e-33, 3061616997868383e-32, 13903311031230998e-33, 6123233995736766e-32];
  var AT = [
    0.3333333333333293,
    -0.19999999999876483,
    0.14285714272503466,
    -0.11111110405462356,
    0.09090887133436507,
    -0.0769187620504483,
    0.06661073137387531,
    -0.058335701337905735,
    0.049768779946159324,
    -0.036531572744216916,
    0.016285820115365782
  ];
  function atan(x) {
    const hx = highWord(x);
    const ix = hx & 2147483647;
    let id;
    if (ix >= 1141899264) {
      const low = lowWord(x);
      if (ix > 2146435072 || ix === 2146435072 && low !== 0) return x + x;
      return hx > 0 ? ATANHI[3] + ATANLO[3] : -ATANHI[3] - ATANLO[3];
    }
    if (ix < 1071382528) {
      if (ix < 1042284544) return x;
      id = -1;
    } else {
      x = Math.abs(x);
      if (ix < 1072889856) {
        if (ix < 1072037888) {
          id = 0;
          x = (2 * x - 1) / (2 + x);
        } else {
          id = 1;
          x = (x - 1) / (x + 1);
        }
      } else if (ix < 1073971200) {
        id = 2;
        x = (x - 1.5) / (1 + 1.5 * x);
      } else {
        id = 3;
        x = -1 / x;
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
  var PI = 3.141592653589793;
  var PI_O_2 = 1.5707963267948966;
  var PI_O_4 = 0.7853981633974483;
  var PI_LO = 12246467991473532e-32;
  var TINY = 1e-300;
  function atan2(y, x) {
    if (Number.isNaN(x) || Number.isNaN(y)) return x + y;
    const hx = highWord(x);
    const lx = lowWord(x);
    const ix = hx & 2147483647;
    const hy = highWord(y);
    const ly = lowWord(y);
    const iy = hy & 2147483647;
    if ((hx - 1072693248 | lx) === 0) return atan(y);
    const m = hy >> 31 & 1 | hx >> 30 & 2;
    if ((iy | ly) === 0) {
      switch (m) {
        case 0:
        case 1:
          return y;
        case 2:
          return PI + TINY;
        default:
          return -PI - TINY;
      }
    }
    if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY;
    if (ix === 2146435072) {
      if (iy === 2146435072) {
        switch (m) {
          case 0:
            return PI_O_4 + TINY;
          case 1:
            return -PI_O_4 - TINY;
          case 2:
            return 3 * PI_O_4 + TINY;
          default:
            return -3 * PI_O_4 - TINY;
        }
      }
      switch (m) {
        case 0:
          return 0;
        case 1:
          return -0;
        case 2:
          return PI + TINY;
        default:
          return -PI - TINY;
      }
    }
    if (iy === 2146435072) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY;
    const k = iy - ix >> 20;
    let z;
    if (k > 60) z = PI_O_2 + 0.5 * PI_LO;
    else if (hx < 0 && k < -60) z = 0;
    else z = atan(Math.abs(y / x));
    switch (m) {
      case 0:
        return z;
      case 1:
        return -z;
      case 2:
        return PI - (z - PI_LO);
      default:
        return z - PI_LO - PI;
    }
  }
  var PIO2_HI = 1.5707963267948966;
  var PIO2_LO = 6123233995736766e-32;
  var PIO4_HI = 0.7853981633974483;
  var PS0 = 0.16666666666666666;
  var PS1 = -0.3255658186224009;
  var PS2 = 0.20121253213486293;
  var PS3 = -0.04005553450067941;
  var PS4 = 7915349942898145e-19;
  var PS5 = 3479331075960212e-20;
  var QS1 = -2.403394911734414;
  var QS2 = 2.0209457602335057;
  var QS3 = -0.6882839716054533;
  var QS4 = 0.07703815055590194;
  function asin(x) {
    const hx = highWord(x);
    const ix = hx & 2147483647;
    if (ix >= 1072693248) {
      const lx = lowWord(x);
      if ((ix - 1072693248 | lx) === 0) return x * PIO2_HI + x * PIO2_LO;
      return (x - x) / (x - x);
    }
    if (ix < 1071644672) {
      if (ix < 1044381696) return x;
      const t2 = x * x;
      const p2 = t2 * (PS0 + t2 * (PS1 + t2 * (PS2 + t2 * (PS3 + t2 * (PS4 + t2 * PS5)))));
      const q2 = 1 + t2 * (QS1 + t2 * (QS2 + t2 * (QS3 + t2 * QS4)));
      return x + x * (p2 / q2);
    }
    const w0 = 1 - Math.abs(x);
    let t = w0 * 0.5;
    let p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
    let q = 1 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
    const s = Math.sqrt(t);
    if (ix >= 1072640819) {
      const w = p / q;
      t = PIO2_HI - (2 * (s + s * w) - PIO2_LO);
    } else {
      const w = withLow(s, 0);
      const c = (t - w * w) / (s + w);
      const r = p / q;
      p = 2 * s * r - (PIO2_LO - 2 * c);
      q = PIO4_HI - 2 * w;
      t = PIO4_HI - (p - q);
    }
    return hx > 0 ? t : -t;
  }
  function acos(x) {
    const hx = highWord(x);
    const ix = hx & 2147483647;
    if (ix >= 1072693248) {
      const lx = lowWord(x);
      if ((ix - 1072693248 | lx) === 0) return hx > 0 ? 0 : PI + 2 * PIO2_LO;
      return (x - x) / (x - x);
    }
    if (ix < 1071644672) {
      if (ix <= 1012924416) return PIO2_HI + PIO2_LO;
      const z2 = x * x;
      const p2 = z2 * (PS0 + z2 * (PS1 + z2 * (PS2 + z2 * (PS3 + z2 * (PS4 + z2 * PS5)))));
      const q2 = 1 + z2 * (QS1 + z2 * (QS2 + z2 * (QS3 + z2 * QS4)));
      const r2 = p2 / q2;
      return PIO2_HI - (x - (PIO2_LO - x * r2));
    }
    if (hx < 0) {
      const z2 = (1 + x) * 0.5;
      const p2 = z2 * (PS0 + z2 * (PS1 + z2 * (PS2 + z2 * (PS3 + z2 * (PS4 + z2 * PS5)))));
      const q2 = 1 + z2 * (QS1 + z2 * (QS2 + z2 * (QS3 + z2 * QS4)));
      const s2 = Math.sqrt(z2);
      const r2 = p2 / q2;
      const w2 = r2 * s2 - PIO2_LO;
      return PI - 2 * (s2 + w2);
    }
    const z = (1 - x) * 0.5;
    const s = Math.sqrt(z);
    const df = withLow(s, 0);
    const c = (z - df * df) / (s + df);
    const p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
    const q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
    const r = p / q;
    const w = r * s + c;
    return 2 * (df + w);
  }
  var HALF = [0.5, -0.5];
  var O_THRESHOLD = 709.782712893384;
  var U_THRESHOLD = -745.1332191019411;
  var LN2HI = [0.6931471803691238, -0.6931471803691238];
  var LN2LO = [19082149292705877e-26, -19082149292705877e-26];
  var INVLN2 = 1.4426950408889634;
  var P1 = 0.16666666666666602;
  var P2 = -0.0027777777777015593;
  var P3 = 6613756321437934e-20;
  var P4 = -16533902205465252e-22;
  var P5 = 41381367970572385e-24;
  var TWOM1000 = 9332636185032189e-317;
  function exp(x) {
    let hx = highWord(x);
    const xsb = hx >>> 31 & 1;
    hx &= 2147483647;
    let hi = 0;
    let lo = 0;
    let k = 0;
    if (hx >= 1082535490) {
      if (hx >= 2146435072) {
        const lx = lowWord(x);
        if ((hx & 1048575 | lx) !== 0) return x + x;
        return xsb === 0 ? x : 0;
      }
      if (x > O_THRESHOLD) return Infinity;
      if (x < U_THRESHOLD) return 0;
    }
    if (hx > 1071001154) {
      if (hx < 1072734898) {
        hi = x - LN2HI[xsb];
        lo = LN2LO[xsb];
        k = 1 - xsb - xsb;
      } else {
        k = INVLN2 * x + HALF[xsb] | 0;
        const t2 = k;
        hi = x - t2 * LN2HI[0];
        lo = t2 * LN2LO[0];
      }
      x = hi - lo;
    } else if (hx < 1043333120) {
      return 1 + x;
    }
    const t = x * x;
    const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if (k === 0) return 1 - (x * c / (c - 2) - x);
    const y = 1 - (lo - x * c / (2 - c) - hi);
    if (k >= -1021) return withHigh(y, highWord(y) + (k << 20));
    return withHigh(y, highWord(y) + (k + 1e3 << 20)) * TWOM1000;
  }
  var LN2_HI = 0.6931471803691238;
  var LN2_LO = 19082149292705877e-26;
  var TWO54 = 18014398509481984;
  var LG1 = 0.6666666666666735;
  var LG2 = 0.3999999999940942;
  var LG3 = 0.2857142874366239;
  var LG4 = 0.22222198432149784;
  var LG5 = 0.1818357216161805;
  var LG6 = 0.15313837699209373;
  var LG7 = 0.14798198605116586;
  function log(x) {
    let hx = highWord(x);
    const lx = lowWord(x);
    let k = 0;
    if (hx < 1048576) {
      if ((hx & 2147483647 | lx) === 0) return -Infinity;
      if (hx < 0) return NaN;
      k -= 54;
      x *= TWO54;
      hx = highWord(x);
    }
    if (hx >= 2146435072) return x + x;
    k += (hx >> 20) - 1023;
    hx &= 1048575;
    let i = hx + 614244 & 1048576;
    x = withHigh(x, hx | i ^ 1072693248);
    k += i >> 20;
    const f = x - 1;
    if ((1048575 & 2 + hx) < 3) {
      if (f === 0) {
        if (k === 0) return 0;
        const dk3 = k;
        return dk3 * LN2_HI + dk3 * LN2_LO;
      }
      const R2 = f * f * (0.5 - 0.3333333333333333 * f);
      if (k === 0) return f - R2;
      const dk2 = k;
      return dk2 * LN2_HI - (R2 - dk2 * LN2_LO - f);
    }
    const s = f / (2 + f);
    const dk = k;
    const z = s * s;
    i = hx - 398458;
    const w = z * z;
    const j = 440401 - hx;
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
  function pow2(y) {
    return exp(y * 0.6931471805599453);
  }
  return __toCommonJS(dmath_exports);
})();
