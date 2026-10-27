// Checks the portable math functions against this engine's Math: exact matches and worst error in ulps.
import * as D from '../src/engine/dmath.ts';

function ulps(a: number, b: number): number {
  if (Object.is(a, b)) return 0;
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  const buf = new Float64Array([a, b]);
  const i = new BigInt64Array(buf.buffer);
  const d = i[0] - i[1];
  return Number(d < 0n ? -d : d);
}

const cases: [string, (x: number) => number, (x: number) => number, (u: number) => number][] = [
  ['sin', D.sin, Math.sin, (u) => (u - 0.5) * 2000],
  ['sin-big', D.sin, Math.sin, (u) => (u - 0.5) * 1e22],
  ['cos', D.cos, Math.cos, (u) => (u - 0.5) * 2000],
  ['tan', D.tan, Math.tan, (u) => (u - 0.5) * 2000],
  ['asin', D.asin, Math.asin, (u) => u * 2 - 1],
  ['acos', D.acos, Math.acos, (u) => u * 2 - 1],
  ['atan', D.atan, Math.atan, (u) => (u - 0.5) * 200],
  ['atan2', (x) => D.atan2(x, 0.37), (x) => Math.atan2(x, 0.37), (u) => (u - 0.5) * 200],
  ['atan2n', (x) => D.atan2(0.5, x), (x) => Math.atan2(0.5, x), (u) => (u - 0.5) * 20],
  ['exp', D.exp, Math.exp, (u) => (u - 0.5) * 1400],
  ['log', D.log, Math.log, (u) => u * 1e6],
  ['log-small', D.log, Math.log, (u) => u * 2],
];
let s = 99;
for (const [name, mine, ref, gen] of cases) {
  let exact = 0;
  let worst = 0;
  let worstX = 0;
  const n = 300000;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const x = gen(s / 4294967296);
    const d = ulps(mine(x), ref(x));
    if (d === 0) exact++;
    if (d > worst) {
      worst = d;
      worstX = x;
    }
  }
  console.log(`${name.padEnd(9)} exact ${((exact / n) * 100).toFixed(2)}%  worst ${worst} ulp at ${worstX}`);
}
for (const v of [0, -0, 1, -1, Infinity, -Infinity, NaN, 1e-310, Math.PI / 2, 1e300]) {
  const r = [D.sin(v), D.cos(v), D.tan(v), D.atan(v), D.exp(v), D.log(v)];
  const m = [Math.sin(v), Math.cos(v), Math.tan(v), Math.atan(v), Math.exp(v), Math.log(v)];
  const bad = r.map((x, i) => (ulps(x, m[i]) > 1 ? i : -1)).filter((i) => i >= 0);
  if (bad.length) console.log('special', v, 'differs in', bad.map((i) => ['sin', 'cos', 'tan', 'atan', 'exp', 'log'][i]).join(','), r, m);
}
