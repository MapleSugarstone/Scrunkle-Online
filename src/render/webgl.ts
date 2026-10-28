// WebGL renderer for the port. It follows the original renderer's rules: vector costumes are
// rasterized at power-of-two scales, bitmaps sample with nearest filtering, the pen layer is a
// stage-sized texture shown with nearest filtering, and effects run in the fragment shader.
import { STAGE_H, STAGE_W, STAGE_X, STAGE_Y, type SkinDef } from '../engine/defs.ts';
import type { PenCmd, Runtime, Tint } from '../engine/runtime.ts';
import { RenderModel } from '../engine/render-model.ts';
import { cos, sin } from '../engine/dmath.ts';
import type { Effects } from '../engine/target.ts';
import { EFFECT_BITS, FRAGMENT, POST_VERTEX, QUANTIZE, UPSCALE, VERTEX } from './shaders.ts';

const NATIVE_W = STAGE_W;
const NATIVE_H = STAGE_H;
/** Stage pixels per side of one pixel in the old flash game display mode. */
const FLASH_DIVISOR = 2;
/** The texture cache level of a vector costume's handheld image, which no power-of-two mip uses. */
const HANDHELD_LEVEL = -1;

/**
 * How the stage reaches the screen. `smooth` draws at the screen's resolution as the original does. `flash` draws at
 * the stage's size, halves it, dithers it to 256 colors and enlarges it. `handheld` draws on a grid smaller than the
 * stage (`handheldScale`), rasterizes each vector costume once at that same scale so a costume at its normal size
 * gets one texel per grid pixel, samples every costume with nearest filtering and enlarges the result.
 */
export type DisplayMode = 'smooth' | 'flash' | 'handheld';

/** The pen commands from `from` on, in the order and form to draw them, for an option that changes only the picture. */
export type PenView = (rt: Runtime, cmds: readonly PenCmd[], from: number) => readonly PenCmd[];

/** An offscreen image the display modes draw into. */
interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}
/** Share of the remaining distance a smoothed stamp covers per drawn frame, and the jump (stage units) drawn at once. */
const SMOOTH_RATE = 0.45;
const SMOOTH_SNAP = 90;
const MIP_OFFSET = 8;

interface Program {
  prog: WebGLProgram;
  uni: Map<string, WebGLUniformLocation | null>;
  aPos: number;
  aTex: number;
}

/** What a drawable needs to be drawn: a skin, a transform and effects. */
export interface DrawState {
  skin: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  dir: number;
  fx: Effects;
  tint?: Tint | null;
}

function ortho(left: number, right: number, bottom: number, top: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = 2 / (right - left);
  m[5] = 2 / (top - bottom);
  m[10] = 2 / (-1 - 1);
  m[12] = (right + left) / (left - right);
  m[13] = (top + bottom) / (bottom - top);
  m[14] = (1 + -1) / (-1 - 1);
  m[15] = 1;
  return m;
}

function effectBits(fx: Effects): number {
  let b = 0;
  if (fx.color) b |= EFFECT_BITS.color;
  if (fx.fisheye) b |= EFFECT_BITS.fisheye;
  if (fx.whirl) b |= EFFECT_BITS.whirl;
  if (fx.pixelate) b |= EFFECT_BITS.pixelate;
  if (fx.mosaic) b |= EFFECT_BITS.mosaic;
  if (fx.brightness) b |= EFFECT_BITS.brightness;
  if (fx.ghost) b |= EFFECT_BITS.ghost;
  return b;
}

export class WebGLRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGLRenderingContext;
  private skins: SkinDef[];
  private geom: RenderModel;
  private images: (HTMLImageElement | ImageBitmap | null)[];
  /** Per skin: mip level -> texture (vectors) or a single texture at index 0 (bitmaps). */
  private textures: Map<number, WebGLTexture | null>[];
  private programs = new Map<string, Program>();
  private quadPos: WebGLBuffer;
  private quadTex: WebGLBuffer;
  private linePos: WebGLBuffer;
  private penTex: WebGLTexture;
  private penFbo: WebGLFramebuffer;
  /** Pen layer size in pixels: 480x360, or the canvas size with high quality pen. */
  private penW = NATIVE_W;
  private penH = NATIVE_H;
  /** Draws the pen layer at the canvas resolution instead of 480x360, so pen lines and stamps stay sharp when the stage is enlarged. */
  hqPen = false;
  /**
   * Pen stamps of these skins are drawn eased toward their position instead of at it. Online, the
   * other players' select cursors use this, because rollback corrections make them jump back.
   * Only the picture changes, never the simulation.
   */
  smoothSkins = new Set<number>();
  private smoothed = new Map<number, { x: number; y: number }>();
  private penView: PenView | null = null;
  /** Skins of stamps on the pen layer that drew nothing because their images had not loaded. */
  private penMissing = new Set<number>();
  private penArr: PenCmd[] | null = null;
  private penDrawn = 0;
  private penEpoch = -1;
  private emptyTex: WebGLTexture;
  private mipCanvas = new Map<number, HTMLCanvasElement>();
  private display: DisplayMode = 'smooth';
  private targets = new Map<string, Target>();
  /** Handheld mode's grid and vector costume size as a share of the stage's: 0.75 draws a 640x360 stage at 480x270. */
  handheldScale = 0.75;
  /** One canvas for every handheld image, so the per-costume mip canvases keep the original's readback order. */
  private handheldCanvas: HTMLCanvasElement | null = null;

  constructor(canvas: HTMLCanvasElement, skins: SkinDef[]) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { alpha: false, stencil: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;
    this.skins = skins;
    this.geom = new RenderModel(skins);
    this.images = skins.map(() => null);
    this.textures = skins.map(() => new Map());

    this.quadPos = this.buffer([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5]);
    this.quadTex = this.buffer([1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1]);
    this.linePos = this.buffer([1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1]);

    this.emptyTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.texParams();

    this.penTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.penTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, NATIVE_W, NATIVE_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.penFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.penFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.penTex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private buffer(data: number[]): WebGLBuffer {
    const gl = this.gl;
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    return b;
  }

  private texParams(): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  // ---------------------------------------------------------------- assets

  private base = '';
  /** Per skin: 0 not requested, 1 queued or loading, 2 loaded. */
  private loadState: Uint8Array = new Uint8Array(0);
  private urgent: number[] = [];
  private nextBackground = 0;
  private loading = 0;
  private loaded = 0;
  private onProgress?: (done: number, total: number) => void;

  /**
   * Starts loading costume images from `base`, the URL prefix of the assets folder, and compiles the shaders for
   * `effects`. Each image's textures are made as it arrives, so the frame that first shows it does no decoding or
   * uploading. A skin that is drawn before its image arrives loads next and draws nothing until then.
   */
  startLoading(base: string, effects: number[], onProgress?: (done: number, total: number) => void): void {
    this.base = base;
    this.onProgress = onProgress;
    this.loadState = new Uint8Array(this.skins.length);
    for (const bits of [0, ...effects]) this.program(false, bits);
    this.program(true, 0);
    this.pump();
  }

  /** Resolves once the given skins are loaded, for the first screen. */
  loadNow(skins: number[]): Promise<void> {
    for (const i of skins) this.want(i);
    return new Promise((resolve) => {
      const check = () => !skins.some((i) => this.loadState[i] !== 2) && (resolve(), true);
      if (!check()) this.waiters.push(check);
    });
  }

  /** Each returns true once its skins have loaded, and is then dropped. */
  private waiters: (() => boolean)[] = [];

  /**
   * Makes a skin's texture at the canvas's current scale by drawing it once into one pixel, so the driver uploads the
   * image now rather than on the frame that first shows it. A vector skin gets the mip for its normal size, and
   * other sizes are made when first drawn, as in the original.
   */
  private prepare(i: number): void {
    const gl = this.gl;
    const f = this.display === 'smooth' ? Math.max(this.canvas.width / NATIVE_W, this.canvas.height / NATIVE_H, 1) : 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, 1, 1);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 1, 1);
    const fx = { color: 0, fisheye: 0, whirl: 0, pixelate: 0, mosaic: 0, brightness: 0, ghost: 0 };
    this.drawSprite({ skin: i, x: 0, y: 0, sx: 100, sy: 100, dir: 90, fx }, this.stageProj, f, f);
    gl.disable(gl.SCISSOR_TEST);
  }

  private want(i: number): void {
    if (this.loadState.length === 0 || this.loadState[i] !== 0) return;
    this.loadState[i] = 1;
    this.urgent.push(i);
    this.pump();
  }

  private pump(): void {
    while (this.loading < 16) {
      let i = this.urgent.shift();
      if (i === undefined) {
        while (this.nextBackground < this.skins.length && this.loadState[this.nextBackground] !== 0) this.nextBackground++;
        if (this.nextBackground >= this.skins.length) return;
        i = this.nextBackground++;
        this.loadState[i] = 1;
      }
      const idx = i;
      const file = this.skins[idx].file;
      this.loading++;
      loadImage(/^(blob|data|https?):/.test(file) ? file : `${this.base}${file}`)
        .then((img) => (this.images[idx] = img), () => (this.images[idx] = null))
        .finally(() => {
          if (this.images[idx]) this.prepare(idx);
          this.loadState[idx] = 2;
          this.loading--;
          this.loaded++;
          this.onProgress?.(this.loaded, this.skins.length);
          this.waiters = this.waiters.filter((w) => !w());
          this.pump();
        });
    }
  }

  /** Texture for a skin at a draw scale (percent), creating vector mips on demand. */
  private skinTexture(skinIdx: number, scaleX: number, scaleY: number): WebGLTexture {
    const skin = this.skins[skinIdx];
    const img = this.images[skinIdx];
    if (!img) {
      this.want(skinIdx);
      return this.emptyTex;
    }
    const gl = this.gl;
    const cache = this.textures[skinIdx];
    let level = 0;
    let mipScale = 1;
    if (skin.kind === 'svg' && this.display === 'handheld') level = HANDHELD_LEVEL;
    else if (skin.kind === 'svg') {
      const requested = Math.min(Math.max(Math.abs(scaleX), Math.abs(scaleY)) / 100, skin.maxScale);
      level = Math.max(Math.ceil(Math.log2(requested)) + MIP_OFFSET, 0);
      mipScale = Math.pow(2, level - MIP_OFFSET);
    }
    const hit = cache.get(level);
    if (hit !== undefined) return hit ?? this.emptyTex;
    let source: TexImageSource | ImageData = img;
    if (level === HANDHELD_LEVEL) {
      if (skin.w <= 0 || skin.h <= 0) {
        cache.set(level, null);
        return this.emptyTex;
      }
      // A whole number of pixels on each side, stretched to fill the costume's box when drawn.
      const c = (this.handheldCanvas ??= document.createElement('canvas'));
      c.width = Math.max(1, Math.round(skin.w * this.handheldScale));
      c.height = Math.max(1, Math.round(skin.h * this.handheldScale));
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.setTransform(c.width / skin.w, 0, 0, c.height / skin.h, 0, 0);
      ctx.drawImage(img, 0, 0);
      source = ctx.getImageData(0, 0, c.width, c.height);
    } else if (skin.kind === 'svg') {
      // One canvas per costume, used for its mips in the same order as the original renderer: the
      // browser moves a canvas to its CPU rasterizer after a few readbacks, which antialiases differently.
      let c = this.mipCanvas.get(skinIdx);
      if (!c) {
        c = document.createElement('canvas');
        this.mipCanvas.set(skinIdx, c);
      }
      c.width = skin.w * mipScale;
      c.height = skin.h * mipScale;
      if (c.width <= 0 || c.height <= 0) {
        cache.set(level, null);
        return this.emptyTex;
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.setTransform(mipScale, 0, 0, mipScale, 0, 0);
      ctx.drawImage(img, 0, 0);
      source = ctx.getImageData(0, 0, c.width, c.height);
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.texParams();
    cache.set(level, tex);
    return tex;
  }

  private useNearest(skin: SkinDef, d: DrawState, scaleX: number, scaleY: number): boolean {
    if (skin.kind === 'bitmap' || this.display === 'handheld') return true;
    if (d.fx.fisheye || d.fx.whirl || d.fx.pixelate || d.fx.mosaic) return false;
    if (d.dir % 90 !== 0) return false;
    const ax = Math.abs(scaleX);
    const ay = Math.abs(scaleY);
    return ax > 99 && ax < 101 && ay > 99 && ay < 101;
  }

  // ---------------------------------------------------------------- programs

  private program(line: boolean, bits: number): Program {
    const key = `${line ? 'L' : 'S'}${bits}`;
    const cached = this.programs.get(key);
    if (cached) return cached;
    const gl = this.gl;
    const defs: string[] = [];
    if (line) defs.push('#define LINE');
    for (const [name, bit] of Object.entries(EFFECT_BITS)) if (bits & bit) defs.push(`#define ENABLE_${name}`);
    const head = `${defs.join('\n')}\n`;
    const p = this.link(head + VERTEX, head + FRAGMENT);
    this.programs.set(key, p);
    return p;
  }

  /** The program for a display mode pass, compiled on first use. */
  private postProgram(fragment: string): Program {
    const cached = this.programs.get(fragment);
    if (cached) return cached;
    const p = this.link(POST_VERTEX, fragment);
    this.programs.set(fragment, p);
    return p;
  }

  private link(vertex: string, fragment: string): Program {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
    return { prog, uni: new Map(), aPos: gl.getAttribLocation(prog, 'a_position'), aTex: gl.getAttribLocation(prog, 'a_texCoord') };
  }

  private loc(p: Program, name: string): WebGLUniformLocation | null {
    if (!p.uni.has(name)) p.uni.set(name, this.gl.getUniformLocation(p.prog, name));
    return p.uni.get(name)!;
  }

  // ---------------------------------------------------------------- drawing

  /** Draws one drawable with the given projection; `fbScaleX/Y` convert stage units to target pixels. */
  private drawSprite(d: DrawState, projection: Float32Array, fbScaleX: number, fbScaleY: number): void {
    const gl = this.gl;
    const skin = this.skins[d.skin];
    const scaleX = d.sx * fbScaleX;
    const scaleY = d.sy * fbScaleY;
    const tex = this.skinTexture(d.skin, scaleX, scaleY);
    const bits = effectBits(d.fx) | (d.tint ? EFFECT_BITS.tint : 0);
    const p = this.program(false, bits);
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadPos);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadTex);
    gl.enableVertexAttribArray(p.aTex);
    gl.vertexAttribPointer(p.aTex, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const filter = this.useNearest(skin, d, scaleX, scaleY) ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.uniform1i(this.loc(p, 'u_skin'), 0);
    gl.uniformMatrix4fv(this.loc(p, 'u_projectionMatrix'), false, projection);
    gl.uniformMatrix4fv(this.loc(p, 'u_modelMatrix'), false, modelMatrix(skin, d));
    const fx = d.fx;
    if (bits & EFFECT_BITS.color) gl.uniform1f(this.loc(p, 'u_color'), (fx.color / 200) % 1);
    if (bits & EFFECT_BITS.fisheye) gl.uniform1f(this.loc(p, 'u_fisheye'), Math.max(0, (fx.fisheye + 100) / 100));
    if (bits & EFFECT_BITS.whirl) gl.uniform1f(this.loc(p, 'u_whirl'), (-fx.whirl * Math.PI) / 180);
    if (bits & EFFECT_BITS.pixelate) {
      gl.uniform1f(this.loc(p, 'u_pixelate'), Math.abs(fx.pixelate) / 10);
      gl.uniform2f(this.loc(p, 'u_skinSize'), skin.w, skin.h);
    }
    if (bits & EFFECT_BITS.mosaic) gl.uniform1f(this.loc(p, 'u_mosaic'), Math.max(1, Math.min(Math.round((Math.abs(fx.mosaic) + 10) / 10), 512)));
    if (bits & EFFECT_BITS.brightness) gl.uniform1f(this.loc(p, 'u_brightness'), Math.max(-100, Math.min(fx.brightness, 100)) / 100);
    if (bits & EFFECT_BITS.ghost) gl.uniform1f(this.loc(p, 'u_ghost'), 1 - Math.max(0, Math.min(fx.ghost, 100)) / 100);
    if (d.tint) gl.uniform4f(this.loc(p, 'u_tint'), d.tint[0], d.tint[1], d.tint[2], d.tint[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Draws a pen line. `s` is pen pixels per stage unit, so the shader's one-unit antialiased edge is one pixel. */
  private drawLine(cmd: Extract<PenCmd, { op: 'line' }>, s: number): void {
    const gl = this.gl;
    const p = this.program(true, 0);
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.linePos);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
    const d = cmd.d || 1;
    const off = d === 1 || d === 3 ? 0.5 : 0;
    const x0 = (cmd.x0 + off) * s;
    const y0 = (cmd.y0 + off) * s;
    const dx = (cmd.x1 + off) * s - x0;
    const dy = (cmd.y1 + off) * s - y0;
    const c = cmd.c4;
    gl.uniform2f(this.loc(p, 'u_stageSize'), NATIVE_W * s, NATIVE_H * s);
    gl.uniform4f(this.loc(p, 'u_lineColor'), c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]);
    gl.uniform1f(this.loc(p, 'u_lineThickness'), d * s);
    gl.uniform1f(this.loc(p, 'u_lineLength'), Math.sqrt(dx * dx + dy * dy));
    gl.uniform4f(this.loc(p, 'u_penPoints'), x0, -y0, dx, -dy);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private penFlip = ortho(-NATIVE_W / 2, NATIVE_W / 2, NATIVE_H / 2, -NATIVE_H / 2);

  private drawPenCmd(cmd: PenCmd): void {
    const gl = this.gl;
    const s = this.penW / NATIVE_W;
    if (cmd.op === 'line') {
      gl.viewport(0, 0, this.penW, this.penH);
      gl.disable(gl.SCISSOR_TEST);
      this.drawLine(cmd, s);
      return;
    }
    const d: DrawState = { skin: cmd.skin, x: cmd.x, y: cmd.y, sx: cmd.sx, sy: cmd.sy, dir: cmd.dir, fx: cmd.fx, tint: cmd.tint };
    if (this.smoothSkins.has(cmd.skin)) {
      const p = this.ease(cmd.skin, cmd.x, cmd.y);
      d.x = p.x;
      d.y = p.y;
    }
    // Stamping first asks for the 100% texture (the original checks the stamp bounds with it).
    this.skinTexture(cmd.skin, 100, 100);
    if (this.loadState[cmd.skin] !== 2) this.penMissing.add(cmd.skin);
    const b = cmd.clip ?? stampBounds(this.geom, this.skins[cmd.skin], d);
    if (!b) return;
    if (this.penW !== NATIVE_W || this.penH !== NATIVE_H) {
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, this.penW, this.penH);
      this.drawSprite(d, this.penFlip, s, this.penH / NATIVE_H);
      return;
    }
    // A viewport and projection covering only the stamp's bounds, as the original does; using the
    // full layer with a scissor rasterizes edges slightly differently.
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(NATIVE_W / 2 + b.left, NATIVE_H / 2 - b.top, b.right - b.left, b.top - b.bottom);
    this.drawSprite(d, ortho(b.left, b.right, b.top, b.bottom), 1, 1);
  }

  /** Brings the pen texture up to date with the simulation's command list. */
  private syncPen(rt: Runtime): void {
    const gl = this.gl;
    const cmds = rt.pen.cmds;
    const resized = this.sizePen();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.penFbo);
    // A stamp drawn before its image arrived drew nothing, so the layer redraws once that image has loaded.
    const arrived = [...this.penMissing].some((s) => this.loadState[s] === 2);
    if (resized || cmds !== this.penArr || this.penDrawn > cmds.length || rt.penEpoch !== this.penEpoch || arrived) {
      gl.viewport(0, 0, this.penW, this.penH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.penArr = cmds;
      this.penDrawn = 0;
      this.penEpoch = rt.penEpoch;
      this.penMissing.clear();
    }
    if (this.penView) {
      if (this.penDrawn < cmds.length) for (const cmd of this.penView(rt, cmds, this.penDrawn)) this.drawPenCmd(cmd);
    } else {
      for (let i = this.penDrawn; i < cmds.length; i++) this.drawPenCmd(cmds[i]);
    }
    this.penDrawn = cmds.length;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Moves a smoothed stamp's drawn position part of the way to its real one, or straight there after a big jump. */
  private ease(skin: number, x: number, y: number): { x: number; y: number } {
    const p = this.smoothed.get(skin);
    if (!p || Math.hypot(x - p.x, y - p.y) > SMOOTH_SNAP) {
      const q = { x, y };
      this.smoothed.set(skin, q);
      return q;
    }
    p.x += (x - p.x) * SMOOTH_RATE;
    p.y += (y - p.y) * SMOOTH_RATE;
    return p;
  }

  /** Resizes the pen texture to match the current setting and canvas. The command list then redraws it at the new size. */
  private sizePen(): boolean {
    const hq = this.hqPen && this.display === 'smooth';
    const [gw, gh] = this.stageGrid();
    const w = hq ? Math.max(NATIVE_W, this.canvas.width) : gw;
    const h = hq ? Math.max(NATIVE_H, this.canvas.height) : gh;
    if (w === this.penW && h === this.penH) return false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.penTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.penW = w;
    this.penH = h;
    return true;
  }

  private stageProj = ortho(-NATIVE_W / 2, NATIVE_W / 2, -NATIVE_H / 2, NATIVE_H / 2);

  /** Draws the pen layer through `view` from now on, or straight from the commands with null, and redraws it. */
  setPenView(view: PenView | null): void {
    this.penView = view;
    this.penArr = null;
  }

  /** Changes how the stage reaches the screen. The pen layer redraws under the new mode's costume rules. */
  setDisplay(mode: DisplayMode): void {
    if (mode === this.display) return;
    this.display = mode;
    this.penArr = null;
  }

  /** The pixel size the display modes draw the stage at: the stage's own size, or handheld mode's smaller grid. */
  private stageGrid(): [number, number] {
    const s = this.display === 'handheld' ? this.handheldScale : 1;
    return [Math.round(NATIVE_W * s), Math.round(NATIVE_H * s)];
  }

  /** Draws the current simulation state to the canvas. */
  render(rt: Runtime): void {
    const gl = this.gl;
    this.syncPen(rt);
    const post = this.display !== 'smooth';
    const [w, h] = post ? this.stageGrid() : [this.canvas.width, this.canvas.height];
    const stageImage = post ? this.target('stage', w, h) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, stageImage?.fbo ?? null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const differs = w !== NATIVE_W && h !== NATIVE_H;
    const sxF = differs ? w / NATIVE_W : 1;
    const syF = differs ? h / NATIVE_H : 1;
    const stage = rt.stage;
    this.drawSprite(drawStateOf(stage), this.stageProj, sxF, syF);
    if (rt.penCreated) this.drawPenLayer(sxF, syF);
    for (const t of rt.drawList) {
      if (!t.visible) continue;
      this.drawSprite(drawStateOf(t, rt.tintOf?.(t)), this.stageProj, sxF, syF);
    }
    if (stageImage) this.finishDisplay(stageImage);
  }

  /** Takes the stage image from its offscreen target to the canvas through the display mode's passes. */
  private finishDisplay(stageImage: Target): void {
    const gl = this.gl;
    let src = stageImage;
    gl.disable(gl.BLEND);
    if (this.display === 'flash') {
      const low = this.target('flash', Math.round(NATIVE_W / FLASH_DIVISOR), Math.round(NATIVE_H / FLASH_DIVISOR));
      gl.bindFramebuffer(gl.FRAMEBUFFER, low.fbo);
      gl.viewport(0, 0, low.w, low.h);
      this.drawPost(this.postProgram(QUANTIZE), src);
      src = low;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const p = this.postProgram(UPSCALE);
    gl.useProgram(p.prog);
    gl.uniform2f(this.loc(p, 'u_size'), src.w, src.h);
    gl.uniform2f(this.loc(p, 'u_scale'), Math.max(1, Math.floor(this.canvas.width / src.w)), Math.max(1, Math.floor(this.canvas.height / src.h)));
    this.drawPost(p, src);
    gl.enable(gl.BLEND);
  }

  private drawPost(p: Program, src: Target): void {
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadPos);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(this.loc(p, 'u_image'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** An offscreen image with linear filtering, made on first use and remade when its size changes. */
  private target(name: string, w: number, h: number): Target {
    const gl = this.gl;
    const hit = this.targets.get(name);
    if (hit && hit.w === w && hit.h === h) return hit;
    if (hit) {
      gl.deleteFramebuffer(hit.fbo);
      gl.deleteTexture(hit.tex);
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.texParams();
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { tex, fbo, w, h };
    this.targets.set(name, t);
    return t;
  }

  private drawPenLayer(sxF: number, syF: number): void {
    const gl = this.gl;
    const p = this.program(false, 0);
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadPos);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadTex);
    gl.enableVertexAttribArray(p.aTex);
    gl.vertexAttribPointer(p.aTex, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.penTex);
    const nearest = Math.max(100 * sxF, 100 * syF) >= 100;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.uniform1i(this.loc(p, 'u_skin'), 0);
    gl.uniformMatrix4fv(this.loc(p, 'u_projectionMatrix'), false, this.stageProj);
    const m = new Float32Array(16);
    // Pen skin: 480x360 with its center at the stage origin, direction 90, scale 100.
    m[0] = -NATIVE_W;
    m[5] = -NATIVE_H;
    m[10] = 1;
    m[15] = 1;
    gl.uniformMatrix4fv(this.loc(p, 'u_modelMatrix'), false, m);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  resize(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }
}

export function drawStateOf(t: import('../engine/target.ts').Target, tint: Tint | null = null): DrawState {
  return {
    skin: t.sprite.costumes[t.currentCostume].skin,
    x: t.drawX,
    y: t.drawY,
    sx: Math.fround(t.renderedScaleX()),
    sy: Math.fround(t.size),
    dir: t.renderedDirection(),
    fx: t.effects,
    tint,
  };
}

/** Model matrix with the same 32-bit float storage as the simulation's geometry. */
function modelMatrix(skin: SkinDef, d: DrawState): Float32Array {
  const f = Math.fround;
  const rotation = ((270 - d.dir) * Math.PI) / 180;
  const cd = cos(rotation);
  const sd = sin(rotation);
  const r00 = f(cd);
  const r01 = f(sd);
  const r10 = f(-sd);
  const r11 = f(cd);
  const adj0 = f(((f(skin.rcx) - skin.w / 2) * d.sx) / 100);
  const adj1 = f((((f(skin.rcy) - skin.h / 2) * d.sy) / 100) * -1);
  const s0 = f((skin.w * d.sx) / 100);
  const s1 = f((skin.h * d.sy) / 100);
  const m = new Float32Array(16);
  m[0] = s0 * r00;
  m[1] = s0 * r01;
  m[4] = s1 * r10;
  m[5] = s1 * r11;
  m[10] = 1;
  m[12] = r00 * adj0 + r10 * adj1 + d.x;
  m[13] = r01 * adj0 + r11 * adj1 + d.y;
  m[15] = 1;
  return m;
}

function stampBounds(_geom: RenderModel, skin: SkinDef, d: DrawState): { left: number; right: number; bottom: number; top: number } | null {
  const m = modelMatrix(skin, d);
  const x = Math.abs(0.5 * m[0]) + Math.abs(0.5 * m[4]);
  const y = Math.abs(0.5 * m[1]) + Math.abs(0.5 * m[5]);
  let left = -x + m[12];
  let right = x + m[12];
  let top = y + m[13];
  let bottom = -y + m[13];
  left = Math.max(left, -STAGE_X);
  right = Math.min(right, STAGE_X);
  bottom = Math.max(bottom, -STAGE_Y);
  top = Math.min(top, STAGE_Y);
  left = Math.min(left, STAGE_X);
  right = Math.max(right, -STAGE_X);
  bottom = Math.min(bottom, STAGE_Y);
  top = Math.max(top, -STAGE_Y);
  left = Math.floor(left);
  right = Math.ceil(right);
  bottom = Math.floor(bottom);
  top = Math.ceil(top);
  if (right - left === 0 || top - bottom === 0) return null;
  return { left, right, bottom, top };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  if (/\.svg$/i.test(url) && !/^(blob|data):/.test(url)) return loadSvg(url);
  return imageFrom(url, true);
}

/** Longest wait for `decode()`, which never settles while the page is not rendering, as in a background tab. */
const DECODE_WAIT_MS = 250;

/**
 * Loads an image. With `decode`, the browser also decodes it off the main thread, so the texture upload does not.
 * The upload still premultiplies the pixels itself, as the original's does, which keeps edge pixels the same.
 */
function imageFrom(url: string, decode = false): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (!decode || document.visibilityState === 'hidden') return resolve(img);
      const timer = setTimeout(() => resolve(img), DECODE_WAIT_MS);
      img.decode().then(
        () => (clearTimeout(timer), resolve(img)),
        () => (clearTimeout(timer), resolve(img)),
      );
    };
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/** Font data shared between vector costumes, by the id tools/assets.ts gave it. */
const fontCache = new Map<string, Promise<string>>();

/**
 * Loads a vector costume after putting its fonts back. An image cannot fetch fonts itself, so each costume
 * carries its fonts inline as the original loader wrote them. The asset folder keeps one copy of each.
 */
async function loadSvg(url: string): Promise<HTMLImageElement> {
  let text = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`failed to load ${url}`);
    return r.text();
  });
  const ids = [...new Set([...text.matchAll(/cbfont:([0-9a-f]+)/g)].map((m) => m[1]))];
  if (ids.length > 0) {
    const fontBase = url.replace(/costumes\/[^/]+$/, 'fonts/');
    for (const id of ids) {
      if (!fontCache.has(id)) fontCache.set(id, fetch(`${fontBase}${id}.txt`).then((r) => r.text()));
      const data = await fontCache.get(id)!;
      text = text.split(`cbfont:${id}`).join(data);
    }
  }
  const blobUrl = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    return await imageFrom(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
