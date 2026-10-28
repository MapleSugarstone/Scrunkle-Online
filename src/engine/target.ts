import { type Value, toNumber, toStr, isInt, clamp, wrapClamp } from './cast.ts';
import { hsvToRgb, rgbToHsv, hexToRgb, decimalToRgb } from './color.ts';
import { atan2, cos, sin } from './dmath.ts';
import { STAGE_H, STAGE_W, type CostumeDef, type ScriptDef, type SpriteDef, type SoundDef } from './defs.ts';
import type { Runtime } from './runtime.ts';
import type { Thread } from './thread.ts';

export const ROT_ALL = 'all around';
export const ROT_LR = 'left-right';
export const ROT_NONE = "don't rotate";

export const EFFECT_NAMES = ['color', 'fisheye', 'whirl', 'pixelate', 'mosaic', 'brightness', 'ghost'] as const;
export type EffectName = (typeof EFFECT_NAMES)[number];
export type Effects = Record<EffectName, number>;

export function noEffects(): Effects {
  return { color: 0, fisheye: 0, whirl: 0, pixelate: 0, mosaic: 0, brightness: 0, ghost: 0 };
}

export interface PenState {
  penDown: boolean;
  color: number;
  saturation: number;
  brightness: number;
  transparency: number;
  diameter: number;
  c4: [number, number, number, number];
}

export function defaultPen(): PenState {
  return { penDown: false, color: 66.66, saturation: 100, brightness: 100, transparency: 0, diameter: 1, c4: [0, 0, 1, 1] };
}

export interface SoundFx {
  pitch: number;
  pan: number;
}

/** Shared per-sprite data: definitions, lookup tables and the list of live clones. */
export class Sprite {
  def: SpriteDef;
  name: string;
  costumes: CostumeDef[];
  sounds: SoundDef[];
  costumeByName = new Map<string, number>();
  soundByName = new Map<string, number>();
  scripts: ScriptDef[] = [];
  flagScripts: ScriptDef[] = [];
  cloneScripts: ScriptDef[] = [];
  clickScripts: ScriptDef[] = [];
  timerScripts: ScriptDef[] = [];
  keyScripts = new Map<string, ScriptDef[]>();
  broadcastScripts = new Map<string, ScriptDef[]>();
  scriptIndex = new Map<ScriptDef, number>();
  clones: Target[] = [];
  /** The target loaded from the project file; it is never deleted. */
  original!: Target;
  index: number;
  /** Lists no block writes, by property name. They stay frozen, so clones and snapshots can share them. */
  fixedLists: Set<string>;

  constructor(def: SpriteDef, index: number) {
    this.def = def;
    this.index = index;
    this.fixedLists = new Set(def.fixedLists ?? []);
    this.name = def.name;
    this.costumes = def.costumes;
    this.sounds = def.sounds;
    def.costumes.forEach((c, i) => {
      if (!this.costumeByName.has(c.name)) this.costumeByName.set(c.name, i);
    });
    def.sounds.forEach((s, i) => {
      if (!this.soundByName.has(s.name)) this.soundByName.set(s.name, i);
    });
  }

  setScripts(scripts: ScriptDef[]): void {
    this.scripts = scripts;
    scripts.forEach((s, i) => {
      this.scriptIndex.set(s, i);
      if (s.hat === 'flag') this.flagScripts.push(s);
      else if (s.hat === 'clone') this.cloneScripts.push(s);
      else if (s.hat === 'click') this.clickScripts.push(s);
      else if (s.hat === 'timer') this.timerScripts.push(s);
      else if (s.hat === 'key') {
        const list = this.keyScripts.get(s.msg!) ?? [];
        list.push(s);
        this.keyScripts.set(s.msg!, list);
      } else {
        const list = this.broadcastScripts.get(s.msg!) ?? [];
        list.push(s);
        this.broadcastScripts.set(s.msg!, list);
      }
    });
  }
}

/** One sprite instance (the original or a clone) or the stage. */
export class Target {
  rt: Runtime;
  sprite: Sprite;
  id: number;
  isStage: boolean;
  isOriginal: boolean;
  x = 0;
  y = 0;
  direction = 90;
  size = 100;
  currentCostume = 0;
  visible = true;
  rotationStyle = ROT_ALL;
  draggable = false;
  volume = 100;
  effects: Effects = noEffects();
  /**
   * Whether the renderer holds this drawable's convex hull. Touching then tests within the hull's bounds
   * instead of the full costume box. Computing bounds sets it, and a costume, visibility or shape effect update clears it.
   */
  hullClean = false;
  // Generated code types these through per-sprite interfaces.
  v: any;
  l: any;
  pen: PenState | null = null;
  snd: SoundFx | null = null;
  /** Sound indices started with "play until done" and not since replaced by a plain play. */
  waitingSounds = new Set<number>();
  /** The thread currently in the runtime's list for each script of this target, by script index. */
  scriptThreads: (Thread | undefined)[] = [];
  /** Each timer hat's last test result by hat block id. A hat starts its script only when its test turns true. */
  edgeValues = new Map<string, boolean>();

  constructor(rt: Runtime, sprite: Sprite, id: number, isOriginal: boolean) {
    this.rt = rt;
    this.sprite = sprite;
    this.id = id;
    this.isStage = sprite.def.isStage;
    this.isOriginal = isOriginal;
  }

  get name(): string {
    return this.sprite.name;
  }

  // ---------------------------------------------------------------- renderer-facing state

  /**
   * Integer drawable position, as the renderer stores it. It only updates when the new position
   * compares unequal, so a stored -0 survives a move to +0 (the sign shows in stamp records).
   */
  drawX = 0;
  drawY = 0;

  updateDrawPosition(x: number, y: number): void {
    if (this.drawX !== x || this.drawY !== y) {
      this.drawX = Math.round(x);
      this.drawY = Math.round(y);
    }
  }

  renderedDirection(): number {
    return this.rotationStyle === ROT_ALL ? this.direction : 90;
  }

  renderedScaleX(): number {
    if (this.rotationStyle === ROT_LR && this.direction < 0) return -this.size;
    return this.size;
  }

  private visualChange(): void {
    if (!this.visible) return;
    this.rt.requestRedraw();
    // A shown speech bubble repositions on every visual change, which computes the hull.
    if (this.rt.bubbles[this.id] !== undefined) this.rt.render.computeHull(this);
  }

  // ---------------------------------------------------------------- motion

  setXY(x: number, y: number): void {
    if (this.isStage) return;
    const oldX = this.x;
    const oldY = this.y;
    const [fx, fy] = this.rt.render.fencedPosition(this, x, y);
    this.x = fx;
    this.y = fy;
    this.updateDrawPosition(fx, fy);
    this.visualChange();
    if (this.pen && this.pen.penDown) {
      this.rt.penLine(this.pen, oldX, oldY, this.x, this.y);
    }
  }

  gotoXY(x: Value, y: Value): void {
    this.setXY(toNumber(x), toNumber(y));
  }
  setX(x: Value): void {
    this.setXY(toNumber(x), this.y);
  }
  setY(y: Value): void {
    this.setXY(this.x, toNumber(y));
  }
  changeX(dx: Value): void {
    this.setXY(this.x + toNumber(dx), this.y);
  }
  changeY(dy: Value): void {
    this.setXY(this.x, this.y + toNumber(dy));
  }

  setDirection(d: number): void {
    if (this.isStage) return;
    if (!Number.isFinite(d)) return;
    this.direction = wrapClamp(d, -179, 180);
    this.visualChange();
  }
  pointInDirection(d: Value): void {
    this.setDirection(toNumber(d));
  }
  turnRight(d: Value): void {
    this.setDirection(this.direction + toNumber(d));
  }
  turnLeft(d: Value): void {
    this.setDirection(this.direction - toNumber(d));
  }
  moveSteps(steps: Value): void {
    const n = toNumber(steps);
    const radians = ((90 - this.direction) * Math.PI) / 180;
    this.setXY(this.x + n * cos(radians), this.y + n * sin(radians));
  }
  pointTowards(towards: Value): void {
    let tx: number;
    let ty: number;
    if (towards === '_mouse_') {
      tx = this.rt.io.mouseX;
      ty = this.rt.io.mouseY;
    } else if (towards === '_random_') {
      this.setDirection(Math.round(this.rt.random() * 360) - 180);
      return;
    } else {
      const other = this.rt.getSpriteTargetByName(toStr(towards));
      if (!other) return;
      tx = other.x;
      ty = other.y;
    }
    const dx = tx - this.x;
    const dy = ty - this.y;
    this.setDirection(90 - (atan2(dy, dx) * 180) / Math.PI);
  }

  setRotationStyle(style: string): void {
    if (style === ROT_NONE || style === ROT_ALL || style === ROT_LR) this.rotationStyle = style;
    this.visualChange();
  }

  xPosition(): number {
    return limitPrecision(this.x);
  }
  yPosition(): number {
    return limitPrecision(this.y);
  }

  // ---------------------------------------------------------------- looks

  setCostume(index: number): void {
    index = Math.round(index);
    if (index === Infinity || index === -Infinity || Number.isNaN(index)) index = 0;
    const next = wrapClamp(index, 0, this.sprite.costumes.length - 1);
    if (next !== this.currentCostume) this.hullClean = false;
    this.currentCostume = next;
    this.visualChange();
  }

  switchCostume(c: Value): void {
    if (typeof c === 'number') {
      this.setCostume(c - 1);
      return;
    }
    const s = c.toString();
    const idx = this.sprite.costumeByName.get(s);
    if (idx !== undefined) this.setCostume(idx);
    else if (c === 'next costume') this.setCostume(this.currentCostume + 1);
    else if (c === 'previous costume') this.setCostume(this.currentCostume - 1);
    else if (!(Number.isNaN(Number(c)) || (typeof c === 'string' && c.trim().length === 0))) this.setCostume(Number(c) - 1);
  }

  nextCostume(): void {
    this.setCostume(this.currentCostume + 1);
  }

  costumeNumber(): number {
    return this.currentCostume + 1;
  }
  costumeName(): string {
    return this.sprite.costumes[this.currentCostume].name;
  }

  setSize(size: number): void {
    if (this.isStage) return;
    const skin = this.rt.render.skinOf(this);
    const origW = skin.w;
    const origH = skin.h;
    const minScale = Math.min(1, Math.max(5 / origW, 5 / origH));
    const maxScale = Math.min((1.5 * STAGE_W) / origW, (1.5 * STAGE_H) / origH);
    this.size = clamp(size / 100, minScale, maxScale) * 100;
    this.visualChange();
  }
  setSizeTo(v: Value): void {
    this.setSize(toNumber(v));
  }
  changeSizeBy(v: Value): void {
    this.setSize(this.size + toNumber(v));
  }
  getSize(): number {
    return Math.round(this.size);
  }

  setEffectRaw(name: EffectName, value: number): void {
    this.effects[name] = value;
    if (name === 'fisheye' || name === 'whirl' || name === 'pixelate' || name === 'mosaic') this.hullClean = false;
    this.visualChange();
  }
  setEffect(name: EffectName, v: Value): void {
    this.setEffectRaw(name, clampEffect(name, toNumber(v)));
  }
  changeEffect(name: EffectName, v: Value): void {
    this.setEffectRaw(name, clampEffect(name, toNumber(v) + this.effects[name]));
  }
  clearEffects(): void {
    for (const n of EFFECT_NAMES) this.effects[n] = 0;
    this.hullClean = false;
    this.visualChange();
  }

  setVisible(vis: boolean): void {
    if (this.isStage) return;
    if (vis !== this.visible) this.hullClean = false;
    this.visible = vis;
    this.visualChange();
  }
  show(): void {
    this.setVisible(true);
  }
  hide(): void {
    this.setVisible(false);
  }

  goToFront(): void {
    if (this.isStage) return;
    this.rt.setDrawableOrder(this, Infinity, false);
    this.rt.setExecutablePosition(this, Infinity);
  }
  goToBack(): void {
    if (this.isStage) return;
    this.rt.setDrawableOrder(this, -Infinity, false);
    this.rt.setExecutablePosition(this, -Infinity);
  }
  goToFrontBack(where: string): void {
    if (where === 'front') this.goToFront();
    else this.goToBack();
  }
  /** `go forward/backward n layers`: renderer order and execution order both move by n. */
  goLayers(where: string, n: Value): void {
    if (this.isStage) return;
    const d = where === 'forward' ? toNumber(n) : -toNumber(n);
    this.rt.setDrawableOrder(this, d, true);
    this.rt.moveExecutable(this, d);
  }

  // ---------------------------------------------------------------- pen

  penState(): PenState {
    if (!this.pen) this.pen = defaultPen();
    return this.pen;
  }

  penDown(): void {
    const p = this.penState();
    p.penDown = true;
    this.rt.penPoint(p, this.x, this.y);
  }
  penUp(): void {
    this.penState().penDown = false;
  }
  stamp(): void {
    this.rt.penStamp(this);
  }
  setPenColorToColor(c: Value): void {
    const p = this.penState();
    let rgb = typeof c === 'string' && c.substring(0, 1) === '#' ? hexToRgb(c) : decimalToRgb(toNumber(c));
    if (!rgb) rgb = { r: 0, g: 0, b: 0, a: 255 };
    const hsv = rgbToHsv(rgb);
    p.color = (hsv.h / 360) * 100;
    p.saturation = hsv.s * 100;
    p.brightness = hsv.v * 100;
    p.transparency = rgb.a !== undefined ? 100 * (1 - rgb.a / 255) : 0;
    updatePenColor(p);
  }
  setPenColorParam(param: Value, v: Value, change: boolean): void {
    const p = this.penState();
    const value = toNumber(v);
    switch (param) {
      case 'color':
        p.color = wrapClamp(value + (change ? p.color : 0), 0, 100);
        break;
      case 'saturation':
        p.saturation = clamp(value + (change ? p.saturation : 0), 0, 100);
        break;
      case 'brightness':
        p.brightness = clamp(value + (change ? p.brightness : 0), 0, 100);
        break;
      case 'transparency':
        p.transparency = clamp(value + (change ? p.transparency : 0), 0, 100);
        break;
    }
    updatePenColor(p);
  }
  setPenSize(v: Value): void {
    this.penState().diameter = clamp(toNumber(v), 1, 1200);
  }
  changePenSize(v: Value): void {
    const p = this.penState();
    p.diameter = clamp(p.diameter + toNumber(v), 1, 1200);
  }

  // ---------------------------------------------------------------- sound state

  soundState(): SoundFx {
    if (!this.snd) this.snd = { pitch: 0, pan: 0 };
    return this.snd;
  }
}

export function limitPrecision(c: number): number {
  const rounded = Math.round(c);
  return Math.abs(c - rounded) < 1e-9 ? rounded : c;
}

export function clampEffect(name: string, v: number): number {
  if (name === 'ghost') return clamp(v, 0, 100);
  if (name === 'brightness') return clamp(v, -100, 100);
  return v;
}

function updatePenColor(p: PenState): void {
  const rgb = hsvToRgb((p.color * 360) / 100, p.saturation / 100, p.brightness / 100);
  p.c4 = [rgb.r / 255, rgb.g / 255, rgb.b / 255, 1 - p.transparency / 100];
}

export { isInt };
