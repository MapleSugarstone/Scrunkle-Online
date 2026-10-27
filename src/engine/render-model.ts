// Renderer geometry that affects simulation state: bounds, fencing, stamp clipping and touching.
// It works from costume metadata only, so it runs the same in a browser and in Node.
import { STAGE_X, STAGE_Y, type SkinDef } from './defs.ts';
import { cos, sin } from './dmath.ts';
import { unpackMask, type PackedMask, type Silhouette } from './masks.ts';
import type { Target } from './target.ts';

const FENCE_WIDTH = 15;
const EMPTY: number[] = [];
const X_RIGHT = STAGE_X;
const Y_TOP = STAGE_Y;

export interface Rect {
  left: number;
  right: number;
  bottom: number;
  top: number;
}


/** Affine model transform of a drawable, as the renderer builds it. */
interface Model {
  m0: number;
  m1: number;
  m4: number;
  m5: number;
  m12: number;
  m13: number;
}

export class RenderModel {
  skins: SkinDef[];
  /** Masks by skin, unpacked the first time a test needs them, because most costumes are never tested. */
  private silhouettes: (Silhouette | undefined)[] = [];
  packed: (PackedMask | undefined)[] = [];

  constructor(skins: SkinDef[]) {
    this.skins = skins;
  }

  silhouette(skin: number): Silhouette | undefined {
    const hit = this.silhouettes[skin];
    if (hit) return hit;
    const p = this.packed[skin];
    if (!p) return undefined;
    const s = unpackMask(p);
    this.silhouettes[skin] = s;
    return s;
  }

  skinOf(t: Target): SkinDef {
    return this.skins[t.sprite.costumes[t.currentCostume].skin];
  }

  /**
   * Model transform with the original renderer's 32-bit float storage reproduced at every step,
   * since bounds and fencing round differently otherwise.
   */
  model(t: Target): Model {
    const f = Math.fround;
    const skin = this.skinOf(t);
    const dir = t.renderedDirection();
    const sx = f(t.renderedScaleX());
    const sy = f(t.size);
    const rotation = ((270 - dir) * Math.PI) / 180;
    const cd = cos(rotation);
    const sd = sin(rotation);
    const r00 = f(cd);
    const r01 = f(sd);
    const r10 = f(-sd);
    const r11 = f(cd);
    const rcx = f(skin.rcx);
    const rcy = f(skin.rcy);
    const adj0 = f(((rcx - skin.w / 2) * sx) / 100);
    const adj1 = f((((rcy - skin.h / 2) * sy) / 100) * -1);
    const scale0 = f((skin.w * sx) / 100);
    const scale1 = f((skin.h * sy) / 100);
    const px = f(t.drawX);
    const py = f(t.drawY);
    return {
      m0: f(scale0 * r00),
      m1: f(scale0 * r01),
      m4: f(scale1 * r10),
      m5: f(scale1 * r11),
      m12: f(r00 * adj0 + r10 * adj1 + px),
      m13: f(r01 * adj0 + r11 * adj1 + py),
    };
  }

  aabb(t: Target): Rect {
    const m = this.model(t);
    const x = Math.abs(0.5 * m.m0) + Math.abs(0.5 * m.m4);
    const y = Math.abs(0.5 * m.m1) + Math.abs(0.5 * m.m5);
    return { left: -x + m.m12, right: x + m.m12, top: y + m.m13, bottom: -y + m.m13 };
  }

  /** Keeps at least a small part of the sprite on stage, like the original renderer. */
  fencedPosition(t: Target, x: number, y: number): [number, number] {
    const px = t.drawX;
    const py = t.drawY;
    const dx = x - px;
    const dy = y - py;
    const aabb = this.aabb(t);
    const inset = Math.floor(Math.min(Math.abs(aabb.left - aabb.right), Math.abs(aabb.top - aabb.bottom)) / 2);
    const sx = X_RIGHT - Math.min(FENCE_WIDTH, inset);
    if (aabb.right + dx < -sx) x = Math.ceil(px - (sx + aabb.right));
    else if (aabb.left + dx > sx) x = Math.floor(px + (sx - aabb.left));
    const sy = Y_TOP - Math.min(FENCE_WIDTH, inset);
    if (aabb.top + dy < -sy) y = Math.ceil(py - (sy + aabb.top));
    else if (aabb.bottom + dy > sy) y = Math.floor(py + (sy - aabb.bottom));
    return [x, y];
  }

  /**
   * Drawn bounds, as the original's getBounds gives them: the box around the costume's convex hull after
   * the model transform, or the costume box when the sprite is hidden or has no opaque pixels.
   * Like the original, it leaves the hull computed for later touching tests.
   */
  bounds(t: Target): Rect {
    const pts = t.visible ? this.hullPoints(t) : EMPTY;
    if (pts.length === 0) return this.aabb(t);
    t.hullClean = true;
    return this.hullBounds(t, pts);
  }

  /** Computes the hull as reading the bounds would, for callers that do not use the bounds. */
  computeHull(t: Target): void {
    if (t.visible && this.hullPoints(t).length > 0) t.hullClean = true;
  }

  /** The original's getFastBounds: the hull's box while the renderer holds the hull, else the costume box. */
  fastBounds(t: Target): Rect {
    return t.hullClean ? this.hullBounds(t, this.hullPoints(t)) : this.aabb(t);
  }

  private hullBounds(t: Target, pts: number[]): Rect {
    const skin = this.skinOf(t);
    const m = this.model(t);
    const w = skin.w, h = skin.h;
    const f = Math.fround;
    const out: Rect = { left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity };
    for (let i = 0; i < pts.length; i += 2) {
      // Hull point to texture space, then through the model matrix; each result is stored as float32.
      const u = f(0.5 + -pts[i] / w - 1 / w / 2);
      const v = f(pts[i + 1] / h - 0.5 + 1 / h / 2);
      const sx = f(u * m.m0 + v * m.m4 + m.m12);
      const sy = f(u * m.m1 + v * m.m5 + m.m13);
      if (sx < out.left) out.left = sx;
      if (sx > out.right) out.right = sx;
      if (sy < out.bottom) out.bottom = sy;
      if (sy > out.top) out.top = sy;
    }
    return out;
  }

  /**
   * Hull candidates in skin units as flat x, y pairs: each pixel row's outermost opaque points, scanned
   * the way the original does. The box around them equals the box around their convex hull.
   */
  private hullPoints(t: Target): number[] {
    const skinIndex = t.sprite.costumes[t.currentCostume].skin;
    const fx = t.effects;
    const key = `${skinIndex}|${fx.mosaic}|${fx.pixelate}|${fx.whirl}|${fx.fisheye}`;
    const hit = this.hullCache.get(key);
    if (hit) return hit;
    const skin = this.skins[skinIndex];
    const sil = this.silhouette(skinIndex);
    const w = skin.w, h = skin.h;
    const pts: number[] = [];
    if (sil && w !== 0 && h !== 0) {
      const p = new Float32Array(2);
      for (let y = 0; y < h; y++) {
        p[1] = y / h;
        let x = 0;
        for (; x < w; x++) {
          p[0] = x / w;
          if (this.linearAt(t, sil, p)) break;
        }
        if (x >= w) continue;
        pts.push(x, y);
        // The right scan steps down from w - 1, which is fractional for most vector costumes.
        let right = x;
        for (let r = w - 1; r >= 0; r--) {
          p[0] = r / w;
          if (this.linearAt(t, sil, p)) {
            right = r;
            break;
          }
        }
        pts.push(right, y);
      }
    }
    if (this.hullCache.size > 4096) this.hullCache.clear();
    this.hullCache.set(key, pts);
    return pts;
  }

  private hullCache = new Map<string, number[]>();

  /** The silhouette's linear touching test at a texture-space point, after the target's shape effects. */
  private linearAt(t: Target, sil: Silhouette, p: Float32Array): boolean {
    const q = new Float32Array([p[0], p[1]]);
    const fx = t.effects;
    if (fx.mosaic || fx.pixelate || fx.whirl || fx.fisheye) this.effectTransform(t, q);
    const px = Math.floor(q[0] * (sil.w - 1));
    const py = Math.floor(q[1] * (sil.h - 1));
    return alphaAt(sil, px, py) || alphaAt(sil, px + 1, py) || alphaAt(sil, px, py + 1) || alphaAt(sil, px + 1, py + 1);
  }

  /** Position (x, y) moved just enough to keep the drawn bounds on stage, as the original's keepInFence does. */
  keepInFence(t: Target, x: number, y: number): [number, number] {
    const b = this.bounds(t);
    const dxT = x - t.x, dyT = y - t.y;
    const left = b.left + dxT, right = b.right + dxT, top = b.top + dyT, bottom = b.bottom + dyT;
    let dx = 0, dy = 0;
    if (left < -X_RIGHT) dx += -X_RIGHT - left;
    if (right > X_RIGHT) dx += X_RIGHT - right;
    if (top > Y_TOP) dy += Y_TOP - top;
    if (bottom < -Y_TOP) dy += -Y_TOP - bottom;
    return [x + dx, y + dy];
  }

  /** Stage-clamped, integer-snapped bounds; null when empty. Stamps are clipped to these. */
  touchingBounds(t: Target): Rect | null {
    const b = this.fastBounds(t);
    clampRect(b, -X_RIGHT, X_RIGHT, -Y_TOP, Y_TOP);
    snapToInt(b);
    if (Math.abs(b.left - b.right) === 0 || Math.abs(b.top - b.bottom) === 0) return null;
    return b;
  }

  // ---------------------------------------------------------------- touching

  /**
   * What one target's point tests need: its silhouette and inverse model matrix, as float32. A touching test checks
   * many points against the same targets, so this is worked out once per target per test.
   */
  private tester(t: Target): PointTester | null {
    const sil = this.silhouette(t.sprite.costumes[t.currentCostume].skin);
    if (!sil) return null;
    const m = this.model(t);
    const M = new Float32Array(16);
    M[0] = m.m0;
    M[1] = m.m1;
    M[4] = m.m4;
    M[5] = m.m5;
    M[10] = 1;
    M[12] = m.m12;
    M[13] = m.m13;
    M[15] = 1;
    const fx = t.effects;
    const anyEffect = !!(fx.color || fx.fisheye || fx.whirl || fx.pixelate || fx.mosaic || fx.brightness || fx.ghost);
    return { t, sil, inv: inverse4(M), anyEffect, nearest: this.useNearest(t) };
  }

  private lp = new Float32Array(2);

  /** Stage point to skin texture coordinates and the silhouette test there, with the renderer's float32 storage. */
  private testPoint(p: PointTester, x: number, y: number): boolean {
    const inv = p.inv, lp = this.lp, sil = p.sil;
    const d = x * inv[3] + y * inv[7] + inv[15];
    lp[0] = 0.5 - (x * inv[0] + y * inv[4] + inv[12]) / d;
    lp[1] = (x * inv[1] + y * inv[5] + inv[13]) / d + 0.5;
    if (Math.abs(lp[0]) < 1e-6) lp[0] = 0;
    if (Math.abs(lp[1]) < 1e-6) lp[1] = 0;
    if (p.anyEffect && lp[0] >= 0 && lp[0] < 1 && lp[1] >= 0 && lp[1] < 1) this.effectTransform(p.t, lp);
    const px = Math.floor(lp[0] * (sil.w - 1));
    const py = Math.floor(lp[1] * (sil.h - 1));
    if (p.nearest) return alphaAt(sil, px, py);
    return alphaAt(sil, px, py) || alphaAt(sil, px + 1, py) || alphaAt(sil, px, py + 1) || alphaAt(sil, px + 1, py + 1);
  }

  /** The original's effect transform: mosaic, pixelate, whirl, then fisheye, each stored as float32. */
  private effectTransform(t: Target, dst: Float32Array): void {
    if (t.effects.mosaic) {
      const m = Math.max(1, Math.min(Math.round((Math.abs(t.effects.mosaic) + 10) / 10), 512));
      dst[0] = (m * dst[0]) % 1;
      dst[1] = (m * dst[1]) % 1;
    }
    if (t.effects.pixelate) {
      const skin = this.skinOf(t);
      const p = Math.abs(t.effects.pixelate) / 10;
      const tx = skin.w / p;
      const ty = skin.h / p;
      dst[0] = (Math.floor(dst[0] * tx) + 0.5) / tx;
      dst[1] = (Math.floor(dst[1] * ty) + 0.5) / ty;
    }
    if (t.effects.whirl) {
      const whirl = (-t.effects.whirl * Math.PI) / 180;
      const ox = dst[0] - 0.5;
      const oy = dst[1] - 0.5;
      const mag = Math.sqrt(ox * ox + oy * oy);
      const factor = Math.max(1.0 - mag / 0.5, 0.0);
      const actual = whirl * factor * factor;
      const s = sin(actual);
      const c = cos(actual);
      dst[0] = c * ox + s * oy + 0.5;
      dst[1] = -s * ox + c * oy + 0.5;
    }
    if (t.effects.fisheye) {
      const k = Math.max(0, (t.effects.fisheye + 100) / 100);
      const vx = (dst[0] - 0.5) / 0.5;
      const vy = (dst[1] - 0.5) / 0.5;
      const len = Math.sqrt(vx * vx + vy * vy);
      const r = Math.pow(Math.min(len, 1), k) * Math.max(1, len);
      dst[0] = 0.5 + r * (vx / len) * 0.5;
      dst[1] = 0.5 + r * (vy / len) * 0.5;
    }
  }

  private useNearest(t: Target): boolean {
    const skin = this.skinOf(t);
    if (skin.kind === 'bitmap') return true;
    if (t.effects.whirl !== 0 || t.effects.pixelate !== 0 || t.effects.fisheye !== 0 || t.effects.mosaic !== 0) return false;
    if (t.renderedDirection() % 90 !== 0) return false;
    const sx = Math.abs(Math.fround(t.renderedScaleX()));
    const sy = Math.abs(Math.fround(t.size));
    return sx > 99 && sx < 101 && sy > 99 && sy < 101;
  }

  /** Touch test against a single stage point; visibility is not checked, as in the original. */
  touchingPoint(t: Target, x: number, y: number): boolean {
    const p = this.tester(t);
    return p ? this.testPoint(p, x, y) : false;
  }

  /** Pixel-level overlap between `t` and any visible candidate. */
  touchingTargets(t: Target, candidates: Target[]): boolean {
    const self = this.touchingBounds(t);
    if (!self) return false;
    const hits: Rect[] = [];
    const hitTargets: Target[] = [];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i];
      if (c === t || !c.visible) continue;
      const cb = this.fastBounds(c);
      snapToInt(cb);
      if (self.left <= cb.right && cb.left <= self.right && self.top >= cb.bottom && cb.top >= self.bottom) {
        hits.push({
          left: Math.max(self.left, cb.left),
          right: Math.min(self.right, cb.right),
          top: Math.min(self.top, cb.top),
          bottom: Math.max(self.bottom, cb.bottom),
        });
        hitTargets.push(c);
      }
    }
    if (hits.length === 0 || !t.visible) return false;
    const b = hits.reduce((m, r) => ({
      left: Math.min(m.left, r.left),
      right: Math.max(m.right, r.right),
      top: Math.max(m.top, r.top),
      bottom: Math.min(m.bottom, r.bottom),
    }));
    const self2 = this.tester(t);
    if (!self2) return false;
    const others = hitTargets.map((c) => this.tester(c));
    for (let x = b.left; x <= b.right; x++) {
      for (let y = b.bottom; y <= b.top; y++) {
        if (this.testPoint(self2, x, y)) {
          for (const o of others) {
            if (o && this.testPoint(o, x, y)) return true;
          }
        }
      }
    }
    return false;
  }
}

interface PointTester {
  t: Target;
  sil: Silhouette;
  inv: Float32Array;
  anyEffect: boolean;
  nearest: boolean;
}

/** General 4x4 inverse in the same operation order as the renderer's matrix library, stored as float32. */
function inverse4(m: Float32Array): Float32Array {
  const dst = new Float32Array(16);
  const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3];
  const m10 = m[4], m11 = m[5], m12 = m[6], m13 = m[7];
  const m20 = m[8], m21 = m[9], m22 = m[10], m23 = m[11];
  const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];
  const tmp0 = m22 * m33, tmp1 = m32 * m23, tmp2 = m12 * m33, tmp3 = m32 * m13;
  const tmp4 = m12 * m23, tmp5 = m22 * m13, tmp6 = m02 * m33, tmp7 = m32 * m03;
  const tmp8 = m02 * m23, tmp9 = m22 * m03, tmp10 = m02 * m13, tmp11 = m12 * m03;
  const tmp12 = m20 * m31, tmp13 = m30 * m21, tmp14 = m10 * m31, tmp15 = m30 * m11;
  const tmp16 = m10 * m21, tmp17 = m20 * m11, tmp18 = m00 * m31, tmp19 = m30 * m01;
  const tmp20 = m00 * m21, tmp21 = m20 * m01, tmp22 = m00 * m11, tmp23 = m10 * m01;
  const t0 = (tmp0 * m11 + tmp3 * m21 + tmp4 * m31) - (tmp1 * m11 + tmp2 * m21 + tmp5 * m31);
  const t1 = (tmp1 * m01 + tmp6 * m21 + tmp9 * m31) - (tmp0 * m01 + tmp7 * m21 + tmp8 * m31);
  const t2 = (tmp2 * m01 + tmp7 * m11 + tmp10 * m31) - (tmp3 * m01 + tmp6 * m11 + tmp11 * m31);
  const t3 = (tmp5 * m01 + tmp8 * m11 + tmp11 * m21) - (tmp4 * m01 + tmp9 * m11 + tmp10 * m21);
  const d = 1.0 / (m00 * t0 + m10 * t1 + m20 * t2 + m30 * t3);
  dst[0] = d * t0;
  dst[1] = d * t1;
  dst[2] = d * t2;
  dst[3] = d * t3;
  dst[4] = d * ((tmp1 * m10 + tmp2 * m20 + tmp5 * m30) - (tmp0 * m10 + tmp3 * m20 + tmp4 * m30));
  dst[5] = d * ((tmp0 * m00 + tmp7 * m20 + tmp8 * m30) - (tmp1 * m00 + tmp6 * m20 + tmp9 * m30));
  dst[6] = d * ((tmp3 * m00 + tmp6 * m10 + tmp11 * m30) - (tmp2 * m00 + tmp7 * m10 + tmp10 * m30));
  dst[7] = d * ((tmp4 * m00 + tmp9 * m10 + tmp10 * m20) - (tmp5 * m00 + tmp8 * m10 + tmp11 * m20));
  dst[8] = d * ((tmp12 * m13 + tmp15 * m23 + tmp16 * m33) - (tmp13 * m13 + tmp14 * m23 + tmp17 * m33));
  dst[9] = d * ((tmp13 * m03 + tmp18 * m23 + tmp21 * m33) - (tmp12 * m03 + tmp19 * m23 + tmp20 * m33));
  dst[10] = d * ((tmp14 * m03 + tmp19 * m13 + tmp22 * m33) - (tmp15 * m03 + tmp18 * m13 + tmp23 * m33));
  dst[11] = d * ((tmp17 * m03 + tmp20 * m13 + tmp23 * m23) - (tmp16 * m03 + tmp21 * m13 + tmp22 * m23));
  dst[12] = d * ((tmp14 * m22 + tmp17 * m32 + tmp13 * m12) - (tmp16 * m32 + tmp12 * m12 + tmp15 * m22));
  dst[13] = d * ((tmp20 * m32 + tmp12 * m02 + tmp19 * m22) - (tmp18 * m22 + tmp21 * m32 + tmp13 * m02));
  dst[14] = d * ((tmp18 * m12 + tmp23 * m32 + tmp15 * m02) - (tmp22 * m32 + tmp14 * m02 + tmp19 * m12));
  dst[15] = d * ((tmp22 * m22 + tmp16 * m02 + tmp21 * m12) - (tmp20 * m12 + tmp23 * m22 + tmp17 * m02));
  return dst;
}

function alphaAt(s: Silhouette, x: number, y: number): boolean {
  if (x >= s.w || y >= s.h || x < 0 || y < 0) return false;
  const i = y * s.w + x;
  return ((s.bits[i >> 3] >> (i & 7)) & 1) !== 0;
}

export function clampRect(r: Rect, left: number, right: number, bottom: number, top: number): void {
  r.left = Math.max(r.left, left);
  r.right = Math.min(r.right, right);
  r.bottom = Math.max(r.bottom, bottom);
  r.top = Math.min(r.top, top);
  r.left = Math.min(r.left, right);
  r.right = Math.max(r.right, left);
  r.bottom = Math.min(r.bottom, top);
  r.top = Math.max(r.top, bottom);
}

export function snapToInt(r: Rect): void {
  r.left = Math.floor(r.left);
  r.right = Math.ceil(r.right);
  r.bottom = Math.floor(r.bottom);
  r.top = Math.ceil(r.top);
}
