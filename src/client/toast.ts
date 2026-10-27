// A one-line message over the top of the stage, such as "Replay saved".

export class Toast {
  private el: HTMLDivElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(stage: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'toast';
    this.el.hidden = true;
    stage.append(this.el);
  }

  /** Shows a message for `ms` milliseconds, or until the next message when `ms` is 0. */
  show(text: string, ms = 2500): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.el.textContent !== text) this.el.textContent = text;
    this.el.hidden = false;
    if (ms > 0) this.timer = setTimeout(() => this.hide(), ms);
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.el.hidden = true;
  }
}
