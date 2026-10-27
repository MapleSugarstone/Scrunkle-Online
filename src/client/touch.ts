// On-screen controls for touch screens: a joystick for movement and controller-style buttons for
// the rest. They show on touch devices while a game runs, beside the stage in landscape and below
// it in portrait, and hide while a controller is in use. Players choose which button does what in
// the lobby's controls menu.
import { ACTIONS, DEFAULT_TOUCH_BUTTONS, loadTouchButtons } from './controls.ts';
import { DOWN, LEFT, RIGHT, UP, type Pads } from './pads.ts';
import { STORAGE_PREFIX } from '../game/page.ts';

/** Share of the joystick's radius the thumb must move before it counts as a direction. */
const STICK_DEADZONE = 0.3;
/** Direction threshold on each axis: cos 67.5 degrees, so the eight directions get equal sectors. */
const AXIS = 0.383;
/** In menus the thumb must move further, since each release of a direction moves the selection. */
const MENU_DEADZONE = 0.5;
/** In menus the current axis is kept until the other leads it by this much, so a thumb near 45 degrees does not flip between them. */
const MENU_STICKINESS = 0.25;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Keeps a pointer's events on `target` while it is down. A pointer that already lifted cannot be captured, which is harmless. */
function capture(target: Element, id: number): void {
  try {
    target.setPointerCapture(id);
  } catch {
    // The pointer is no longer active.
  }
}

const CHOICE_KEY = `${STORAGE_PREFIX}.touch`;

function loadChoice(): boolean | null {
  try {
    const v = localStorage.getItem(CHOICE_KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

export class TouchControls {
  private root: HTMLDivElement;
  /** Detected: a touch screen is the main pointer, a touch happened, or a controller took over. */
  private touchDevice = matchMedia('(pointer: coarse)').matches;
  /** The player's own choice from the lobby, which wins over detection once made. */
  private choice = loadChoice();
  private playing = false;
  private dirs = new Set<number>();
  /** The buttons in place order, each with the action it presses. */
  private slots: { b: HTMLButtonElement; action: number }[] = [];
  /** Called whenever the controls switch on or off, for the lobby's toggle. */
  onChange: (on: boolean) => void = () => {};
  /** True while the game shows a menu, where the joystick gives one direction at a time. */
  menuMode: () => boolean = () => false;

  constructor(parent: HTMLElement, private pads: Pads, private relayout: () => void) {
    this.root = el('div', 'touch');
    this.root.append(this.stick(), this.face(), this.small());
    this.setButtons(loadTouchButtons());
    parent.append(this.root);
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && !this.touchDevice) {
        this.touchDevice = true;
        this.update();
      }
    });
    // A real controller's first input hides the controls. A device that only claims to be one never sends any.
    this.pads.onController = () => {
      this.touchDevice = false;
      this.update();
    };
    window.addEventListener('blur', () => this.pads.releaseAll());
    this.update();
  }

  /** Whether the controls show during a game. */
  get enabled(): boolean {
    return this.choice ?? this.touchDevice;
  }

  /** True while the controls show, so the page leaves room for them. */
  get active(): boolean {
    return this.enabled && this.playing;
  }

  setPlaying(on: boolean): void {
    this.playing = on;
    this.update();
  }

  /** Records the player's choice, which then wins over detection. */
  setChoice(on: boolean): void {
    this.choice = on;
    try {
      localStorage.setItem(CHOICE_KEY, on ? '1' : '0');
    } catch {
      // Storage may be blocked.
    }
    this.update();
  }

  private update(): void {
    this.onChange(this.enabled);
    document.documentElement.classList.toggle('touch-on', this.active);
    if (!this.active) {
      this.pads.releaseAll();
      this.setDirs(new Set());
    }
    this.relayout();
  }

  private setDirs(next: Set<number>): void {
    for (const a of this.dirs) if (!next.has(a)) this.pads.release(a);
    for (const a of next) if (!this.dirs.has(a)) this.pads.press(a);
    this.dirs = next;
  }

  /** A floating joystick: the base centers where the thumb lands and the knob follows it. */
  private stick(): HTMLElement {
    const zone = el('div', 'touch-stick');
    const base = el('div', 'touch-stick-base');
    const knob = el('div', 'touch-stick-knob');
    base.append(knob);
    zone.append(base);
    let id = -1;
    let cx = 0;
    let cy = 0;
    const move = (e: PointerEvent) => {
      const r = base.offsetWidth / 2;
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > r) {
        dx = (dx / dist) * r;
        dy = (dy / dist) * r;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const next = new Set<number>();
      const menu = this.menuMode();
      if (dist > r * (menu ? MENU_DEADZONE : STICK_DEADZONE)) {
        const ux = (e.clientX - cx) / dist;
        const uy = (e.clientY - cy) / dist;
        if (menu) {
          // Menus act on the last direction released, so they get exactly one direction at a time.
          const ax = Math.abs(ux);
          const ay = Math.abs(uy);
          let across = ax >= ay;
          if (this.dirs.has(RIGHT) || this.dirs.has(LEFT)) across = ay < ax + MENU_STICKINESS;
          else if (this.dirs.has(UP) || this.dirs.has(DOWN)) across = ax >= ay + MENU_STICKINESS;
          next.add(across ? (ux > 0 ? RIGHT : LEFT) : uy > 0 ? DOWN : UP);
        } else {
          if (ux > AXIS) next.add(RIGHT);
          if (ux < -AXIS) next.add(LEFT);
          if (uy < -AXIS) next.add(UP);
          if (uy > AXIS) next.add(DOWN);
        }
      }
      this.setDirs(next);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      base.classList.remove('held');
      base.style.left = '';
      base.style.top = '';
      knob.style.transform = '';
      this.setDirs(new Set());
    };
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (id !== -1) return;
      id = e.pointerId;
      capture(zone, id);
      const z = zone.getBoundingClientRect();
      cx = e.clientX;
      cy = e.clientY;
      base.style.left = `${cx - z.left}px`;
      base.style.top = `${cy - z.top}px`;
      base.classList.add('held');
      move(e);
    });
    zone.addEventListener('pointermove', (e) => {
      e.stopPropagation();
      if (e.pointerId === id) move(e);
    });
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    zone.addEventListener('lostpointercapture', end);
    return zone;
  }

  /** Gives the buttons their actions, in the place order of `DEFAULT_TOUCH_BUTTONS`. */
  setButtons(names: string[]): void {
    this.pads.releaseAll();
    this.slots.forEach((s, i) => {
      s.action = ACTIONS.indexOf(names[i]);
      s.b.textContent = names[i];
      s.b.classList.remove('down');
    });
  }

  private button(cls: string): HTMLButtonElement {
    const b = el('button', `touch-btn ${cls}`);
    b.tabIndex = -1;
    const slot = { b, action: -1 };
    this.slots.push(slot);
    // The action pressed is the one released, even when the buttons change in between.
    let held = -1;
    const up = (e: PointerEvent) => {
      e.stopPropagation();
      if (held >= 0) this.pads.release(held);
      held = -1;
      b.classList.remove('down');
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      capture(b, e.pointerId);
      held = slot.action;
      this.pads.press(held);
      b.classList.add('down');
    });
    b.addEventListener('pointermove', (e) => e.stopPropagation());
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }

  /** Four buttons in a diamond, like a controller's face buttons. */
  private face(): HTMLElement {
    const face = el('div', 'touch-face');
    face.append(this.button('top'), this.button('left'), this.button('right'), this.button('bottom'));
    return face;
  }

  private small(): HTMLElement {
    const row = el('div', 'touch-small');
    for (let i = 4; i < DEFAULT_TOUCH_BUTTONS.length; i++) row.append(this.button('pill'));
    return row;
  }
}
