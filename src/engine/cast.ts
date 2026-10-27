// Value casting and operator semantics of the source project's runtime.
// Generated game code calls these helpers for every dynamically typed operation.

import * as dm from './dmath.ts';
import { COMPILED } from './defs.ts';

export type Value = string | number | boolean;

export function toNumber(v: Value | undefined | null): number {
  if (typeof v === 'number') return Number.isNaN(v) ? 0 : v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

export function toBoolean(v: Value | undefined | null): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    return !(v === '' || v === '0' || v.toLowerCase() === 'false');
  }
  return Boolean(v);
}

export function toStr(v: Value | undefined | null): string {
  return String(v);
}

function isWhiteSpace(v: Value | undefined | null): boolean {
  return v === null || (typeof v === 'string' && v.trim().length === 0);
}

export function compare(v1: Value | undefined, v2: Value | undefined): number {
  if (typeof v1 === 'number' && typeof v2 === 'number' && v1 === v1 && v2 === v2) return v1 === v2 ? 0 : v1 - v2;
  let n1 = Number(v1);
  let n2 = Number(v2);
  if (n1 === 0 && isWhiteSpace(v1)) n1 = NaN;
  else if (n2 === 0 && isWhiteSpace(v2)) n2 = NaN;
  if (Number.isNaN(n1) || Number.isNaN(n2)) {
    const s1 = String(v1).toLowerCase();
    const s2 = String(v2).toLowerCase();
    if (s1 < s2) return -1;
    if (s1 > s2) return 1;
    return 0;
  }
  if ((n1 === Infinity && n2 === Infinity) || (n1 === -Infinity && n2 === -Infinity)) return 0;
  return n1 - n2;
}

export function eq(a: Value | undefined, b: Value | undefined): boolean {
  return a === b || compare(a, b) === 0;
}
export function lt(a: Value | undefined, b: Value | undefined): boolean {
  return compare(a, b) < 0;
}
export function gt(a: Value | undefined, b: Value | undefined): boolean {
  return compare(a, b) > 0;
}

export function isInt(v: Value | undefined): boolean {
  // The compiling runtime counts Infinity and numbers of 1e21 or more as integers, and the interpreter does not.
  if (typeof v === 'number') return Number.isNaN(v) ? true : COMPILED ? v === Math.floor(v) : v === parseInt(String(v), 10);
  if (typeof v === 'boolean') return true;
  if (typeof v === 'string') return v.indexOf('.') < 0;
  return false;
}

export function add(a: Value, b: Value): number {
  return toNumber(a) + toNumber(b);
}
export function sub(a: Value, b: Value): number {
  return toNumber(a) - toNumber(b);
}
export function mul(a: Value, b: Value): number {
  return toNumber(a) * toNumber(b);
}
export function div(a: Value, b: Value): number {
  return toNumber(a) / toNumber(b);
}
export function mod(a: Value, b: Value): number {
  const n = toNumber(a);
  const m = toNumber(b);
  let r = n % m;
  if (r / m < 0) r += m;
  return r;
}
export function round(a: Value): number {
  return Math.round(toNumber(a));
}

export function and(a: Value | undefined, b: Value | undefined): boolean {
  return toBoolean(a) && toBoolean(b);
}
export function or(a: Value | undefined, b: Value | undefined): boolean {
  return toBoolean(a) || toBoolean(b);
}
export function not(a: Value | undefined): boolean {
  return !toBoolean(a);
}

export function join(a: Value | undefined, b: Value | undefined): string {
  return String(a) + String(b);
}

export function letterOf(index: Value, s: Value): string {
  const i = toNumber(index) - 1;
  const str = String(s);
  if (i < 0 || i >= str.length) return '';
  return str.charAt(i);
}

export function length(s: Value): number {
  return String(s).length;
}

export function contains(a: Value, b: Value): boolean {
  return String(a).toLowerCase().includes(String(b).toLowerCase());
}

export function mathop(op: string, v: Value): number {
  const n = toNumber(v);
  switch (op) {
    case 'abs': return Math.abs(n);
    case 'floor': return Math.floor(n);
    case 'ceiling': return Math.ceil(n);
    case 'sqrt': return Math.sqrt(n);
    case 'sin': return round10(dm.sin((Math.PI * n) / 180));
    case 'cos': return round10(dm.cos((Math.PI * n) / 180));
    case 'tan': return tan(n);
    case 'asin': return (dm.asin(n) * 180) / Math.PI;
    case 'acos': return (dm.acos(n) * 180) / Math.PI;
    case 'atan': return (dm.atan(n) * 180) / Math.PI;
    case 'ln': return dm.log(n);
    case 'log': return dm.log(n) / Math.LN10;
    case 'e ^': return dm.exp(n);
    case '10 ^': return Math.pow(10, n);
  }
  return 0;
}

/** Rounds to 10 decimals, as the original's trigonometry does: the compiled code with Math.round, the interpreter with toFixed. */
const round10 = COMPILED ? (x: number) => Math.round(x * 1e10) / 1e10 : (x: number) => parseFloat(x.toFixed(10));

function tan(angle: number): number {
  switch (angle % 360) {
    case -270:
    case 90:
      return Infinity;
    case -90:
    case 270:
      return -Infinity;
  }
  // The interpreter reduces the angle mod 360 before it takes the tangent, and the compiled code does not.
  return round10(dm.tan((Math.PI * (COMPILED ? angle : angle % 360)) / 180));
}

export const sin = (v: Value): number => round10(dm.sin((Math.PI * toNumber(v)) / 180));
export const cos = (v: Value): number => round10(dm.cos((Math.PI * toNumber(v)) / 180));
export const abs = (v: Value): number => Math.abs(toNumber(v));
export const floor = (v: Value): number => Math.floor(toNumber(v));
export const ceil = (v: Value): number => Math.ceil(toNumber(v));
export const sqrt = (v: Value): number => Math.sqrt(toNumber(v));

// ------------------------------------------------------------------ lists

const LIST_INVALID = -1;
const LIST_ALL = -2;
const LIST_ITEM_LIMIT = 200000;

/** Resolves a list index argument; `rand` supplies the random source for "random"/"any". */
function toListIndex(index: Value, len: number, acceptAll: boolean, rand: () => number): number {
  if (typeof index !== 'number') {
    if (index === 'all') return acceptAll ? LIST_ALL : LIST_INVALID;
    if (index === 'last') return len > 0 ? len : LIST_INVALID;
    if (index === 'random' || index === 'any') return len > 0 ? 1 + Math.floor(rand() * len) : LIST_INVALID;
  }
  const i = Math.floor(toNumber(index));
  if (i < 1 || i > len) return LIST_INVALID;
  return i;
}

let listRandom: () => number = () => {
  throw new Error('list random source not installed');
};
export function setListRandom(fn: () => number): void {
  listRandom = fn;
}

/** Fast path for the common case of a numeric or numeric-string index. */
export function item(list: Value[], index: Value): Value {
  if (typeof index === 'number') {
    const i = Math.floor(index);
    return i >= 1 && i <= list.length ? list[i - 1] : '';
  }
  const i = toListIndex(index, list.length, false, listRandom);
  return i === LIST_INVALID ? '' : list[i - 1];
}

export function replaceItem(list: Value[], index: Value, v: Value): void {
  const i = toListIndex(index, list.length, false, listRandom);
  if (i === LIST_INVALID) return;
  list[i - 1] = v;
}

export function addTo(list: Value[], v: Value): void {
  if (list.length < LIST_ITEM_LIMIT) list.push(v);
}

export function deleteOf(list: Value[], index: Value): void {
  const i = toListIndex(index, list.length, true, listRandom);
  if (i === LIST_INVALID) return;
  if (i === LIST_ALL) {
    list.length = 0;
    return;
  }
  list.splice(i - 1, 1);
}

export function deleteAll(list: Value[]): void {
  list.length = 0;
}

export function insertAt(list: Value[], index: Value, v: Value): void {
  const i = toListIndex(index, list.length + 1, false, listRandom);
  if (i === LIST_INVALID) return;
  if (i > LIST_ITEM_LIMIT) return;
  list.splice(i - 1, 0, v);
  if (list.length > LIST_ITEM_LIMIT) list.pop();
}

/**
 * The first index whose item equals `v` by `compare`, or -1. The needle's number is worked out once. A needle that
 * is not a number compares as lowercase text with every item, as `compare` would.
 */
function findItem(list: Value[], v: Value): number {
  const n2 = Number(v);
  if (Number.isNaN(n2) || (n2 === 0 && isWhiteSpace(v))) {
    const s2 = String(v).toLowerCase();
    // Lowercasing keeps the length of text that matches ASCII text, so for an ASCII needle a length mismatch rules a match out.
    const ascii = !/[^\x00-\x7f]/.test(s2);
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item === v) return i;
      const t = typeof item === 'string' ? item : String(item);
      if (ascii && t.length !== s2.length) continue;
      if (t.toLowerCase() === s2) return i;
    }
    return -1;
  }
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item === v || compare(item, v) === 0) return i;
  }
  return -1;
}

export function indexOf(list: Value[], v: Value): number {
  return findItem(list, v) + 1;
}

export function listContains(list: Value[], v: Value): boolean {
  return list.indexOf(v) >= 0 || findItem(list, v) >= 0;
}

export function listContents(list: Value[]): string {
  let allSingle = true;
  for (const x of list) {
    if (!(typeof x === 'string' && x.length === 1)) {
      allSingle = false;
      break;
    }
  }
  return allSingle ? list.join('') : list.join(' ');
}

// ------------------------------------------------------------------ math helpers shared with the runtime

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function wrapClamp(n: number, min: number, max: number): number {
  const range = (max - min) + 1;
  return n - (Math.floor((n - min) / range) * range);
}

/**
 * The project's letter-by-letter split loop in one call. Words end at each letter equal to `sep`
 * (with `=` semantics); the text after the last separator is returned as `word` and is not added,
 * and `next` is the loop counter's final value ("1" when the input is empty).
 */
export function splitWords(input: Value, sep: Value, list: Value[]): { word: string; next: Value } {
  list.length = 0;
  const s = String(input);
  let word = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (compare(ch, sep) !== 0) word += ch;
    else {
      if (list.length < LIST_ITEM_LIMIT) list.push(word);
      word = '';
    }
  }
  return { word, next: s.length === 0 ? '1' : s.length + 1 };
}

/** Short names used by generated code. */
export const num = toNumber;
export const bool = toBoolean;
