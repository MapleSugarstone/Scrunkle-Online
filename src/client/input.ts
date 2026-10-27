// Local keyboard and mouse state, in the key names and stage coordinates the game uses.
import { browserKeyToName } from '../engine/io.ts';
import { STAGE_H, STAGE_W, STAGE_X, STAGE_Y } from '../engine/defs.ts';

export class LocalInput {
  keys = new Set<string>();
  /** Keys pressed since the last sample, so a tap shorter than a frame still reaches the game. */
  private tapped = new Set<string>();
  mouse = { x: 0, y: 0, down: false };
  mouseDirty = false;
  /** When false, key events are ignored (for example while a text box has focus). */
  enabled = true;
  /** A key that Escape also presses, such as the pause menu's key, or null. */
  escapeAs: string | null = null;

  constructor(private stageEl: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.ctrlKey || e.metaKey || e.altKey) return;
      const name = e.key === 'Escape' && this.escapeAs ? this.escapeAs : browserKeyToName(e.key);
      if (!name) return;
      this.keys.add(name);
      this.tapped.add(name);
      if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      const name = e.key === 'Escape' && this.escapeAs ? this.escapeAs : browserKeyToName(e.key);
      if (name) this.keys.delete(name);
      // Shifted characters can release under a different key name, so match on the physical key too.
      if (e.code.startsWith('Key')) this.keys.delete(e.code.slice(3));
      if (e.code.startsWith('Digit')) this.keys.delete(e.code.slice(5));
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.tapped.clear();
    });
    const move = (e: PointerEvent) => {
      const r = this.stageEl.getBoundingClientRect();
      const x = Math.round(Math.max(-STAGE_X, Math.min(STAGE_X, STAGE_W * ((e.clientX - r.left) / r.width - 0.5))));
      const y = Math.round(Math.max(-STAGE_Y, Math.min(STAGE_Y, -STAGE_H * ((e.clientY - r.top) / r.height - 0.5))));
      if (x !== this.mouse.x || y !== this.mouse.y) {
        this.mouse.x = x;
        this.mouse.y = y;
        this.mouseDirty = true;
      }
    };
    window.addEventListener('pointermove', move);
    this.stageEl.addEventListener('pointerdown', (e) => {
      move(e);
      this.mouse.down = true;
      this.clicked = true;
      this.mouseDirty = true;
    });
    window.addEventListener('pointerup', (e) => {
      move(e);
      if (this.mouse.down) {
        this.mouse.down = false;
        this.mouseDirty = true;
      }
    });
  }

  /** Keys for one game frame: those held now plus those tapped since the previous call. */
  sampleKeys(): string[] {
    for (const k of this.keys) this.tapped.add(k);
    const out = [...this.tapped];
    this.tapped.clear();
    return out;
  }

  /** Presses a key for one frame, as the pause menu's buttons do. */
  tap(key: string): void {
    this.tapped.add(key);
  }

  /** Returns sampled keys whose frame did not run, so the next sample includes them. */
  retap(keys: string[]): void {
    for (const k of keys) this.tapped.add(k);
  }

  /** Set by a press, so a click released before the next sample still reaches the game. */
  private clicked = false;

  /** The pointer for one game frame, or undefined when it has not changed since the previous call. */
  sampleMouse(): { x: number; y: number; down: boolean } | undefined {
    if (!this.mouseDirty) return undefined;
    const m = { ...this.mouse, down: this.mouse.down || this.clicked };
    // A click released within one frame reads as down for that frame and up on the next.
    this.mouseDirty = this.clicked && !this.mouse.down;
    this.clicked = false;
    return m;
  }

  /** Returns a sampled pointer whose frame did not run, so the next sample repeats it. */
  remouse(m: { down: boolean }): void {
    if (m.down && !this.mouse.down) this.clicked = true;
    this.mouseDirty = true;
  }
}
