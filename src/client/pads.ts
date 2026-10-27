// Touch controls and game controllers, read as the game's buttons for each local player.
// Slot 0 is the first player on this device: the touch controls and the first controller used. Each
// further controller is the next player when playing on one computer, in the order they are first used,
// so a device that only claims to be a controller (as phone sensors do on Android) never takes a slot.
import { ACTIONS, PAD_BUTTONS } from './controls.ts';

const act = (name: string): number => ACTIONS.indexOf(name);
export const UP = act('Up');
export const DOWN = act('Down');
export const LEFT = act('Left');
export const RIGHT = act('Right');

/** How far a stick must lean before it counts as a direction. */
const STICK_DEADZONE = 0.4;

/** The game's buttons for the standard layout's buttons, with the D-pad moving like the left stick. */
const BUTTONS: [number, number][] = [
  ...PAD_BUTTONS.map(([b, name]): [number, number] => [b, act(name)]).filter(([, a]) => a >= 0),
  [12, UP],
  [13, DOWN],
  [14, LEFT],
  [15, RIGHT],
];

/** Devices that Android lists as controllers but are not, such as fingerprint sensors and side keys. */
const NOT_CONTROLLERS = /uinput|fpc|goodix|fingerprint|gpio-keys/i;

/** Whether a device looks like a controller: the standard layout, or enough buttons and a stick or pad. */
function isController(gp: Gamepad): boolean {
  if (NOT_CONTROLLERS.test(gp.id)) return false;
  return gp.mapping === 'standard' || (gp.buttons.length >= 4 && gp.axes.length >= 2);
}

/** A controller's name without the vendor and product numbers some browsers add. */
const controllerName = (gp: Gamepad) => gp.id.replace(/\s*\((?:STANDARD GAMEPAD\s*)?Vendor: \w+ Product: \w+\)/i, '').trim() || 'Controller';

/** The devices the browser lists as controllers, and whether the game uses each one. */
export function listControllers(): { name: string; used: boolean }[] {
  return [...(navigator.getGamepads?.() ?? [])].filter((gp): gp is Gamepad => !!gp && gp.connected).map((gp) => ({ name: controllerName(gp), used: isController(gp) }));
}

export class Pads {
  /** Buttons held on the touch controls. */
  private held = new Set<number>();
  /** Buttons pressed since the last sample, so a tap shorter than a frame still counts. */
  private tapped = new Set<number>();
  /** Controller indices in the order they were first used, which is their slot order. */
  private order: number[] = [];
  /** Called when a controller is used for the first time. */
  onController: () => void = () => {};

  press(action: number): void {
    this.held.add(action);
    this.tapped.add(action);
  }

  release(action: number): void {
    this.held.delete(action);
  }

  releaseAll(): void {
    this.held.clear();
  }

  /** Each local player's buttons for one frame, by slot. */
  sample(): number[][] {
    const slots: Set<number>[] = [new Set([...this.held, ...this.tapped])];
    this.tapped.clear();
    const pads = new Map<number, Set<number>>();
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp || !gp.connected || !isController(gp)) continue;
      const acts = new Set<number>();
      readController(gp, acts);
      pads.set(gp.index, acts);
      if (acts.size && !this.order.includes(gp.index)) {
        this.order.push(gp.index);
        this.onController();
      }
    }
    this.order = this.order.filter((i) => pads.has(i));
    this.order.forEach((index, n) => {
      const slot = (slots[n] ??= new Set());
      for (const a of pads.get(index)!) slot.add(a);
    });
    return slots.map((s) => [...s]);
  }

  /** Puts back buttons whose frame did not run, so the next sample includes them. */
  retap(actions: number[]): void {
    for (const a of actions) this.tapped.add(a);
  }
}

function direction(x: number, y: number, out: Set<number>): void {
  if (x > STICK_DEADZONE) out.add(RIGHT);
  if (x < -STICK_DEADZONE) out.add(LEFT);
  if (y < -STICK_DEADZONE) out.add(UP);
  if (y > STICK_DEADZONE) out.add(DOWN);
}

/** Hat switch directions clockwise from up, for axis values -1, -5/7, ..., 1. About 1.29 means not pressed. */
const HAT: [number, number][] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

function readController(gp: Gamepad, out: Set<number>): void {
  for (const [b, a] of BUTTONS) if (gp.buttons[b]?.pressed) out.add(a);
  direction(gp.axes[0] ?? 0, gp.axes[1] ?? 0, out);
  if (gp.mapping === 'standard') return;
  // Without the standard layout, desktop browsers report a D-pad as one hat axis (axis 9) that steps
  // through eight values from -1 to 1. A value between the steps, such as a resting 0, is not a direction.
  const hat = gp.axes[9];
  if (hat === undefined) return;
  const step = ((hat + 1) * 7) / 2;
  const k = Math.round(step);
  if (k >= 0 && k <= 7 && Math.abs(step - k) < 0.15) direction(HAT[k][0], HAT[k][1], out);
}

/** The key names that press `actions` for a seat whose keys are `row` (from `seatKeys`). */
export function actionKeys(actions: number[], row: string[]): string[] {
  const out: string[] = [];
  for (const a of actions) if (row[a]) out.push(row[a]);
  return out;
}
