// Page used by tools/visual.ts: runs a scenario frame by frame without real time and returns chosen frames as images.
import { Game } from './game.ts';
import { InputTimeline, type Scenario } from '../engine/scenario.ts';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const overlay = document.getElementById('overlay')!;
let game: Game | null = null;
let timeline: InputTimeline | null = null;

const api = {
  async init(sc: Scenario, t0: number, width: number, height: number): Promise<void> {
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    game = new Game(canvas, overlay, { seed: sc.seed, t0 });
    game.renderer.hqPen = false;
    timeline = new InputTimeline(sc.events);
    await game.load(() => {});
  },
  /** Runs `n` frames and returns PNG data URLs for the frames listed in `shotAt`. */
  run(n: number, shotAt: number[]): Record<number, string> {
    const shots: Record<number, string> = {};
    const want = new Set(shotAt);
    for (let i = 0; i < n; i++) {
      const f = game!.rt.frame + 1;
      game!.step(timeline!.inputsFor(f));
      if (want.has(f)) {
        game!.rt.soundEvents.length = 0;
        game!.renderer.render(game!.rt);
        shots[f] = canvas.toDataURL('image/png');
      }
    }
    game!.rt.soundEvents.length = 0;
    return shots;
  },
};

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.src = src;
  });
}

/** Per-pixel difference of two PNG data URLs: mean channel error, share of pixels over 24, and a difference image. */
async function diff(a: string, b: string): Promise<{ mean: number; over: number; diff: string }> {
  const [ia, ib] = await Promise.all([loadImg(a), loadImg(b)]);
  const w = ia.width;
  const h = ia.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(ia, 0, 0);
  const da = x.getImageData(0, 0, w, h).data;
  x.clearRect(0, 0, w, h);
  x.drawImage(ib, 0, 0, w, h);
  const db = x.getImageData(0, 0, w, h).data;
  const out = x.createImageData(w, h);
  let sum = 0;
  let over = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
    sum += d;
    if (d > 24) over++;
    const v = Math.min(255, d * 4);
    out.data[i] = v;
    out.data[i + 1] = d > 24 ? 0 : v;
    out.data[i + 2] = d > 24 ? 0 : v;
    out.data[i + 3] = 255;
  }
  x.putImageData(out, 0, 0);
  return { mean: sum / (w * h), over: over / (w * h), diff: c.toDataURL('image/png') };
}

(window as unknown as { PORT: typeof api & { diff: typeof diff } }).PORT = { ...api, diff };
document.body.dataset.ready = '1';
