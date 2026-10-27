// The question after a match: save a replay of it in this browser or not.
// The game goes on underneath, and the buttons never take keyboard focus.
import { clock, type FinishedReplay } from './replay.ts';
import { saveReplay } from './replay-store.ts';
import type { Toast } from './toast.ts';

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.tabIndex = -1;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', onClick);
  return b;
}

export class ReplayOffer {
  private el: HTMLDivElement;
  private text: HTMLParagraphElement;
  private pending: FinishedReplay | null = null;

  constructor(
    stage: HTMLElement,
    private toast: Toast,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'replay-offer';
    this.el.hidden = true;
    this.text = document.createElement('p');
    const actions = document.createElement('div');
    actions.className = 'replay-offer-actions';
    actions.append(
      button('Save replay', 'primary', () => void this.save()),
      button('No thanks', '', () => this.clear()),
    );
    this.el.append(this.text, actions);
    stage.append(this.el);
  }

  offer(r: FinishedReplay): void {
    this.pending = r;
    this.text.textContent = `Save a replay of ${r.meta.fighters.join(' vs ')} (${clock(r.meta.frames)})?`;
    this.el.hidden = false;
  }

  /** Drops the question, as when the next match starts. */
  clear(): void {
    this.pending = null;
    this.el.hidden = true;
  }

  private async save(): Promise<void> {
    const r = this.pending;
    this.clear();
    if (!r) return;
    try {
      await saveReplay(r);
      this.toast.show('Replay saved under Replays on the start screen.', 4000);
    } catch (e) {
      this.toast.show(`The replay could not be saved: ${e instanceof Error ? e.message : String(e)}`, 6000);
    }
  }
}
